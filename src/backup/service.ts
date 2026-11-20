import { rmSync } from "node:fs";
import { lstat, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execaSync } from "execa";
import { backupGit as git, backupGitEnvironment as environment, disabledHooks } from "./git";
import { FormattedError, safeDisplay, shellQuoteForDisplay } from "../display";
import { gitOperation } from "../git/operations";
import { assertWorktreeIdentity, listWorktreeInventory } from "../git/worktrees";
import { samePath } from "../platform/paths";
import type { CommandIO } from "../services";
import type { TerminalTextPrompt } from "../selection";
import { cleanupExpiredBackups, readInventory, reviewBackupDeletion } from "./lifecycle";
import { describeRetention, isExpired, type BackupSettings } from "./retention";
import type { RepositoryContext, Worktree, WorktreeInventory } from "../types";
import {
  assertStorageSpace, copySnapshot, restoreSnapshot, sameListing, SnapshotError, snapshotBytes, verifyBlobs, walkWorktree,
} from "./snapshot";
import {
  BackupRecordError, backupIdPattern, backupRef, createPrivateDirectory, digest, ensureBackupsRoot, formatBytes, newBackupId, readPublishedBackup,
  recoveryBranch, writePrivateFile, type BackupRecord,
} from "./storage";

async function output(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) throw new Error("Git could not verify backup inputs; check repository access.");
  return result.stdout;
}

interface Source {
  tree: WorktreeInventory;
  gitDirectory: string;
  /** Other registered worktree roots, excluded when nested inside the source. */
  others: string[];
}

/** Identity checks need registration only; status scans could run repository filters. */
function uninspected(tree: WorktreeInventory): Worktree {
  return { ...tree, pathExists: true, status: { kind: "unknown", reason: "Not inspected" } };
}

async function assertPausedRebase(tree: WorktreeInventory, branch: string): Promise<void> {
  const operation = await gitOperation(tree.path);
  if (operation !== "rebase") {
    throw new Error(`Expected a paused rebase at ${safeDisplay(tree.path)}; no backup was created.`);
  }
  const headName = await git(tree.path, ["rev-parse", "--git-path", "rebase-merge/head-name"]);
  let name: string;
  try { name = (await readFile(resolve(tree.path, headName.stdout.replace(/\n$/u, "")), "utf8")).replace(/\n$/u, ""); }
  catch { throw new Error("Cannot identify the paused rebase's branch; no backup was created."); }
  if (headName.exitCode !== 0 || name !== `refs/heads/${branch}`) {
    throw new Error("The paused rebase belongs to another branch; no backup was created.");
  }
}

