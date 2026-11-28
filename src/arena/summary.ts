import { execa } from "execa";
import { lstat } from "node:fs/promises";
import { listWorktreeInventory } from "../git/worktrees";
import { validateArenaAttempt } from "./storage";
import type { ArenaAttemptRecord, ArenaManifest } from "./types";
import type { RepositoryContext } from "../types";
import { gitCommand } from "../platform/git-command";

export interface DiffStat { files: number; insertions: number; deletions: number }

export type ArenaAttemptSummary =
  | { kind: "unavailable"; reason: string }
  | {
    kind: "available";
    /** Commits on HEAD since the recorded base. */
    commits: number;
    /** Recorded base to HEAD. */
    committed: DiffStat;
    /** HEAD to working files, staged and unstaged together. */
    uncommitted: DiffStat;
    untracked: number;
    ignored: number;
  };

export interface ArenaRemovalState {
  worktree: "present" | "absent" | "unknown";
  branch: "present" | "absent" | "unknown";
}

/** Observe actual outcomes; absence never grants ownership of a replacement. */
export async function inspectArenaRemoval(repository: RepositoryContext, attempt: ArenaAttemptRecord): Promise<ArenaRemovalState> {
  const state: ArenaRemovalState = { worktree: "unknown", branch: "unknown" };
  try {
    let exists = true;
    try { await lstat(attempt.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
    // The inventory names registered paths without running status in any worktree.
    const registered = (await listWorktreeInventory(repository)).some(w => w.path === attempt.path);
    state.worktree = exists || registered ? "present" : "absent";
  } catch { /* Unknown is not absence. */ }
  try {
    const result = await execa(gitCommand(), ["rev-parse", "--verify", "--quiet", `refs/heads/${attempt.branch}`], {
      cwd: repository.primaryWorktreeRoot, stdin: "ignore", reject: false, timeout: 8000,
      env: { GIT_OPTIONAL_LOCKS: "0" },
    });
    if (result.exitCode === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(result.stdout)) state.branch = "present";
    else if (result.exitCode === 1) state.branch = "absent";
  } catch { /* Unknown is not absence. */ }
  return state;
}

export function parseShortstat(text: string): DiffStat {
  const number = (pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0);
  return { files: number(/(\d+) files? changed/u), insertions: number(/(\d+) insertions?/u), deletions: number(/(\d+) deletions?/u) };
}

/**
 * Committed and uncommitted changes are measured separately: local edits can
 * cancel committed work, so a clean net diff never means an empty attempt.
 */
export async function summarizeArenaAttempt(
  repository: RepositoryContext, manifest: ArenaManifest, attempt: ArenaAttemptRecord,
): Promise<ArenaAttemptSummary> {
  try {
    const tree = await validateArenaAttempt(repository, manifest, attempt);
    if (tree.status.kind !== "known") throw new Error(`file status is unknown: ${tree.status.reason}`);
    const run = async (args: string[]) => (await execa(gitCommand(), args, {
      cwd: tree.path, stdin: "ignore", timeout: 8000, env: { GIT_OPTIONAL_LOCKS: "0" },
    })).stdout;
    const base = manifest.base.commit;
    const [count, committed, uncommitted] = await Promise.all([
      run(["rev-list", "--count", `${base}..HEAD`]),
      run(["diff", "--no-ext-diff", "--no-textconv", "--shortstat", base, "HEAD", "--"]),
      run(["diff", "--no-ext-diff", "--no-textconv", "--shortstat", "HEAD", "--"]),
    ]);
    const current = await validateArenaAttempt(repository, manifest, attempt);
    if (current.head !== tree.head) throw new Error("HEAD changed during comparison; retry");
    return { kind: "available", commits: Number(count.trim()), committed: parseShortstat(committed),
      uncommitted: parseShortstat(uncommitted), untracked: tree.status.untracked.length, ignored: tree.status.ignored.length };
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : "comparison failed" };
  }
}
