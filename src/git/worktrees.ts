import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import type { RepositoryContext, Worktree, WorktreeStatus } from "../types";

async function runGit(cwd: string, args: readonly string[]) {
  return execa("git", [...args], {
    cwd, reject: false, env: { GIT_OPTIONAL_LOCKS: "0" },
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

async function inspectWorktree(tree: Worktree, repository: RepositoryContext): Promise<Worktree> {
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
    const identity = await runGit(tree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const prefix = await runGit(tree.path, ["rev-parse", "--show-prefix"]);
    if (identity.exitCode !== 0 || prefix.exitCode !== 0 || prefix.stdout !== "" ||
        resolve(identity.stdout) !== resolve(repository.commonGitDir)) {
      tree.status = { kind: "unknown", reason: "Path no longer identifies this Git worktree" };
      return tree;
    }
    const gitDirectory = await runGit(tree.path, ["rev-parse", "--absolute-git-dir"]);
    if (gitDirectory.exitCode !== 0) throw new Error("Cannot read worktree Git directory");
    const matchesWorktree = tree.isPrimary
      ? resolve(gitDirectory.stdout) === resolve(repository.commonGitDir)
      : resolve((await readFile(join(gitDirectory.stdout, "gitdir"), "utf8")).replace(/\r?\n$/, "")) ===
        resolve(tree.path, ".git");
    if (!matchesWorktree) {
      tree.status = { kind: "unknown", reason: "Git metadata belongs to a different worktree path" };
      return tree;
    }
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

/** Git's inventory is authoritative; per-worktree failures remain visible as unknown rows. */
export async function listWorktrees(repository: RepositoryContext): Promise<readonly Worktree[]> {
  const result = await runGit(repository.currentWorktreeRoot, ["worktree", "list", "--porcelain", "-z"]);
  if (result.exitCode !== 0) {
    throw new Error("Cannot list Git worktrees; check repository access and that Git is installed.");
  }
  const trees: Worktree[] = [];
  for (const record of result.stdout.split("\0\0")) {
    if (!record) continue;
    const fields = record.split("\0");
    const pathField = fields[0];
    if (!pathField?.startsWith("worktree ")) throw new Error("Cannot read worktree paths from Git metadata.");
    const listedPath = pathField.slice("worktree ".length);
    // A separate Git directory is listed first instead of the primary working files.
    const isPrimary = trees.length === 0;
    const tree: Worktree = {
      path: isPrimary ? repository.primaryWorktreeRoot : listedPath,
      branch: null, head: null, isPrimary, pathExists: false,
      locked: null, prunable: null, status: { kind: "unknown", reason: "Not inspected" },
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
  return Promise.all(trees.map(tree => inspectWorktree(tree, repository)));
}