/** Fresh identity and idle-state checks for the selected source worktree. */
async function preflight(
  repository: RepositoryContext, selected: Pick<Worktree, "path" | "branch" | "head">, pausedRebaseBranch?: string,
): Promise<Source> {
  if (!isAbsolute(selected.path)) throw new Error("Backup requires an absolute registered worktree path.");
  const trees = await listWorktreeInventory(repository);
  const matches = trees.filter(tree => samePath(tree.path, selected.path));
  if (matches.length !== 1) throw new Error("Selected worktree is no longer uniquely registered; no backup was created.");
  const tree = matches[0]!;
  if (tree.prunable !== null || tree.locked !== null) {
    throw new Error("Selected worktree is missing, stale or locked; repair it explicitly before backing it up.");
  }
  await assertWorktreeIdentity(repository, uninspected(tree));
  if (pausedRebaseBranch !== undefined) await assertPausedRebase(tree, pausedRebaseBranch);
  else {
    const operation = await gitOperation(tree.path);
    if (operation !== null) {
      throw new Error(`An existing ${operation} operation is in progress at ${safeDisplay(tree.path)}; finish or abort it explicitly before backing up.`);
    }
  }
  if (tree.head === null) throw new Error("Cannot back up an unborn worktree; create a first commit before retrying.");
  if (tree.branch !== selected.branch || tree.head !== selected.head) {
    throw new Error("Selected worktree branch or commit changed; rerun timber backup create.");
  }
  const symbolic = await git(tree.path, ["symbolic-ref", "--quiet", "HEAD"]);
  const head = await output(tree.path, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const branchMatches = tree.branch === null
    ? symbolic.exitCode === 1
    : symbolic.exitCode === 0 && symbolic.stdout === `refs/heads/${tree.branch}`;
  if (!branchMatches || head !== tree.head) throw new Error("Selected worktree branch or commit changed; rerun timber backup create.");
  const sparse = await git(tree.path, ["config", "--bool", "core.sparseCheckout"]);
  if (sparse.exitCode === 0 && sparse.stdout === "true") {
    throw new Error("Sparse-checkout worktrees are not supported; restoring one would show excluded paths as deletions. Disable sparse checkout or back up another worktree.");
  }
  const gitDirectory = await output(tree.path, ["rev-parse", "--absolute-git-dir"]);
  return {
    tree, gitDirectory,
    // Git admin directories are excluded by path as well as by the `.git` name.
    others: [...trees.filter(other => !samePath(other.path, tree.path)).map(other => other.path),
      gitDirectory, await realpath(repository.commonGitDir)],
  };
}

/** Unknown inspection failures count as existing so nothing is overwritten. */
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

export interface BackupCreateOptions {
  /** Keep this backup indefinitely (`--keep`). */
  keep: boolean;
  /** Effective retention and warning settings, captured into the record. */
  settings: BackupSettings;
  /** Present only when interactive; without it a storage warning refuses. */
  ask?: TerminalTextPrompt | undefined;
  now?: () => Date;
  /**
   * Used only by `timber rebase --resolve`: accept a paused merge-backend rebase of
   * this branch (detached HEAD) and record the branch. The index and rebase state
   * are still not captured.
   */
  pausedRebaseBranch?: string;
  /** Used only by `timber rebase --resolve`: receives the published backup ID. */
  report?: { id: string | null };
}

const defaultCreateOptions: BackupCreateOptions = { keep: false, settings: { retentionDays: 7, warningBytes: 5 * 1024 ** 3 } };

interface StorageUse { count: number; total: number; expired: number; eligible: number }

async function storageUse(repository: RepositoryContext, now: Date): Promise<StorageUse> {
  let inventory;
  try { inventory = await readInventory(repository); }
  catch { throw new Error("Cannot read existing recovery backups to check storage; no backup was created. Inspect them with timber backup list."); }
  const use: StorageUse = { count: 0, total: 0, expired: 0, eligible: 0 };
  for (const item of inventory.items) {
    if (item.kind !== "backup") continue;
    use.count++;
    use.total += item.record.bytes;
    if (isExpired(item.record, now)) use.expired += item.record.bytes;
    if (!item.protection.protected) use.eligible += item.record.bytes;
  }
  return use;
}

function storageWarning(bytes: number, use: StorageUse, threshold: number): string[] {
  return [
    `Backup storage warning: this backup is about ${formatBytes(bytes)}. With it, recovery backups would total ${formatBytes(use.total + bytes)},`
      + ` over the ${formatBytes(threshold)} warning threshold (backup_storage_warning).`,
    `Existing: ${use.count} backup${use.count === 1 ? "" : "s"}, ${formatBytes(use.total)}; expired ${formatBytes(use.expired)};`
      + ` eligible for deletion (not protected) ${formatBytes(use.eligible)}.`,
  ];
}

/**
 * Warn before backups exceed the configured threshold. Returns false when cancelled.
 * Without a terminal it refuses rather than waiting or assuming consent.
 */
async function confirmStorage(
  repository: RepositoryContext, source: Source, settings: BackupSettings, io: CommandIO, ask: TerminalTextPrompt | undefined, now: () => Date,
): Promise<boolean> {
  const threshold = settings.warningBytes;
  if (threshold === null) return true;
  for (;;) {
    const bytes = snapshotBytes(await walkWorktree(source.tree.path, source.others));
    const use = await storageUse(repository, now());
    if (use.total + bytes <= threshold) return true;
    const warning = storageWarning(bytes, use, threshold);
    if (!ask) {
      throw new FormattedError([...warning,
        "No backup was created. Run timber backup create in an interactive terminal to continue, delete backups with",
        "timber backup cleanup or timber backup done, or raise or turn off backup_storage_warning with timber setup.",
      ].join("\n"));
    }
    io.stdout(warning.join("\n") + "\n");
    const answer = await ask("Type c to continue, r to review backups for deletion, or press Enter to cancel [c/r/N] ");
    if (answer === "c" || answer === "C") return true;
    if (answer !== "r" && answer !== "R") {
      io.stdout("Cancelled; no backup was created.\n");
      return false;
    }
    await reviewBackupDeletion(repository, { all: false }, io, ask, now());
  }
}

/** Publish a verified snapshot and private ref, or nothing that looks usable. */
export async function createBackup(
  repository: RepositoryContext, selected: Worktree, io: CommandIO, options: BackupCreateOptions = defaultCreateOptions,
): Promise<number> {
  const now = options.now ?? (() => new Date());
  const paused = options.pausedRebaseBranch;
  const source = await preflight(repository, selected, paused);
  // Expired, unprotected backups go first; a partial deletion is reported and makes the run exit 1.
  let cleanup;
  try { cleanup = await cleanupExpiredBackups(repository, io, now(), { quietWhenNone: true }); }
  catch { throw new Error("Cannot read existing recovery backups for expiry cleanup; no backup was created. Inspect them with timber backup list."); }
  if (cleanup.partial) io.stderr("Expiry cleanup did not fully delete every expired backup; creating the new backup anyway.\n");
  if (!await confirmStorage(repository, source, options.settings, io, options.ask, now)) return 0;
  const commonGitDir = await realpath(repository.commonGitDir);
  const root = await ensureBackupsRoot(commonGitDir);
  const id = newBackupId(now());
  const ref = backupRef(id);
  const commit = source.tree.head!;
  const working = join(root, `.incomplete-${id}`);
  const published = join(root, id);
  try { await createPrivateDirectory(working); }
  catch { throw new Error("Cannot create private backup storage; check Git directory permissions. No backup was created."); }
  let refCreated = false;
  let summary: { entries: number; bytes: number };
  let record: BackupRecord;
  // An interrupt must not leave a private copy of ignored secrets behind.
  const interrupted = (signal: NodeJS.Signals) => {
    rmSync(working, { recursive: true, force: true });
    if (refCreated) { try { execaSync("git", ["-c", `core.hooksPath=${disabledHooks}`, "update-ref", "-d", ref, commit], { cwd: source.tree.path, stdin: "ignore", reject: false, env: environment }); } catch { /* Best effort. */ } }
    process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
    process.kill(process.pid, signal);
  };
  const onInterrupt = () => interrupted("SIGINT");
  const onTerminate = () => interrupted("SIGTERM");
  process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate);
  try {
    const before = await walkWorktree(source.tree.path, source.others);
    const bytes = snapshotBytes(before);
    await assertStorageSpace(root, bytes);
    const manifest = await copySnapshot(source.tree.path, before, working);
    const after = await walkWorktree(source.tree.path, source.others);
    if (!sameListing(before, after)) {
      throw new SnapshotError("The worktree changed while it was being backed up; no backup was created. Stop editing the worktree and retry.");
    }
    const recheck = await preflight(repository, source.tree, paused);
    if (!samePath(recheck.gitDirectory, source.gitDirectory)) throw new Error("Selected worktree Git identity changed; no backup was created.");
    await verifyBlobs(working, manifest);
    const manifestText = JSON.stringify(manifest) + "\n";
    record = {
      version: 2, id, createdAt: now().toISOString(), commonGitDir,
      worktreePath: resolve(source.tree.path), worktreeGitDir: await realpath(source.gitDirectory),
      branch: paused ?? source.tree.branch, commit, ref, entries: manifest.length, bytes, manifestSha256: digest(manifestText),
      origin: "manual", retentionDays: options.settings.retentionDays, keep: options.keep,
    };
    try {
      await writePrivateFile(join(working, "manifest.json"), manifestText);
      await writePrivateFile(join(working, "record.json"), JSON.stringify(record) + "\n");
    } catch { throw new Error("Could not write the backup record; check Git directory permissions and free space. No backup was created."); }
    // Create-only: an empty old value requires that the ref does not exist yet.
    const created = await git(source.tree.path, ["update-ref", "-m", "timber backup create", ref, commit, ""]);
    if (created.exitCode !== 0) throw new Error("Could not create the private backup ref; no backup was created.");
    refCreated = true;
    if (await output(source.tree.path, ["rev-parse", "--verify", `${ref}^{commit}`]) !== commit) {
      throw new Error("Private backup ref changed unexpectedly; no backup was created.");
    }
    if (await exists(published)) throw new Error("A backup with this ID already exists; retry to generate a new ID.");
    try { await rename(working, published); }
    catch { throw new Error("Could not publish the backup; no backup was created."); }
    summary = { entries: manifest.length, bytes };
    if (options.report) options.report.id = id;
  } catch (error) {
    await rm(working, { recursive: true, force: true }).catch(() => {});
    if (refCreated) await git(source.tree.path, ["update-ref", "-d", ref, commit]).catch(() => {});
    if (error instanceof SnapshotError || error instanceof BackupRecordError) throw new Error(error.message);
    throw error;
  } finally {
    process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
  }
  // Report only after publication; an output failure must not roll back a published backup.
  io.stdout([
    `Backup created: ${id}`,
    `Worktree: ${safeDisplay(source.tree.path)}`,
    `Branch: ${paused !== undefined ? `${safeDisplay(paused)} (paused rebase)` : source.tree.branch === null ? "detached HEAD" : safeDisplay(source.tree.branch)}`,
    `Commit: ${commit}`,
    `Entries: ${summary.entries}, ${formatBytes(summary.bytes)}`,
    `Stored privately in: ${safeDisplay(published)}`,
    `Retention: ${describeRetention(record!, now(), false)}`,
    ...await totalLine(repository, now()),
    "Ignored files, including secrets such as .env, were copied into the backup.",
    "Expired backups that are not protected are deleted by a later timber backup create or timber backup cleanup;",
    options.keep ? "nothing runs in the background." : `nothing runs in the background. Keep this one with: timber backup keep ${id}`,
    `Restore into a new directory with: timber backup restore ${id} <new-directory>`,
    "",
  ].join("\n"));
  return cleanup.partial ? 1 : 0;
}

