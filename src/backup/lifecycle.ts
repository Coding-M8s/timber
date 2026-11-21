import { randomBytes } from "node:crypto";
import { lstat, readdir, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { FormattedError, safeDiagnostic, safeDisplay, shellQuoteForDisplay } from "../display";
import { samePath } from "../platform/paths";
import { assertPrivateStorage } from "../platform/private-storage";
import type { CommandIO } from "../services";
import type { TerminalTextPrompt } from "../selection";
import type { RepositoryContext } from "../types";
import { backupGit } from "./git";
import { describeRetention, isExpired, retentionOf, type Retention } from "./retention";
import {
  BackupRecordError, backupIdPattern, backupRef, backupsRoot, digest, formatBytes, readBackupAt, readPrivateBytes, validateManifest,
  validateRecord, writePrivateFile, type BackupRecord, type PublishedBackup,
} from "./storage";

const deletingPrefix = ".deleting-";
const incompletePrefix = ".incomplete-";
const retainPrefix = ".retain-";
const blobPattern = /^\d{6,}$/u;

export type Protection = { protected: false } | { protected: true; reason: string };

export interface EligibleBackup extends PublishedBackup {
  kind: "backup";
  id: string;
  protection: Protection;
}

/** A `.deleting-<id>` directory left by an interrupted or failed deletion. */
export interface UnfinishedDeletion {
  kind: "unfinished";
  id: string;
  directory: string;
}

/** Anything Timber found but cannot use; never deletion authorization. */
export interface BackupProblem {
  kind: "problem";
  name: string;
  reason: string;
}

export type BackupItem = EligibleBackup | UnfinishedDeletion | BackupProblem;

export interface BackupInventory {
  commonGitDir: string;
  root: string;
  items: BackupItem[];
}

interface RebaseState {
  admin: string;
  /** Null for a detached rebase; undefined when the rebased branch cannot be identified. */
  branch: string | null | undefined;
}

interface RebaseScan {
  uncertain: boolean;
  rebases: RebaseState[];
}

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Every per-worktree Git admin directory, including stale ones Git has not pruned. */
async function scanRebases(commonGitDir: string): Promise<RebaseScan> {
  const admins = [commonGitDir];
  let uncertain = false;
  try {
    for (const name of await readdir(join(commonGitDir, "worktrees"))) {
      const path = join(commonGitDir, "worktrees", name);
      try {
        const info = await lstat(path);
        if (info.isDirectory()) admins.push(path);
        else if (info.isSymbolicLink()) uncertain = true;
      } catch (error) { if (code(error) !== "ENOENT") uncertain = true; }
    }
  } catch (error) { if (code(error) !== "ENOENT") uncertain = true; }
  const rebases: RebaseState[] = [];
  for (const admin of admins) {
    for (const marker of ["rebase-merge", "rebase-apply"]) {
      try { await lstat(join(admin, marker)); }
      catch (error) {
        if (code(error) !== "ENOENT") rebases.push({ admin, branch: undefined });
        continue;
      }
      let branch: string | null | undefined;
      try {
        const name = (await readFile(join(admin, marker, "head-name"), "utf8")).replace(/\n$/u, "");
        branch = name.startsWith("refs/heads/") && name.length > 11 ? name.slice(11) : name === "detached HEAD" ? null : undefined;
      } catch { branch = undefined; }
      rebases.push({ admin, branch });
    }
  }
  return { uncertain, rebases };
}

/** Map the recorded source admin directory into this common Git directory, so moved repositories still match. */
function sourceAdmin(record: BackupRecord, commonGitDir: string): string | null {
  if (record.worktreeGitDir === record.commonGitDir) return commonGitDir;
  const parts = relative(record.commonGitDir, record.worktreeGitDir).split(sep);
  if (parts.length !== 2 || parts[0] !== "worktrees" || !parts[1] || parts[1] === "." || parts[1] === "..") return null;
  return join(commonGitDir, "worktrees", parts[1]);
}

/** Active rebases and anything Timber cannot inspect protect a backup; absence of evidence is not proof of safety. */
function protectionFor(record: BackupRecord, scan: RebaseScan, commonGitDir: string): Protection {
  if (scan.uncertain) return { protected: true, reason: "rebase state in this repository cannot be inspected (uncertain rebase)" };
  const admin = sourceAdmin(record, commonGitDir);
  if (admin === null) return { protected: true, reason: "the source worktree cannot be identified (uncertain rebase)" };
  for (const rebase of scan.rebases) {
    if (rebase.branch === undefined) return { protected: true, reason: "a rebase whose branch cannot be identified is in progress (uncertain rebase)" };
    if (samePath(rebase.admin, admin)) return { protected: true, reason: "its source worktree has a rebase in progress" };
    if (record.branch !== null && rebase.branch === record.branch) {
      return { protected: true, reason: `branch ${safeDisplay(record.branch)} has a rebase in progress` };
    }
  }
  return { protected: false };
}

async function liveProtection(record: BackupRecord, commonGitDir: string): Promise<Protection> {
  return protectionFor(record, await scanRebases(commonGitDir), commonGitDir);
}

function expectedNames(backup: Pick<PublishedBackup, "manifest">): Set<string> {
  return new Set(["record.json", "manifest.json",
    ...backup.manifest.flatMap(entry => entry.type === "file" ? [entry.blob] : [])]);
}

/** Exactly the record, manifest and listed blobs; anything else makes the backup ineligible. */
async function assertExactContents(backup: PublishedBackup): Promise<void> {
  const expected = expectedNames(backup);
  const names = await readdir(backup.directory);
  if (names.length !== expected.size || names.some(name => !expected.has(name))) {
    throw new BackupRecordError("Backup directory has missing or unexpected files; it cannot be used.");
  }
}

async function readRefs(gitCwd: string): Promise<Map<string, string>> {
  const result = await backupGit(gitCwd, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/timber/backups/"]);
  if (result.exitCode !== 0) throw new Error("Git could not list private backup refs; nothing was changed.");
  const refs = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [name, object] = line.split("\0");
    refs.set(name!, object ?? "");
  }
  return refs;
}

async function assertPrivateRoot(commonGitDir: string): Promise<boolean> {
  try {
    await assertPrivateStorage(join(commonGitDir, "timber"), await lstat(join(commonGitDir, "timber")), true);
    await assertPrivateStorage(backupsRoot(commonGitDir), await lstat(backupsRoot(commonGitDir)), true);
    return true;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw new Error("Backup storage is not a private directory; inspect it before retrying. Nothing was changed.");
  }
}

/** Read everything under the backup root and refs namespace; validation failures become problems, never deletions. */
export async function readInventory(repository: RepositoryContext): Promise<BackupInventory> {
  const commonGitDir = await realpath(repository.commonGitDir);
  const root = backupsRoot(commonGitDir);
  const refs = await readRefs(repository.primaryWorktreeRoot);
  const items: BackupItem[] = [];
  const directoryIds = new Set<string>();
  const names = await assertPrivateRoot(commonGitDir) ? (await readdir(root)).sort() : [];
  const scan = await scanRebases(commonGitDir);
  for (const name of names) {
    if (name.startsWith(deletingPrefix) && backupIdPattern.test(name.slice(deletingPrefix.length))) {
      const id = name.slice(deletingPrefix.length);
      directoryIds.add(id);
      items.push({ kind: "unfinished", id, directory: join(root, name) });
      continue;
    }
    if (name.startsWith(incompletePrefix) && backupIdPattern.test(name.slice(incompletePrefix.length))) {
      directoryIds.add(name.slice(incompletePrefix.length));
      items.push({ kind: "problem", name, reason: "incomplete creation left by an interrupted backup; not a usable backup" });
      continue;
    }
    if (name.startsWith(retainPrefix)) {
      items.push({ kind: "problem", name, reason: "temporary record left by an interrupted keep or unkeep; inspect and remove it manually" });
      continue;
    }
    if (!backupIdPattern.test(name)) {
      items.push({ kind: "problem", name, reason: "unrecognized entry in backup storage" });
      continue;
    }
    directoryIds.add(name);
    try {
      const backup = await readBackupAt(join(root, name), name);
      await assertExactContents(backup);
      if (refs.get(backup.record.ref) !== backup.record.commit) {
        throw new BackupRecordError("The backup's private Git ref is missing or no longer names its commit; it cannot be used.");
      }
      items.push({ kind: "backup", id: name, ...backup, protection: protectionFor(backup.record, scan, commonGitDir) });
    } catch (error) {
      items.push({ kind: "problem", name, reason: error instanceof BackupRecordError ? error.message : "Backup cannot be read." });
    }
  }
  for (const ref of [...refs.keys()].sort()) {
    const id = ref.startsWith("refs/timber/backups/") ? ref.slice("refs/timber/backups/".length) : "";
    if (!backupIdPattern.test(id)) items.push({ kind: "problem", name: ref, reason: "unrecognized private backup ref" });
    else if (!directoryIds.has(id)) items.push({ kind: "problem", name: ref, reason: "private backup ref without a backup directory" });
  }
  return { commonGitDir, root, items };
}

function backupLines(backup: EligibleBackup, now: Date): string[] {
  const { record } = backup;
  return [
    record.id,
    `  Branch: ${record.branch === null ? "detached HEAD" : safeDisplay(record.branch)}`,
    `  Created: ${record.createdAt}`,
    `  Size: ${formatBytes(record.bytes)}, ${record.entries} entries`,
    `  Source worktree: ${safeDisplay(record.worktreePath)}`,
    `  Protection: ${backup.protection.protected ? `protected, ${backup.protection.reason}` : "none"}`,
    // Version 1 records carry no retention policy and keep their original line.
    record.version === 1 ? "  Expiry: none, no retention policy; kept until deleted"
      : `  Retention: ${describeRetention(record, now, backup.protection.protected)}`,
  ];
}

const ignoredWarning = "Backups can contain copies of ignored files, including secrets such as .env, even after their source worktree is removed.";

interface BackupListing {
  backups: EligibleBackup[];
  unfinished: UnfinishedDeletion[];
  problems: BackupProblem[];
  total: number;
}

/** One partition shared by the text and JSON lists, so they can never disagree. */
function partitionInventory(items: readonly BackupItem[]): BackupListing {
  const backups = items.filter((item): item is EligibleBackup => item.kind === "backup");
  return {
    backups,
    unfinished: items.filter((item): item is UnfinishedDeletion => item.kind === "unfinished"),
    problems: items.filter((item): item is BackupProblem => item.kind === "problem"),
    total: backups.reduce((sum, backup) => sum + backup.record.bytes, 0),
  };
}

/** `timber backup list`: read-only and safe to run anywhere. */
export async function listBackups(repository: RepositoryContext, io: CommandIO, now: Date = new Date()): Promise<number> {
  const { items } = await readInventory(repository);
  const { backups, unfinished, problems, total } = partitionInventory(items);
  if (!items.length) {
    io.stdout("No recovery backups in this repository.\n");
    return 0;
  }
  const lines: string[] = [];
  lines.push(`Recovery backups: ${backups.length} (${formatBytes(total)})`);
  for (const backup of backups) lines.push(...backupLines(backup, now));
  if (unfinished.length) {
    lines.push("Unfinished deletions (finish with timber backup done):");
    for (const item of unfinished) lines.push(`  ${item.id}: deletion did not complete; ${safeDisplay(item.directory)} remains`);
  }
  if (problems.length) {
    lines.push("Not usable (timber backup done will not delete these; inspect them manually):");
    for (const problem of problems) lines.push(`  ${safeDisplay(problem.name)}: ${problem.reason}`);
  }
  lines.push(ignoredWarning,
    "Restore with: timber backup restore <id> <new-directory>",
    "Delete with: timber backup done (one at a time) or timber backup done --all",
    "Expired backups that are not protected are deleted by timber backup create or timber backup cleanup.",
    "Keep one past its expiry with: timber backup keep <id> (undo with timber backup unkeep <id>)", "");
  io.stdout(lines.join("\n"));
  return 0;
}

export interface BackupListEntry {
  id: string;
  /** Null when the source worktree had a detached HEAD. */
  branch: string | null;
  commit: string;
  createdAt: string;
  bytes: number;
  entries: number;
  worktreePath: string;
  /** Lowercase hex SHA-256 of the exact record.json bytes; pass it to `__app-backup delete`. */
  recordSha256: string;
  protection: { protected: false; reason: null } | { protected: true; reason: string };
  /** Null for version 1 records, which carry no retention policy; state is evaluated when listed. */
  expiry: Retention | null;
}

/** `timber backup list --json`, schema version 1. Holds only record facts, never snapshot names or contents. */
export interface BackupListRecord {
  schemaVersion: 1;
  outcome: "succeeded" | "failed";
  exitCode: 0 | 1;
  repository: { commonGitDir: string; primaryWorktreeRoot: string; currentWorktreeRoot: string } | null;
  diagnostic: string | null;
  backups: BackupListEntry[];
  /** `recordSha256` is null once record.json is gone or the remains cannot be read. */
  unfinished: { id: string; directory: string; recordSha256: string | null }[];
  notUsable: { name: string; reason: string }[];
  totalBytes: number;
}

/**
 * Read-only JSON form of `timber backup list`. Discovery and storage failures
 * become a failed record instead of a thrown error, so stdout always holds one record.
 */
export async function readBackupList(
  cwd: string, discover: (cwd: string) => Promise<RepositoryContext>, now: Date = new Date(),
): Promise<BackupListRecord> {
  const record: BackupListRecord = { schemaVersion: 1, outcome: "succeeded", exitCode: 0, repository: null,
    diagnostic: null, backups: [], unfinished: [], notUsable: [], totalBytes: 0 };
  let inventory: BackupInventory;
  try {
    const repository = await discover(cwd);
    record.repository = { commonGitDir: await realpath(repository.commonGitDir),
      primaryWorktreeRoot: repository.primaryWorktreeRoot, currentWorktreeRoot: repository.currentWorktreeRoot };
    inventory = await readInventory(repository);
  } catch (error) {
    record.outcome = "failed";
    record.exitCode = 1;
    record.diagnostic = safeDiagnostic(error instanceof Error && error.message ? error.message : "Cannot read recovery backups.");
    return record;
  }
  const { backups, unfinished, problems, total } = partitionInventory(inventory.items);
  record.backups = backups.map(({ id, record: saved, recordSha256, protection }) => ({
    id, branch: saved.branch, commit: saved.commit, createdAt: saved.createdAt, bytes: saved.bytes,
    entries: saved.entries, worktreePath: saved.worktreePath, recordSha256,
    protection: protection.protected ? { protected: true, reason: protection.reason } : { protected: false, reason: null },
    expiry: retentionOf(saved, now),
  }));
  // The same read `__app-backup delete` repeats before finishing; it only reads.
  record.unfinished = await Promise.all(unfinished.map(async item => ({ id: item.id, directory: item.directory,
    recordSha256: await planUnfinished(item).then(plan => plan.recordSha256, () => null) })));
  record.notUsable = problems.map(({ name, reason }) => ({ name, reason }));
  record.totalBytes = total;
  return record;
}

/** What a failed deletion actually left behind, observed after the failure. */
export interface RemainingDeletion {
  /** The `.deleting-<id>` (or, if it could not be renamed back, still that) directory. */
  directory: string;
  directoryState: "present" | "removed" | "unknown";
  /** Entries left in the directory; null unless it is present and readable. */
  files: number | null;
  ref: string;
  refState: "present" | "removed" | "unknown";
}

type Outcome =
  | { kind: "deleted" }
  | { kind: "kept"; reason: string }
  | { kind: "partial"; message: string; remaining: RemainingDeletion };

async function sameDirectory(directory: string, device: number, inode: number): Promise<boolean> {
  try {
    const info = await lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink() && info.dev === device && info.ino === inode;
  } catch { return false; }
}

/** Remove only named regular files inside a directory that keeps its identity; never recurse or follow links. */
async function removeNamed(directory: string, device: number, inode: number, names: readonly string[]): Promise<void> {
  for (const name of names) {
    if (!await sameDirectory(directory, device, inode)) throw new Error("directory changed");
    const path = join(directory, name);
    let info;
    try { info = await lstat(path); }
    catch (error) { if (code(error) === "ENOENT") continue; throw error; }
    if (!info.isFile()) throw new Error("unexpected entry");
    await unlink(path);
  }
  if (!await sameDirectory(directory, device, inode)) throw new Error("directory changed");
  await rmdir(directory);
}

async function remainingState(directory: string, ref: string, gitCwd: string): Promise<RemainingDeletion> {
  let directoryState: RemainingDeletion["directoryState"] = "unknown";
  let files: number | null = null;
  try { files = (await readdir(directory)).length; directoryState = "present"; }
  catch (error) { if (code(error) === "ENOENT") directoryState = "removed"; }
  const pinned = await backupGit(gitCwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => null);
  const refState = pinned === null || (pinned.exitCode ?? 2) > 1 ? "unknown" : pinned.exitCode === 0 ? "present" : "removed";
  return { directory, directoryState, files, ref, refState };
}

function describeRemaining(state: RemainingDeletion): string {
  const ref = state.refState === "unknown" ? "its private ref state is unknown"
    : state.refState === "present" ? `private ref ${state.ref} still exists` : "its private ref was removed";
  const files = state.directoryState === "present" ? `${state.files} files remain in ${safeDisplay(state.directory)}`
    : state.directoryState === "removed" ? "its directory was removed" : "its directory state is unknown";
  return `${ref}; ${files}`;
}

/** The manual command printed for a partial deletion, shared by the text and the app record. */
function manualRemoval(directory: string): string {
  return `rm -r -- ${shellQuoteForDisplay(directory)}`;
}

function partial(id: string, directory: string, remaining: RemainingDeletion, prefix = ""): Outcome {
  return { kind: "partial", remaining, message: [
    `Backup ${id} was only partly deleted: ${prefix}${describeRemaining(remaining)}.`,
    "It is no longer restorable. Run timber backup done again to finish deleting it, or remove it manually:",
    `  ${manualRemoval(directory)}`,
  ].join("\n") };
}

/** Revalidate exact identity and protection, then rename, drop the ref conditionally, and remove only known files. */
async function deleteBackup(selected: EligibleBackup, inventory: BackupInventory, gitCwd: string): Promise<Outcome> {
  const { id, record } = selected;
  const published = join(inventory.root, id);
  const deleting = join(inventory.root, deletingPrefix + id);
  const changed: Outcome = { kind: "kept", reason: "it changed after it was selected" };
  let fresh: PublishedBackup;
  try {
    if (!await assertPrivateRoot(inventory.commonGitDir)) return changed;
    fresh = await readBackupAt(published, id);
    await assertExactContents(fresh);
  } catch { return changed; }
  if (fresh.recordSha256 !== selected.recordSha256 || fresh.device !== selected.device || fresh.inode !== selected.inode) return changed;
  const pinned = await backupGit(gitCwd, ["rev-parse", "--verify", "--quiet", `${record.ref}^{commit}`]);
  if (pinned.exitCode !== 0 || pinned.stdout !== record.commit) return changed;
  const protection = await liveProtection(record, inventory.commonGitDir);
  if (protection.protected) return { kind: "kept", reason: `it is now protected: ${protection.reason}` };
  try { await lstat(deleting); return { kind: "kept", reason: `${safeDisplay(deleting)} already exists` }; }
  catch (error) { if (code(error) !== "ENOENT") return { kind: "kept", reason: "its deletion directory cannot be checked" }; }

  // The rename marks deletion intent; until the ref is gone it can be undone.
  try { await rename(published, deleting); }
  catch { return { kind: "kept", reason: "its directory could not be renamed for deletion" }; }
  const restore = async (reason: string): Promise<Outcome> => {
    try { await rename(deleting, published); return { kind: "kept", reason }; }
    catch { return partial(id, deleting, await remainingState(deleting, record.ref, gitCwd), `${reason}, and it could not be renamed back; `); }
  };
  let moved: PublishedBackup;
  try { moved = await readBackupAt(deleting, id); }
  catch { return restore("it changed while it was being deleted"); }
  if (moved.recordSha256 !== selected.recordSha256 || moved.device !== selected.device || moved.inode !== selected.inode) {
    return restore("it changed while it was being deleted");
  }
  // Recheck exact contents while the ref still exists, so an added file keeps the backup instead of leaving a partial deletion.
  try { await assertExactContents(moved); }
  catch { return restore("it changed while it was being deleted"); }
  const recheck = await liveProtection(record, inventory.commonGitDir);
  if (recheck.protected) return restore(`it became protected: ${recheck.reason}`);
  const dropped = await backupGit(gitCwd, ["update-ref", "-m", "timber backup done", "-d", record.ref, record.commit]);
  if (dropped.exitCode !== 0) return restore("its private ref changed");

  const blobs = moved.manifest.flatMap(entry => entry.type === "file" ? [entry.blob] : []);
  try { await removeNamed(deleting, moved.device, moved.inode, [...blobs, "manifest.json", "record.json"]); }
  catch { return partial(id, deleting, await remainingState(deleting, record.ref, gitCwd)); }
  return { kind: "deleted" };
}

interface UnfinishedPlan {
  names: string[];
  record: BackupRecord | null;
  /** Digest of the exact remaining record bytes; null once record.json is gone. */
  recordSha256: string | null;
  device: number;
  inode: number;
}

/** Finish only states Timber's own deletion order can leave: blobs first, then manifest, then record. */
async function planUnfinished(item: UnfinishedDeletion): Promise<UnfinishedPlan> {
  const unsafe = new BackupRecordError("Unfinished deletion has unexpected contents; inspect and remove it manually.");
  const info = await lstat(item.directory);
  await assertPrivateStorage(item.directory, info, true);
  const names = await readdir(item.directory);
  const present = new Set(names);
  let record: BackupRecord | null = null;
  let recordSha256: string | null = null;
  let allowed = new Set<string>();
  if (present.has("record.json")) {
    const recordBytes = await readPrivateBytes(join(item.directory, "record.json"));
    record = validateRecord(JSON.parse(recordBytes.toString("utf8")), item.id);
    recordSha256 = digest(recordBytes);
    allowed.add("record.json");
    if (present.has("manifest.json")) {
      const manifestText = await readPrivateText(join(item.directory, "manifest.json"));
      if (digest(manifestText) !== record.manifestSha256) throw unsafe;
      const manifest = validateManifest(JSON.parse(manifestText));
      allowed = expectedNames({ manifest });
    }
  } else if (present.size) {
    throw unsafe;
  }
  if (names.some(name => !allowed.has(name) || (name !== "record.json" && name !== "manifest.json" && !blobPattern.test(name)))) throw unsafe;
  const order = [...names.filter(name => blobPattern.test(name)), ...names.filter(name => name === "manifest.json"),
    ...names.filter(name => name === "record.json")];
  return { names: order, record, recordSha256, device: info.dev, inode: info.ino };
}

async function readPrivateText(path: string): Promise<string> {
  await assertPrivateStorage(path, await lstat(path), false);
  return readFile(path, "utf8");
}

async function finishUnfinished(item: UnfinishedDeletion, plan: UnfinishedPlan, inventory: BackupInventory, gitCwd: string): Promise<Outcome> {
  let fresh: UnfinishedPlan;
  try { fresh = await planUnfinished(item); }
  catch { return { kind: "kept", reason: "it changed after it was selected" }; }
  if (fresh.device !== plan.device || fresh.inode !== plan.inode || fresh.names.join("/") !== plan.names.join("/")
    || fresh.recordSha256 !== plan.recordSha256 || JSON.stringify(fresh.record) !== JSON.stringify(plan.record)) {
    return { kind: "kept", reason: "it changed after it was selected" };
  }
  const ref = backupRef(item.id);
  const pinned = await backupGit(gitCwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if ((pinned.exitCode ?? 2) > 1) return { kind: "kept", reason: "its private ref cannot be checked" };
  if (pinned.exitCode === 0) {
    if (fresh.record === null || pinned.stdout !== fresh.record.commit) {
      return { kind: "kept", reason: "its private ref does not match a readable record; inspect it manually" };
    }
    const protection = await liveProtection(fresh.record, inventory.commonGitDir);
    if (protection.protected) return { kind: "kept", reason: `it is protected: ${protection.reason}` };
    const dropped = await backupGit(gitCwd, ["update-ref", "-m", "timber backup done", "-d", ref, fresh.record.commit]);
    if (dropped.exitCode !== 0) return { kind: "kept", reason: "its private ref changed" };
  }
  try { await removeNamed(item.directory, fresh.device, fresh.inode, fresh.names); }
  catch { return partial(item.id, item.directory, await remainingState(item.directory, ref, gitCwd)); }
  return { kind: "deleted" };
}

export interface BackupDoneOptions {
  all: boolean;
}

const nonInteractive = "Deleting backups requires an interactive terminal; nothing was deleted. Review them with timber backup list.";

function confirmed(answer: string | null): boolean {
  return answer === "y" || answer === "Y";
}

/** `timber backup done [--all]`: selection is never confirmation, and only `y` then Enter deletes. */
export async function reviewBackupDeletion(
  repository: RepositoryContext, options: BackupDoneOptions, io: CommandIO, ask: TerminalTextPrompt | undefined, now: Date = new Date(),
): Promise<number> {
  if (!ask) throw new Error(nonInteractive);
  const inventory = await readInventory(repository);
  const gitCwd = repository.primaryWorktreeRoot;
  const backups = inventory.items.filter((item): item is EligibleBackup => item.kind === "backup");
  const eligible = backups.filter(backup => !backup.protection.protected);
  const protectedBackups = backups.filter(backup => backup.protection.protected);
  const unfinished: { item: UnfinishedDeletion; plan: UnfinishedPlan }[] = [];
  const problems = inventory.items.filter((item): item is BackupProblem => item.kind === "problem");
  for (const item of inventory.items) {
    if (item.kind !== "unfinished") continue;
    try { unfinished.push({ item, plan: await planUnfinished(item) }); }
    catch { problems.push({ kind: "problem", name: deletingPrefix + item.id, reason: "unfinished deletion with unexpected contents; inspect it manually" }); }
  }
  const lines: string[] = [];
  for (const backup of protectedBackups) lines.push(`Protected, not offered: ${backup.id} (${backup.protection.protected ? backup.protection.reason : ""})`);
  for (const problem of problems) lines.push(`Not usable, not offered: ${safeDisplay(problem.name)} (${problem.reason})`);
  if (lines.length) io.stdout(lines.join("\n") + "\n");
  if (!eligible.length && !unfinished.length) {
    io.stdout("No backups are eligible for deletion; nothing was deleted.\n");
    return 0;
  }

  const results: { id: string; outcome: Outcome }[] = [];
  const run = async (target: EligibleBackup | { item: UnfinishedDeletion; plan: UnfinishedPlan }) => {
    const outcome = "kind" in target
      ? await deleteBackup(target, inventory, gitCwd)
      : await finishUnfinished(target.item, target.plan, inventory, gitCwd);
    const id = "kind" in target ? target.id : target.item.id;
    results.push({ id, outcome });
    if (outcome.kind === "deleted") io.stdout(`Deleted backup ${id}\n`);
    else if (outcome.kind === "kept") io.stderr(`Kept backup ${id}: ${outcome.reason}. Nothing was deleted for it.\n`);
    else io.stderr(`${outcome.message}\n`);
  };

  if (options.all) {
    const total = eligible.reduce((sum, backup) => sum + backup.record.bytes, 0);
    const count = eligible.length + unfinished.length;
    // Unfinished deletions have no reliable remaining size, so the total covers usable backups only.
    const size = unfinished.length
      ? `${formatBytes(total)} plus ${unfinished.length} unfinished deletion${unfinished.length === 1 ? "" : "s"}`
      : formatBytes(total);
    const summary = [`Selected ${count} eligible backup${count === 1 ? "" : "s"} (${size}):`,
      ...eligible.map(backup => `  ${backup.id} ${backup.record.branch === null ? "detached HEAD" : safeDisplay(backup.record.branch)} ${formatBytes(backup.record.bytes)}`),
      ...unfinished.map(({ item }) => `  ${item.id} unfinished deletion`), ignoredWarning, ""];
    io.stdout(summary.join("\n"));
    const answer = await ask(`Delete all ${count} backup${count === 1 ? "" : "s"} (${size})? Type y and press Enter to delete [y/N] `);
    if (!confirmed(answer)) {
      io.stdout("Cancelled; no backups were deleted.\n");
      return 0;
    }
    for (const backup of eligible) await run(backup);
    for (const target of unfinished) await run(target);
  } else {
    let cancelled = false;
    const targets: (EligibleBackup | { item: UnfinishedDeletion; plan: UnfinishedPlan })[] = [...eligible, ...unfinished];
    for (const target of targets) {
      if ("kind" in target) io.stdout(backupLines(target, now).join("\n") + "\n");
      else io.stdout(`${target.item.id}\n  Unfinished deletion: ${safeDisplay(target.item.directory)} remains; it is not restorable\n`);
      const id = "kind" in target ? target.id : target.item.id;
      const answer = await ask(`Delete backup ${id}? Type y and press Enter to delete [y/N] `);
      if (answer === null) { cancelled = true; break; }
      if (!confirmed(answer)) { io.stdout(`Kept backup ${id}\n`); continue; }
      await run(target);
    }
    if (cancelled) io.stdout("Cancelled; remaining backups were kept.\n");
  }
  const deleted = results.filter(result => result.outcome.kind === "deleted").length;
  const failed = results.filter(result => result.outcome.kind !== "deleted").length;
  io.stdout(`Deleted ${deleted} backup${deleted === 1 ? "" : "s"}${failed ? `; ${failed} not fully deleted` : ""}.\n`);
  return failed ? 1 : 0;
}

export type BackupDeleteResult = "deleted" | "refused" | "partial";

/** Observed facts for the app record of one confirmed deletion; filled in as each one is known. */
export interface BackupDeleteReport {
  result: BackupDeleteResult;
  /** The requested ID once it is a well-formed backup ID; raw input is never echoed. */
  id: string | null;
  /** Present only for a partial deletion. */
  remaining: RemainingDeletion | null;
  /** Manual commands that finish a partial deletion; a later run can also finish it. */
  cleanup: string[];
}

/** Until a deletion proves otherwise, a stop is a refusal that changed nothing. */
export function createBackupDeleteReport(): BackupDeleteReport {
  return { result: "refused", id: null, remaining: null, cleanup: [] };
}

const sha256Pattern = /^[0-9a-f]{64}$/u;

/**
 * `timber __app-backup delete`: delete one backup the person confirmed in an app.
 * The confirmation is bound to the exact record bytes the app showed; every check
 * `backup done` runs immediately before deletion still runs, and any difference keeps the backup.
 */
export async function deleteConfirmedBackup(
  repository: RepositoryContext, id: string, recordSha256: string, io: CommandIO,
  report: BackupDeleteReport = createBackupDeleteReport(),
): Promise<number> {
  if (!backupIdPattern.test(id)) throw new Error("Invalid backup ID; use an ID from the backup list. Nothing was deleted.");
  report.id = id;
  if (!sha256Pattern.test(recordSha256)) {
    throw new Error("Invalid record digest; use the lowercase hex SHA-256 from the backup list. Nothing was deleted.");
  }
  const inventory = await readInventory(repository);
  const gitCwd = repository.primaryWorktreeRoot;
  const names = new Set([id, deletingPrefix + id, incompletePrefix + id, backupRef(id)]);
  const related = inventory.items.filter(item => item.kind === "problem" ? names.has(item.name) : item.id === id);
  const keep = (reason: string) => new Error(`Kept backup ${id}: ${reason}. Nothing was deleted.`);
  if (!related.length) throw keep("no backup with that ID exists in this repository");
  if (related.length > 1) throw keep("more than one entry in backup storage has that ID; inspect them with timber backup list");
  const item = related[0]!;
  let outcome: Outcome;
  if (item.kind === "problem") throw keep(`it is not usable: ${item.reason}`);
  if (item.kind === "backup") {
    if (item.protection.protected) throw keep(`it is protected: ${item.protection.reason}`);
    if (item.recordSha256 !== recordSha256) throw keep("its record differs from the one that was confirmed; review it again");
    try { outcome = await deleteBackup(item, inventory, gitCwd); }
    catch (error) {
      // A throw after the rename (for example Git failing to start) must not be reported as a refusal.
      const deleting = join(inventory.root, deletingPrefix + id);
      const renamed = await lstat(deleting).then(() => true, failure => code(failure) !== "ENOENT");
      if (!renamed) throw error;
      outcome = partial(id, deleting, await remainingState(deleting, item.record.ref, gitCwd));
    }
  } else {
    let plan: UnfinishedPlan;
    try { plan = await planUnfinished(item); }
    catch { throw keep("its unfinished deletion has unexpected contents; inspect it manually"); }
    // Without a record nothing restorable remains, so the `.deleting-<id>` name is the identity.
    if (plan.recordSha256 !== null && plan.recordSha256 !== recordSha256) {
      throw keep("its record differs from the one that was confirmed; review it again");
    }
    // A throw here stays a refusal: finishing changes nothing before its checks pass, and the
    // unfinished directory it leaves was already unfinished before this run.
    outcome = await finishUnfinished(item, plan, inventory, gitCwd);
  }
  if (outcome.kind === "kept") throw keep(outcome.reason);
  if (outcome.kind === "partial") {
    report.result = "partial";
    report.remaining = outcome.remaining;
    report.cleanup = [
      ...(outcome.remaining.refState === "removed" ? [] : [`git update-ref -d ${outcome.remaining.ref}`]),
      ...(outcome.remaining.directoryState === "removed" ? [] : [manualRemoval(outcome.remaining.directory)]),
    ];
    throw new FormattedError(outcome.message);
  }
  report.result = "deleted";
  io.stdout(`Deleted backup ${id}\n`);
  return 0;
}

export interface RetainedBackup {
  id: string;
  /** Size and retention, for example `1.2 MiB, expires <ISO time>`. */
  detail: string;
}

function shortRetention(record: BackupRecord, now: Date): string {
  const retention = retentionOf(record, now);
  if (retention === null) return "no retention policy";
  switch (retention.state) {
    case "kept": return "kept indefinitely";
    case "until-deleted": return "kept until deleted";
    case "not-started": return "retention starts when its rebase is seen to finish or be aborted";
    case "expiring": return `expires ${retention.expiresAt}`;
    case "expired": return `expired ${retention.expiresAt}`;
  }
}

/** For `timber done`: valid backups recorded from the removed worktree, with size and retention. Read-only. */
export async function retainedBackups(repository: RepositoryContext, worktreePath: string, now: Date = new Date()): Promise<RetainedBackup[]> {
  const { items } = await readInventory(repository);
  return items.flatMap(item => item.kind === "backup" && samePath(item.record.worktreePath, worktreePath)
    ? [{ id: item.id, detail: `${formatBytes(item.record.bytes)}, ${shortRetention(item.record, now)}` }] : []);
}

export interface CleanupSummary {
  deleted: number;
  deletedBytes: number;
  /** Expired backups that were kept: protected, changed after selection, or not removable. */
  kept: number;
  partial: number;
}

/**
 * Delete every usable, unprotected, expired backup through the confirmed-deletion path.
 * Reads no configuration: each record carries its own captured policy.
 */
export async function cleanupExpiredBackups(
  repository: RepositoryContext, io: CommandIO, now: Date = new Date(), options: { quietWhenNone?: boolean } = {},
): Promise<CleanupSummary> {
  await startRebaseRetention(repository, io, now);
  const inventory = await readInventory(repository);
  const gitCwd = repository.primaryWorktreeRoot;
  const summary: CleanupSummary = { deleted: 0, deletedBytes: 0, kept: 0, partial: 0 };
  const expired = inventory.items.filter((item): item is EligibleBackup => item.kind === "backup" && isExpired(item.record, now));
  const unfinished = inventory.items.filter(item => item.kind === "unfinished").length;
  const unfinishedNote = unfinished
    ? `${unfinished} unfinished deletion${unfinished === 1 ? "" : "s"} remain; finish with timber backup done.\n` : "";
  if (!expired.length) {
    if (!options.quietWhenNone) io.stdout(`No expired backups; nothing was deleted.\n${unfinishedNote}`);
    return summary;
  }
  for (const backup of expired) {
    const expiresAt = retentionOf(backup.record, now)?.expiresAt;
    if (backup.protection.protected) {
      summary.kept++;
      io.stdout(`Kept expired backup ${backup.id}: it is protected, ${backup.protection.reason}.\n`);
      continue;
    }
    let outcome: Outcome;
    try { outcome = await deleteBackup(backup, inventory, gitCwd); }
    catch {
      const deleting = join(inventory.root, deletingPrefix + backup.id);
      const renamed = await lstat(deleting).then(() => true, failure => code(failure) !== "ENOENT");
      outcome = renamed ? partial(backup.id, deleting, await remainingState(deleting, backup.record.ref, gitCwd))
        : { kind: "kept", reason: "it could not be checked" };
    }
    if (outcome.kind === "deleted") {
      summary.deleted++;
      summary.deletedBytes += backup.record.bytes;
      io.stdout(`Deleted expired backup ${backup.id} (${formatBytes(backup.record.bytes)}, expired ${expiresAt})\n`);
    } else if (outcome.kind === "kept") {
      summary.kept++;
      io.stderr(`Kept expired backup ${backup.id}: ${outcome.reason}. Nothing was deleted for it.\n`);
    } else {
      summary.partial++;
      io.stderr(`${outcome.message}\n`);
    }
  }
  io.stdout(`Deleted ${summary.deleted} expired backup${summary.deleted === 1 ? "" : "s"} (${formatBytes(summary.deletedBytes)})`
    + `${summary.kept ? `; kept ${summary.kept}` : ""}${summary.partial ? `; ${summary.partial} not fully deleted` : ""}.\n${unfinishedNote}`);
  return summary;
}

/** `timber backup cleanup`: no prompt and no terminal needed; nonzero only when a deletion was left partial. */
export async function cleanupBackups(repository: RepositoryContext, io: CommandIO, now: Date = new Date()): Promise<number> {
  const summary = await cleanupExpiredBackups(repository, io, now);
  return summary.partial ? 1 : 0;
}

/**
 * Replace one backup's record.json with `updated`. The new record is written beside the backup and
 * renamed over record.json only after the old bytes, directory identity, contents and ref are rechecked.
 * Returns why nothing changed, or null once replaced.
 */
async function rewriteRecord(
  repository: RepositoryContext, inventory: BackupInventory, item: EligibleBackup, updated: BackupRecord,
): Promise<string | null> {
  const { id, record } = item;
  const temporary = join(inventory.root, `${retainPrefix}${id}-${randomBytes(4).toString("hex")}`);
  try { await writePrivateFile(temporary, JSON.stringify(updated) + "\n"); }
  catch {
    await unlink(temporary).catch(() => {});
    return "its new record could not be written; check Git directory permissions and free space";
  }
  const discard = async (reason: string) => { await unlink(temporary).catch(() => {}); return reason; };
  let fresh: PublishedBackup;
  try {
    fresh = await readBackupAt(join(inventory.root, id), id);
    await assertExactContents(fresh);
  } catch { return discard("it changed after it was selected"); }
  if (fresh.recordSha256 !== item.recordSha256 || fresh.device !== item.device || fresh.inode !== item.inode) {
    return discard("it changed after it was selected");
  }
  const pinned = await backupGit(repository.primaryWorktreeRoot, ["rev-parse", "--verify", "--quiet", `${record.ref}^{commit}`]);
  if (pinned.exitCode !== 0 || pinned.stdout !== record.commit) return discard("its private ref changed");
  try { await rename(temporary, join(fresh.directory, "record.json")); }
  catch { return discard("its record could not be replaced"); }
  return null;
}

/** Git's own HEAD reflog messages when a rebase of `refs/heads/<branch>` finishes or is aborted. */
const rebaseOutcomeMessage = /^rebase(?: -i)? \((?:finish|abort)\): returning to refs\/heads\/(.+)$/u;
const reflogHeader = /^[0-9a-f]+ [0-9a-f]+ .* (\d+) [+-]\d{4}$/u;

/**
 * Positive evidence that the rebase a backup was made for has ended: a finish or abort entry for its
 * branch in the source worktree's HEAD reflog, no earlier than the backup. A missing or unreadable
 * reflog, or a rebase directory removed by hand, is not evidence.
 */
async function reflogShowsOutcome(admin: string, branch: string, createdAt: string): Promise<boolean> {
  const path = join(admin, "logs", "HEAD");
  let text: string;
  try {
    if (!(await lstat(path)).isFile()) return false;
    text = await readFile(path, "utf8");
  } catch { return false; }
  // Reflog times are whole seconds; the backup was made while the rebase was paused, so an outcome in that second follows it.
  const since = Math.floor(Date.parse(createdAt) / 1000);
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const time = reflogHeader.exec(line.slice(0, tab))?.[1];
    if (time === undefined || Number(time) < since) continue;
    if (rebaseOutcomeMessage.exec(line.slice(tab + 1))?.[1] === branch) return true;
  }
  return false;
}

/** The rebase whose end Timber itself just saw, during `timber rebase --resolve`. */
export interface ObservedRebase {
  /** The rebased worktree's Git admin directory. */
  gitDirectory: string;
  branch: string;
}

/**
 * Start retention for rebase-origin backups whose rebase is reliably over: Timber saw it end itself
 * (`observed`), or Git's HEAD reflog records its finish or abort. A backup that is protected (an active or
 * uncertain rebase) or lacks that evidence keeps waiting. Retention counts from `now`. Best effort: any
 * failure leaves the record unchanged, so its retention stays not started.
 */
export async function startRebaseRetention(
  repository: RepositoryContext, io: CommandIO, now: Date = new Date(), observed?: ObservedRebase,
): Promise<string[]> {
  const started: string[] = [];
  let inventory: BackupInventory;
  try { inventory = await readInventory(repository); } catch { return started; }
  let observedAdmin: string | null = null;
  if (observed) { try { observedAdmin = await realpath(observed.gitDirectory); } catch { /* Not evidence. */ } }
  for (const item of inventory.items) {
    if (item.kind !== "backup" || item.protection.protected) continue;
    const { record } = item;
    if (record.version !== 2 || record.origin !== "rebase" || record.retentionStartedAt !== null || record.branch === null) continue;
    const admin = sourceAdmin(record, inventory.commonGitDir);
    if (admin === null) continue;
    const seen = observedAdmin !== null && observed!.branch === record.branch && samePath(admin, observedAdmin);
    if (!seen && !await reflogShowsOutcome(admin, record.branch, record.createdAt)) continue;
    const updated: BackupRecord = { ...record, retentionStartedAt: now.toISOString() };
    let failure: string | null;
    try { failure = await rewriteRecord(repository, inventory, item, updated); } catch { failure = "it could not be checked"; }
    if (failure !== null) continue;
    started.push(item.id);
    io.stdout(`Retention started for backup ${item.id}: its rebase was seen to finish or be aborted. Retention: ${describeRetention(updated, now, false)}\n`);
  }
  return started;
}

/**
 * `timber backup keep|unkeep <id>`: rewrite only the record's `keep` flag. The new record is
 * written beside the backup and renamed over record.json after the old bytes and identity are rechecked.
 */
export async function setBackupKeep(
  repository: RepositoryContext, id: string, keep: boolean, io: CommandIO, now: Date = new Date(),
): Promise<number> {
  if (!backupIdPattern.test(id)) throw new Error("Invalid backup ID; use an ID from timber backup list. Nothing was changed.");
  const inventory = await readInventory(repository);
  const unchanged = (reason: string) => new Error(`Backup ${id} was not changed: ${reason}.`);
  const related = inventory.items.filter(item => item.kind === "problem" ? item.name === id || item.name === backupRef(id) : item.id === id);
  if (!related.length) throw unchanged("no backup with that ID exists in this repository");
  const item = related.find((candidate): candidate is EligibleBackup => candidate.kind === "backup");
  if (!item || related.length > 1) {
    const problem = related.find((candidate): candidate is BackupProblem => candidate.kind === "problem");
    throw unchanged(problem ? `it is not usable: ${problem.reason}` : "it is being deleted; finish with timber backup done");
  }
  const { record } = item;
  if (record.version === 1) throw unchanged("it has no retention policy and is already kept until deleted");
  if (record.keep === keep) {
    io.stdout(keep ? `Backup ${id} is already kept indefinitely.\n` : `Backup ${id} is not kept; its retention is unchanged: ${describeRetention(record, now, item.protection.protected)}\n`);
    return 0;
  }
  const updated: BackupRecord = { ...record, keep };
  const failure = await rewriteRecord(repository, inventory, item, updated);
  if (failure !== null) throw unchanged(failure);
  io.stdout(keep
    ? `Backup ${id} is kept indefinitely; automatic cleanup will not delete it. Undo with timber backup unkeep ${id}.\n`
    : `Backup ${id} is no longer kept. Retention: ${describeRetention(updated, now, item.protection.protected)}\n`);
  return 0;
}
