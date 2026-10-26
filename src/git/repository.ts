import { resolve } from "node:path";
import { samePath } from "../platform/paths";
import { stat } from "node:fs/promises";
import { execa } from "execa";
import type { GitReadOptions, Remote, RepositoryContext } from "../types";

/** Discovery only reads; optional locks are never needed and must not block Tab. */
async function runGit(cwd: string, args: readonly string[], options?: GitReadOptions) {
  const result = await execa("git", [...args], {
    cwd, reject: false, env: { GIT_OPTIONAL_LOCKS: "0" },
    ...(options?.signal === undefined ? {} : { cancelSignal: options.signal, forceKillAfterDelay: 250 }),
  });
  if (result.exitCode === undefined) {
    throw new Error("Could not run Git. Check that Git is installed and available on PATH.");
  }
  return result;
}

async function gitOutput(cwd: string, args: readonly string[], detail: string, options?: GitReadOptions): Promise<string> {
  const result = await runGit(cwd, args, options);
  if (result.exitCode !== 0) throw new Error(`Could not read ${detail} from Git.`);
  return result.stdout;
}

async function currentBranch(cwd: string, options?: GitReadOptions): Promise<string | null> {
  const result = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
  if (result.exitCode === 1) return null;
  if (result.exitCode !== 0) throw new Error("Could not read current branch from Git.");
  return result.stdout;
}

async function remotes(cwd: string, options?: GitReadOptions): Promise<readonly Remote[]> {
  const names = (await gitOutput(cwd, ["remote"], "remote names", options))
    .split("\n").filter(Boolean);
  return Promise.all(names.map(async name => {
    const result = await runGit(cwd, ["symbolic-ref", "--quiet", `refs/remotes/${name}/HEAD`], options);
    if (result.exitCode === 1) return { name, defaultBranchRef: null };
    if (result.exitCode !== 0) throw new Error(`Could not read default branch for remote ${name} from Git.`);
    return { name, defaultBranchRef: result.stdout };
  }));
}

/** Read-only discovery from any directory in a non-bare Git worktree. */
export async function discoverRepository(cwd: string, options?: GitReadOptions): Promise<RepositoryContext> {
  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    throw new Error(`Cannot access directory: ${cwd}`);
  }
  if (!cwdStat.isDirectory()) throw new Error(`Not a directory: ${cwd}`);

  const inWorktree = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], options);
  if (inWorktree.exitCode !== 0) throw new Error(`Not a Git repository: ${cwd}`);
  if (inWorktree.stdout !== "true") {
    const isBare = await runGit(cwd, ["rev-parse", "--is-bare-repository"], options);
    if (isBare.exitCode === 0 && isBare.stdout === "true") {
      throw new Error(`Bare Git repositories are unsupported: ${cwd}`);
    }
    throw new Error(`Not inside a Git worktree: ${cwd}`);
  }

  const currentWorktreeRoot = resolve(await gitOutput(cwd, ["rev-parse", "--show-toplevel"], "worktree root", options));
  const commonGitDir = resolve(await gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "common Git directory", options));
  const worktreeList = await gitOutput(cwd, ["worktree", "list", "--porcelain", "-z"], "primary worktree", options);
  const firstTerminator = worktreeList.indexOf("\0");
  if (firstTerminator < 0) throw new Error("Could not find primary worktree in Git metadata.");
  const firstField = worktreeList.slice(0, firstTerminator);
  if (!firstField.startsWith("worktree ")) throw new Error("Could not find primary worktree in Git metadata.");
  let primaryWorktreeRoot = resolve(firstField.slice("worktree ".length));
  if (samePath(primaryWorktreeRoot, commonGitDir)) {
    // Git lists a separate Git directory as the primary worktree, although it
    // contains metadata rather than working files. The primary's own cwd resolves it.
    const currentGitDir = await gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"], "current Git directory", options);
    if (!samePath(currentGitDir, commonGitDir)) {
      throw new Error("Could not locate primary worktree for linked checkout with separate Git metadata. Run Timber from the primary checkout.");
    }
    primaryWorktreeRoot = currentWorktreeRoot;
  }

  return {
    currentWorktreeRoot,
    primaryWorktreeRoot,
    commonGitDir,
    currentBranch: await currentBranch(cwd, options),
    remotes: await remotes(cwd, options),
  };
}