/** Reporting only; a read failure after publication must not fail the created backup. */
async function totalLine(repository: RepositoryContext, now: Date): Promise<string[]> {
  try {
    const use = await storageUse(repository, now);
    return [`Recovery backups now: ${use.count}, ${formatBytes(use.total)}`];
  } catch { return []; }
}

async function destinationPath(cwd: string, input: string, commonGitDir: string): Promise<string> {
  if (!input.trim()) throw new Error("Provide a new destination directory for the restored backup.");
  const destination = resolve(cwd, input);
  if (await exists(destination)) {
    throw new Error(`Destination already exists: ${safeDisplay(destination)}. Choose a new directory; restore never overwrites existing files.`);
  }
  let parent: string;
  try {
    parent = await realpath(dirname(destination));
    if (!(await stat(parent)).isDirectory()) throw new Error("not a directory");
  } catch { throw new Error("The destination's parent directory must already exist."); }
  const physical = join(parent, basename(destination));
  const inside = relative(commonGitDir, physical);
  if (inside === "" || (inside !== ".." && !inside.startsWith(".." + sep) && !isAbsolute(inside))) {
    throw new Error("Cannot restore into the repository's Git directory; choose a directory outside it.");
  }
  return physical;
}

export type BackupRestoreResult = "restored" | "refused" | "partial";

