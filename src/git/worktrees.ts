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
export async function assertWorktreeIdentity(
  repository: RepositoryContext, tree: Worktree,
): Promise<void> {
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

  let matchesWorktree: boolean;
  try {
    matchesWorktree = tree.isPrimary
      ? samePath(gitDirectory.stdout, repository.commonGitDir)
      : samePath((await readFile(join(gitDirectory.stdout, "gitdir"), "utf8")).replace(/\r?\n$/, ""),
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
}

/** A stale selected target must be repaired or pruned explicitly before opening. */
export async function assertOpenableWorktree(
  repository: RepositoryContext, worktree: Worktree,
): Promise<void> {
  if (!worktree.pathExists) {
    throw new Error(`Cannot open missing worktree at ${worktree.path}; restore it or prune it explicitly first.`);
  }
  if (worktree.prunable !== null) {
    throw new Error(`Cannot open prunable worktree at ${worktree.path}; repair or prune it explicitly first.`);
  }
  await assertWorktreeIdentity(repository, worktree);
}

async function inspectWorktree(tree: Worktree, repository: RepositoryContext, inspectStatus: boolean): Promise<Worktree> {
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
    await assertWorktreeIdentity(repository, tree);
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
    const result = await runGit(tree.path, [
      "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "status.renames=true",
      "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--ignore-submodules=none",
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

/** Git's inventory is authoritative; per-worktree failures remain visible as unknown rows. */
export async function listWorktrees(
  repository: RepositoryContext, options: { inspectStatus?: boolean } = {},
): Promise<readonly Worktree[]> {
  const trees = (await listWorktreeInventory(repository)).map<Worktree>(tree => ({
    ...tree, pathExists: false, status: { kind: "unknown", reason: "Not inspected" },
  }));
  return Promise.all(trees.map(tree => inspectWorktree(tree, repository, options.inspectStatus !== false)));
}
