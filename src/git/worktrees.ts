import type { WorktreeReadPhase } from "./worktree-read-phase";
import { samePath } from "../platform/paths";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import type { GitReadOptions, RepositoryContext, Worktree, WorktreeInventory, WorktreeStatus } from "../types";

async function runGit(cwd: string, args: readonly string[], options?: GitReadOptions) {
  return execa("git", [...args], {
    cwd, reject: false, env: { GIT_OPTIONAL_LOCKS: "0" },
    ...(options?.signal === undefined ? {} : { cancelSignal: options.signal, forceKillAfterDelay: 250 }),
  });
}

function parseStatus(output: string): WorktreeStatus {
  const modified = new Set<string>();
  const untracked = new Set<string>();
  const ignored = new Set<string>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code === "??") untracked.add(path);
    else if (code === "!!") ignored.add(path);
    else {
      modified.add(path);
      // In porcelain v1 -z, a rename/copy destination is followed by its source.
      if (code.includes("R") || code.includes("C")) index++;
    }
  }
  return { kind: "known", modified: [...modified], untracked: [...untracked], ignored: [...ignored] };
}

class WorktreeIdentityError extends Error {
  constructor(message: string, readonly statusReason: string) {
    super(message);
    this.name = "WorktreeIdentityError";
  }
}

const IDENTITY_RECOVERY = "Restore the original worktree or repair its Git metadata explicitly before retrying.";

function identityFailure(message: string, statusReason: string): WorktreeIdentityError {
  return new WorktreeIdentityError(`${message} ${IDENTITY_RECOVERY}`, statusReason);
}

/** Recheck the filesystem and Git metadata for a registered worktree path. */
export async function worktreeGitDirectory(
  repository: RepositoryContext, tree: WorktreeInventory,
): Promise<string> {
  let info;
  try {
    info = await stat(tree.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw identityFailure(`Worktree path is missing: ${tree.path}`, "Worktree path is missing");
    }
    throw identityFailure(
      `Cannot inspect worktree at ${tree.path}; check directory access.`,
      "Cannot inspect worktree; check directory access",
    );
  }
  if (!info.isDirectory()) {
    throw identityFailure(`Worktree path is not a directory: ${tree.path}`, "Worktree path is not a directory");
  }

  const gitDirectory = await readWorktreeIdentity(repository, tree);

  let matchesWorktree: boolean;
  try {
    matchesWorktree = tree.isPrimary
      ? samePath(gitDirectory, repository.commonGitDir)
      : samePath((await readFile(join(gitDirectory, "gitdir"), "utf8")).replace(/\r?\n$/, ""),
        resolve(tree.path, ".git"));
  } catch {
    throw identityFailure(
      `Cannot verify Git metadata for worktree at ${tree.path}.`,
      "Cannot inspect worktree; check Git metadata and access",
    );
  }
  if (!matchesWorktree) {
    throw identityFailure(
      `Git metadata for worktree at ${tree.path} belongs to a different path.`,
      "Git metadata belongs to a different worktree path",
    );
  }
  return gitDirectory;
}

/**
 * Read a worktree's common Git directory, prefix and own Git directory and return
 * the Git directory once the worktree still identifies this repository. One
 * `rev-parse` answers all three in the common case; any failure or unexpected
 * output repeats the reads one at a time so each failure keeps its own message.
 */
