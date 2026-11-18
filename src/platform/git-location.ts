import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { execa } from "execa";

/** Where a path sits relative to Git, judged from its nearest existing ancestor. */
export type GitLocation = "inside" | "outside" | "unverified";

const code = (error: unknown): unknown => typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

/**
 * Resolve the nearest existing ancestor (symlinks included) and ask Git whether it is inside a
 * worktree or a Git administrative directory. Ambient GIT_* variables are cleared so they cannot
 * hide a surrounding repository. "unverified" means Git failed for another reason than "not a
 * repository". Throws when no ancestor exists or the filesystem or Git cannot be reached.
 */
export async function gitLocation(path: string, signal?: AbortSignal): Promise<GitLocation> {
  signal?.throwIfAborted();
  let ancestor = dirname(path);
  while (true) {
    signal?.throwIfAborted();
    try { await lstat(ancestor); break; }
    catch (error) { if (code(error) !== "ENOENT") throw error; }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("No existing ancestor directory to check against Git.");
    ancestor = parent;
  }
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree", "--is-inside-git-dir"], {
    cwd: await realpath(ancestor), reject: false, stdin: "ignore",
    ...(signal ? { cancelSignal: signal } : {}), forceKillAfterDelay: 250, maxBuffer: 16_384,
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined,
      GIT_CEILING_DIRECTORIES: undefined, GIT_DISCOVERY_ACROSS_FILESYSTEM: "1", LC_ALL: "C" },
  });
  if (result.stdout.split("\n").includes("true")) return "inside";
  const notRepository = result.exitCode === 128
    && result.stderr.trim() === "fatal: not a git repository (or any of the parent directories): .git";
  return result.exitCode !== 0 && !notRepository ? "unverified" : "outside";
}