/** Observed facts for the app record of one restore; filled in as each one is verified. */
export interface BackupRestoreReport {
  result: BackupRestoreResult;
  /** The requested ID once it is a well-formed backup ID; raw input is never echoed. */
  id: string | null;
  /** Recovery worktree path; null unless restored. */
  worktree: string | null;
  /** Recovery branch; null unless restored. */
  branch: string | null;
  /** Commit the recovery branch points at; null unless restored. */
  commit: string | null;
  /** Present only for a partial restore: what was observed to remain after the failure. */
  remaining: { worktree: string | null; branch: string | null } | null;
  /** Manual commands, run in the repository, that remove only what was observed to remain. */
  cleanup: string[];
}

/** Until a restore proves otherwise, a stop is a refusal that created nothing. */
export function createBackupRestoreReport(): BackupRestoreReport {
  return { result: "refused", id: null, worktree: null, branch: null, commit: null, remaining: null, cleanup: [] };
}

/** Record what a failed restore actually left; an uncheckable path or branch counts as remaining. */
async function reportLeftovers(report: BackupRestoreReport, gitCwd: string, destination: string, branch: string): Promise<void> {
  const worktree = await exists(destination) ? destination : null;
  const left = await git(gitCwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => null);
  const branchLeft = left === null || left.exitCode !== 1 ? branch : null;
  if (worktree === null && branchLeft === null) return;
  report.result = "partial";
  report.remaining = { worktree, branch: branchLeft };
  report.cleanup = [
    ...(worktree === null ? [] : [`git worktree remove --force -- ${shellQuoteForDisplay(worktree)}`]),
    ...(branchLeft === null ? [] : [`git branch -D -- ${shellQuoteForDisplay(branchLeft)}`]),
  ];
}

