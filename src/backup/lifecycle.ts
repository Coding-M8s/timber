import { lstat, readdir, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { safeDisplay, shellQuoteForDisplay } from "../display";
import { samePath } from "../platform/paths";
import { assertPrivateStorage } from "../platform/private-storage";
import type { CommandIO } from "../services";
import type { TerminalTextPrompt } from "../selection";
import type { RepositoryContext } from "../types";
import { backupGit } from "./git";
import {
  BackupRecordError, backupIdPattern, backupRef, backupsRoot, digest, formatBytes, readBackupAt, validateManifest,
  validateRecord, type BackupRecord, type PublishedBackup,
} from "./storage";

const deletingPrefix = ".deleting-";
const incompletePrefix = ".incomplete-";
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

function backupLines(backup: EligibleBackup): string[] {
  const { record } = backup;
  return [
    record.id,
    `  Branch: ${record.branch === null ? "detached HEAD" : safeDisplay(record.branch)}`,
    `  Created: ${record.createdAt}`,
    `  Size: ${formatBytes(record.bytes)}, ${record.entries} entries`,
    `  Source worktree: ${safeDisplay(record.worktreePath)}`,
    `  Protection: ${backup.protection.protected ? `protected, ${backup.protection.reason}` : "none"}`,
    // Version 1 records carry no retention policy; expiry belongs to #121.
    "  Expiry: none, no retention policy; kept until deleted",
  ];
}

const ignoredWarning = "Backups can contain copies of ignored files, including secrets such as .env, even after their source worktree is removed.";

/** `timber backup list`: read-only and safe to run anywhere. */
export async function listBackups(repository: RepositoryContext, io: CommandIO): Promise<number> {
  const { items } = await readInventory(repository);
  const backups = items.filter((item): item is EligibleBackup => item.kind === "backup");
  const unfinished = items.filter((item): item is UnfinishedDeletion => item.kind === "unfinished");
  const problems = items.filter((item): item is BackupProblem => item.kind === "problem");
  if (!items.length) {
    io.stdout("No recovery backups in this repository.\n");
    return 0;
  }
  const lines: string[] = [];
  const total = backups.reduce((sum, backup) => sum + backup.record.bytes, 0);
  lines.push(`Recovery backups: ${backups.length} (${formatBytes(total)})`);
  for (const backup of backups) lines.push(...backupLines(backup));
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
    "Delete with: timber backup done (one at a time) or timber backup done --all", "");
  io.stdout(lines.join("\n"));
  return 0;
}

type Outcome =
  | { kind: "deleted" }
  | { kind: "kept"; reason: string }
  | { kind: "partial"; message: string };

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

async function remainingState(directory: string, ref: string, gitCwd: string): Promise<string> {
  let files = "its directory state is unknown";
  try { files = `${(await readdir(directory)).length} files remain in ${safeDisplay(directory)}`; }
  catch (error) { if (code(error) === "ENOENT") files = "its directory was removed"; }
  const pinned = await backupGit(gitCwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => null);
  const refState = pinned === null || (pinned.exitCode ?? 2) > 1 ? "its private ref state is unknown"
    : pinned.exitCode === 0 ? `private ref ${ref} still exists` : "its private ref was removed";
  return `${refState}; ${files}`;
}

function partialMessage(id: string, directory: string, state: string): string {
  return [
    `Backup ${id} was only partly deleted: ${state}.`,
    "It is no longer restorable. Run timber backup done again to finish deleting it, or remove it manually:",
    `  rm -r -- ${shellQuoteForDisplay(directory)}`,
  ].join("\n");
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
    catch { return { kind: "partial", message: partialMessage(id, deleting, `${reason}, and it could not be renamed back; ${await remainingState(deleting, record.ref, gitCwd)}`) }; }
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
  catch { return { kind: "partial", message: partialMessage(id, deleting, await remainingState(deleting, record.ref, gitCwd)) }; }
  return { kind: "deleted" };
}

interface UnfinishedPlan {
  names: string[];
  record: BackupRecord | null;
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
  let allowed = new Set<string>();
  if (present.has("record.json")) {
    const recordText = await readPrivateText(join(item.directory, "record.json"));
    record = validateRecord(JSON.parse(recordText), item.id);
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
  return { names: order, record, device: info.dev, inode: info.ino };
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
    || JSON.stringify(fresh.record) !== JSON.stringify(plan.record)) {
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
  catch { return { kind: "partial", message: partialMessage(item.id, item.directory, await remainingState(item.directory, ref, gitCwd)) }; }
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
  repository: RepositoryContext, options: BackupDoneOptions, io: CommandIO, ask: TerminalTextPrompt | undefined,
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
      if ("kind" in target) io.stdout(backupLines(target).join("\n") + "\n");
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

/** For `timber done`: IDs of valid backups recorded from the removed worktree. Read-only. */
export async function retainedBackups(repository: RepositoryContext, worktreePath: string): Promise<string[]> {
  const { items } = await readInventory(repository);
  return items.flatMap(item => item.kind === "backup" && samePath(item.record.worktreePath, worktreePath) ? [item.id] : []);
}
