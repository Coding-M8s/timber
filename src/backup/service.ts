import { rmSync } from "node:fs";
import { lstat, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execa, execaSync } from "execa";
import { FormattedError, safeDisplay, shellQuoteForDisplay } from "../display";
import { gitOperation } from "../git/operations";
import { assertWorktreeIdentity, listWorktreeInventory } from "../git/worktrees";
import { samePath } from "../platform/paths";
import type { CommandIO } from "../services";
import type { RepositoryContext, Worktree, WorktreeInventory } from "../types";
import {
  assertStorageSpace, copySnapshot, restoreSnapshot, sameListing, SnapshotError, snapshotBytes, verifyBlobs, walkWorktree,
} from "./snapshot";
import {
  BackupRecordError, backupRef, createPrivateDirectory, digest, ensureBackupsRoot, newBackupId, readPublishedBackup,
  recoveryBranch, writePrivateFile, type BackupRecord,
} from "./storage";

const environment = {
  GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "false", SSH_ASKPASS: "false", GCM_INTERACTIVE: "Never",
  GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_OPTIONAL_LOCKS: "0",
};
const disabledHooks = process.platform === "win32" ? "NUL" : "/dev/null";

/** Hooks are repository code; backup and restore never run them. */
async function git(cwd: string, args: readonly string[]) {
  try {
    return await execa("git", ["-c", `core.hooksPath=${disabledHooks}`, ...args], { cwd, stdin: "ignore", reject: false, env: environment });
  } catch {
    throw new Error("Could not start Git for backup; check the Git installation and repository access.");
  }
}

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

/** Fresh identity and idle-state checks for the selected source worktree. */
async function preflight(repository: RepositoryContext, selected: Pick<Worktree, "path" | "branch" | "head">): Promise<Source> {
  if (!isAbsolute(selected.path)) throw new Error("Backup requires an absolute registered worktree path.");
  const trees = await listWorktreeInventory(repository);
  const matches = trees.filter(tree => samePath(tree.path, selected.path));
  if (matches.length !== 1) throw new Error("Selected worktree is no longer uniquely registered; no backup was created.");
  const tree = matches[0]!;
  if (tree.prunable !== null || tree.locked !== null) {
    throw new Error("Selected worktree is missing, stale or locked; repair it explicitly before backing it up.");
  }
  await assertWorktreeIdentity(repository, uninspected(tree));
  const operation = await gitOperation(tree.path);
  if (operation !== null) {
    throw new Error(`An existing ${operation} operation is in progress at ${safeDisplay(tree.path)}; finish or abort it explicitly before backing up.`);
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Publish a verified snapshot and private ref, or nothing that looks usable. */
export async function createBackup(repository: RepositoryContext, selected: Worktree, io: CommandIO): Promise<number> {
  const source = await preflight(repository, selected);
  const commonGitDir = await realpath(repository.commonGitDir);
  const root = await ensureBackupsRoot(commonGitDir);
  const id = newBackupId();
  const ref = backupRef(id);
  const commit = source.tree.head!;
  const working = join(root, `.incomplete-${id}`);
  const published = join(root, id);
  try { await createPrivateDirectory(working); }
  catch { throw new Error("Cannot create private backup storage; check Git directory permissions. No backup was created."); }
  let refCreated = false;
  let summary: { entries: number; bytes: number };
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
    const recheck = await preflight(repository, source.tree);
    if (!samePath(recheck.gitDirectory, source.gitDirectory)) throw new Error("Selected worktree Git identity changed; no backup was created.");
    await verifyBlobs(working, manifest);
    const manifestText = JSON.stringify(manifest) + "\n";
    const record: BackupRecord = {
      version: 1, id, createdAt: new Date().toISOString(), commonGitDir,
      worktreePath: resolve(source.tree.path), worktreeGitDir: await realpath(source.gitDirectory),
      branch: source.tree.branch, commit, ref, entries: manifest.length, bytes, manifestSha256: digest(manifestText),
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
    `Branch: ${source.tree.branch === null ? "detached HEAD" : safeDisplay(source.tree.branch)}`,
    `Commit: ${commit}`,
    `Entries: ${summary.entries}, ${formatBytes(summary.bytes)}`,
    `Stored privately in: ${safeDisplay(published)}`,
    "Ignored files, including secrets such as .env, were copied into the backup. It is kept until removed.",
    `Restore into a new directory with: timber backup restore ${id} <new-directory>`,
    "",
  ].join("\n"));
  return 0;
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
): Promise<number> {
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
    throw incompleteRestore(destination, branch, record.id);
  }
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