function incompleteRestore(destination: string, branch: string, id: string): FormattedError {
  return new FormattedError([
    `Restore of backup ${id} did not complete; the recovery workspace at ${safeDisplay(destination)} is incomplete and must not be used.`,
    "The backup and the source worktree were not changed. Remove the incomplete workspace manually, then retry:",
    `  git worktree remove --force -- ${shellQuoteForDisplay(destination)}`,
    `  git branch -D -- ${shellQuoteForDisplay(branch)}`,
  ].join("\n"));
}

/** Recover into a new worktree and branch; never touches the source or the backup. */
export async function restoreBackup(
  repository: RepositoryContext, id: string, destinationInput: string, cwd: string, io: CommandIO,
  report: BackupRestoreReport = createBackupRestoreReport(),
): Promise<number> {
  if (backupIdPattern.test(id)) report.id = id;
  const commonGitDir = await realpath(repository.commonGitDir);
  let backup;
  try { backup = await readPublishedBackup(commonGitDir, id); }
  catch (error) { throw new Error(error instanceof Error ? error.message : "Backup cannot be read."); }
  const { record, manifest, directory } = backup;
  // Location inside this common Git directory plus the pinned ref prove membership;
  // the recorded absolute path is informational so a moved repository stays restorable.
  const gitCwd = repository.primaryWorktreeRoot;
  const pinned = await git(gitCwd, ["rev-parse", "--verify", `${record.ref}^{commit}`]);
  if (pinned.exitCode !== 0 || pinned.stdout !== record.commit) {
    throw new Error("The backup's private Git ref is missing or no longer names its commit; it was not restored.");
  }
  try { await verifyBlobs(directory, manifest); }
  catch (error) { throw new Error(error instanceof Error ? error.message : "Backup snapshot cannot be verified."); }
  const destination = await destinationPath(cwd, destinationInput, commonGitDir);
  const branch = recoveryBranch(record.id);
  const existing = await git(gitCwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (existing.exitCode === 0) throw new Error(`Recovery branch ${safeDisplay(branch)} already exists; inspect or remove it before restoring again.`);
  if (existing.exitCode !== 1) throw new Error("Cannot check for an existing recovery branch; backup was not restored.");

  const added = await git(gitCwd, ["worktree", "add", "--no-checkout", "-b", branch,
    "--", destination, record.commit]);
  if (added.exitCode !== 0) {
    await reportLeftovers(report, gitCwd, destination, branch);
    if (await exists(destination)) throw incompleteRestore(destination, branch, record.id);
    const leftover = await git(gitCwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (leftover.exitCode !== 1) {
      throw new FormattedError(`Git could not create the recovery worktree, but it may have created branch ${safeDisplay(branch)}. Nothing else was restored; the backup and source were not changed. After checking it, remove the branch before retrying:\n  git branch -D -- ${shellQuoteForDisplay(branch)}`);
    }
    throw new Error("Git could not create the recovery worktree; nothing was restored. Check that the destination's parent is writable and that no branch named recovery exists.");
  }
  try {
    const trees = await listWorktreeInventory(repository);
    const tree = trees.find(candidate => samePath(candidate.path, destination));
    if (!tree || tree.branch !== branch || tree.head !== record.commit) throw new Error("Recovery worktree identity mismatch");
    await assertWorktreeIdentity(repository, uninspected(tree));
    await restoreSnapshot(destination, directory, manifest);
    const index = await git(destination, ["read-tree", record.commit]);
    if (index.exitCode !== 0) throw new Error("read-tree failed");
  } catch {
    await reportLeftovers(report, gitCwd, destination, branch);
    throw incompleteRestore(destination, branch, record.id);
  }
  report.result = "restored";
  report.worktree = destination;
  report.branch = branch;
  report.commit = record.commit;
  io.stdout([
    `Restored backup ${record.id}`,
    `Recovery worktree: ${safeDisplay(destination)}`,
    `Recovery branch: ${safeDisplay(branch)} at ${record.commit}`,
    `Original branch: ${record.branch === null ? "detached HEAD" : safeDisplay(record.branch)}`,
    "Backed-up changes appear as unstaged or untracked files; original staging was not restored.",
    "No hooks, setup, editors or agents were run. The backup was kept unchanged.",
    `Inspect with: git -C ${shellQuoteForDisplay(destination)} status`,
    "",
  ].join("\n"));
  return 0;
}