async function readWorktreeIdentity(repository: RepositoryContext, tree: WorktreeInventory): Promise<string> {
  try {
    const combined = await runGit(tree.path, [
      "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-prefix", "--absolute-git-dir",
    ]);
    const lines = combined.stdout.split("\n");
    if (combined.exitCode === 0 && lines.length === 3 && lines[1] === "" &&
        samePath(lines[0]!, repository.commonGitDir)) {
      return lines[2]!;
    }
  } catch {
    // Fall through to the separate reads, which report the failure precisely.
  }

  let identity;
  let prefix;
  try {
    identity = await runGit(tree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    prefix = await runGit(tree.path, ["rev-parse", "--show-prefix"]);
  } catch {
    throw identityFailure(
      `Cannot verify Git identity for worktree at ${tree.path}.`,
      "Cannot inspect worktree; check Git metadata and access",
    );
  }
  if (identity.exitCode !== 0 || prefix.exitCode !== 0 || prefix.stdout !== "" ||
      !samePath(identity.stdout, repository.commonGitDir)) {
    throw identityFailure(
      `Worktree at ${tree.path} no longer identifies this repository.`,
      "Path no longer identifies this Git worktree",
    );
  }

  let gitDirectory;
  try {
    gitDirectory = await runGit(tree.path, ["rev-parse", "--absolute-git-dir"]);
  } catch {
    throw identityFailure(
      `Cannot verify Git metadata for worktree at ${tree.path}.`,
      "Cannot inspect worktree; check Git metadata and access",
    );
  }
  if (gitDirectory.exitCode !== 0) {
    throw identityFailure(
      `Cannot verify Git metadata for worktree at ${tree.path}.`,
      "Cannot inspect worktree; check Git metadata and access",
    );
  }

  return gitDirectory.stdout;
}

export async function assertWorktreeIdentity(
  repository: RepositoryContext, tree: WorktreeInventory,
): Promise<void> {
  await worktreeGitDirectory(repository, tree);
}

/** A stale selected target must be repaired or pruned explicitly before opening. */
export async function assertOpenableWorktree(
  repository: RepositoryContext, worktree: Worktree, phase?: WorktreeReadPhase,
): Promise<void> {
  if (!worktree.pathExists) {
    throw new Error(`Cannot open missing worktree at ${worktree.path}; restore it or prune it explicitly first.`);
  }
  if (worktree.prunable !== null) {
    throw new Error(`Cannot open prunable worktree at ${worktree.path}; repair or prune it explicitly first.`);
  }
  if (phase) await phase.gitDirectory(worktree);
  else await assertWorktreeIdentity(repository, worktree);
}

/** Inventory fields alone are lookup keys, never filesystem or preservation evidence. */
export function uninspectedWorktree(tree: WorktreeInventory): Worktree {
  return { ...tree, pathExists: false, status: { kind: "unknown", reason: "Not inspected" } };
}

/** Visit only this registered path; callers start a fresh phase after external actions.
 * Without inspectStatus, stop after identity: status can run repository clean filters.
 * Without includeIgnored, Git skips ignored folders and status.ignored is [] meaning
 * "not inspected": only listing may use it, never cleanup or rebase safety checks. */
export async function inspectWorktree(
  repository: RepositoryContext, inventory: WorktreeInventory, phase?: WorktreeReadPhase, inspectStatus = true,
  includeIgnored = true,
): Promise<Worktree> {
  const tree = uninspectedWorktree(inventory);
  try {
    const info = await stat(tree.path);
    tree.pathExists = true;
    if (!info.isDirectory()) {
      tree.status = { kind: "unknown", reason: "Worktree path is not a directory" };
      return tree;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    tree.pathExists = code !== "ENOENT" && code !== "ENOTDIR";
    tree.status = {
      kind: "unknown",
      reason: tree.pathExists ? "Cannot inspect worktree; check directory access" : "Worktree path is missing",
    };
    return tree;
  }

  try {
    if (phase) await phase.gitDirectory(tree);
    else await assertWorktreeIdentity(repository, tree);
  } catch (error) {
    tree.status = {
      kind: "unknown",
      reason: error instanceof WorktreeIdentityError
        ? error.statusReason : "Cannot inspect worktree; check Git metadata and access",
    };
    return tree;
  }

  if (!inspectStatus) return tree;

  try {
    // Untracked files are listed one by one in both modes. Leaving out --ignored
    // keeps Git out of ignored folders such as node_modules, which dominate cost.
    const result = await runGit(tree.path, [
      "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "status.renames=true",
      "status", "--porcelain=v1", "-z", "--untracked-files=all", ...(includeIgnored ? ["--ignored"] : []),
      "--ignore-submodules=none",
    ]);
    tree.status = result.exitCode === 0
      ? parseStatus(result.stdout)
      : { kind: "unknown", reason: "Cannot read Git status; check worktree access and metadata" };
  } catch {
    tree.status = { kind: "unknown", reason: "Cannot inspect worktree; check Git metadata and access" };
  }
  return tree;
}

/** Read Git's registered paths/branches without visiting worktrees or scanning files. */
export async function listWorktreeInventory(
  repository: RepositoryContext, options?: GitReadOptions,
): Promise<readonly WorktreeInventory[]> {
  const result = await runGit(repository.currentWorktreeRoot, ["worktree", "list", "--porcelain", "-z"], options);
  if (result.exitCode !== 0) {
    throw new Error("Cannot list Git worktrees; check repository access and that Git is installed.");
  }
  const trees: WorktreeInventory[] = [];
  for (const record of result.stdout.split("\0\0")) {
    if (!record) continue;
    const fields = record.split("\0");
    const pathField = fields[0];
    if (!pathField?.startsWith("worktree ")) throw new Error("Cannot read worktree paths from Git metadata.");
    const listedPath = resolve(pathField.slice("worktree ".length));
    // A separate Git directory is listed first instead of the primary working files.
    const isPrimary = trees.length === 0;
    const tree: WorktreeInventory = {
      path: isPrimary ? repository.primaryWorktreeRoot : listedPath,
      branch: null, head: null, isPrimary, locked: null, prunable: null,
    };
    for (const field of fields.slice(1)) {
      if (field.startsWith("HEAD ")) {
        const head = field.slice(5);
        tree.head = /^0+$/.test(head) ? null : head;
      } else if (field.startsWith("branch refs/heads/")) {
        tree.branch = field.slice("branch refs/heads/".length);
      } else if (field === "locked" || field.startsWith("locked ")) {
        tree.locked = { reason: field === "locked" ? null : field.slice(7) };
      } else if (field === "prunable" || field.startsWith("prunable ")) {
        tree.prunable = { reason: field === "prunable" ? null : field.slice(9) };
      }
    }
    trees.push(tree);
  }
  return trees;
}

/** At most this many worktrees are inspected at once, so many worktrees do not flood the machine. */
export const WORKTREE_INSPECTION_LIMIT = 4;

/** Map items with at most `limit` calls in flight, keeping input order. */
export async function mapWithLimit<T, R>(
  items: readonly T[], limit: number, run: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Concurrency limit must be a positive integer.");
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index]!);
      } catch (error) {
        // Start no new items after a failure; Promise.all reports the first one.
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Git's inventory is authoritative; per-worktree failures remain visible as unknown rows. */
export async function listWorktrees(
  repository: RepositoryContext,
  options: { inspectStatus?: boolean; includeIgnored?: boolean; phase?: WorktreeReadPhase } = {},
): Promise<readonly Worktree[]> {
  const trees = await listWorktreeInventory(repository);
  return mapWithLimit(trees, WORKTREE_INSPECTION_LIMIT, tree => inspectWorktree(
    repository, tree, options.phase, options.inspectStatus !== false, options.includeIgnored !== false));
}
