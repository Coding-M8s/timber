import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryContext, Worktree } from "../types";
import { gitCommand } from "../platform/git-command";

export interface ArenaArchive {
  ref: string;
  commit: string;
  /** True when uncommitted or untracked files were captured in an extra snapshot commit. */
  snapshot: boolean;
}

/** Fixed tool identity so archiving never depends on, or impersonates, user Git identity. */
const identity = {
  GIT_AUTHOR_NAME: "Timber", GIT_AUTHOR_EMAIL: "timber@localhost.invalid",
  GIT_COMMITTER_NAME: "Timber", GIT_COMMITTER_EMAIL: "timber@localhost.invalid",
};

async function git(cwd: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> {
  const result = await execa(gitCommand(), [...args], {
    cwd, stdin: "ignore", reject: false, timeout: 60_000, env: { GIT_OPTIONAL_LOCKS: "0", ...env },
  });
  if (result.exitCode !== 0) throw new Error(`Git ${args[0]} failed while archiving: ${result.stderr.split("\n")[0] || "no detail"}`);
  return result.stdout;
}

async function resolveRef(repository: RepositoryContext, ref: string): Promise<string | null> {
  const result = await execa(gitCommand(), ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repository.primaryWorktreeRoot, stdin: "ignore", reject: false, timeout: 8000, env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Save every commit plus tracked and untracked (not ignored) file state of a losing
 * attempt under refs/timber/arena/<arena>/<label>, so removal loses nothing but
 * ignored files. Uses a private temporary index; the attempt's own index, files and
 * refs are untouched. Existing archive refs are never overwritten.
 */
export async function archiveArenaAttempt(
  repository: RepositoryContext, worktree: Worktree, arena: string, label: string,
): Promise<ArenaArchive> {
  if (worktree.status.kind !== "known") throw new Error("File status is unknown; cannot archive this attempt.");
  const cwd = worktree.path;
  const head = (await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  // Changes inside submodules cannot be captured by a superproject tree.
  const v2 = await git(cwd, ["status", "--porcelain=v2", "-z", "--ignore-submodules=none", "--untracked-files=no"]);
  if (v2.split("\0").some(entry => /^[12] \S\S S(?!\.\.\.)/u.test(entry)))
    throw new Error("A submodule has local changes that cannot be archived; commit or remove them inside the submodule first.");
  let commit = head;
  const snapshot = worktree.status.modified.length > 0 || worktree.status.untracked.length > 0;
  if (snapshot) {
    const scratch = await mkdtemp(join(tmpdir(), "timber-archive-"));
    try {
      const env = { GIT_INDEX_FILE: join(scratch, "index") };
      await git(cwd, ["read-tree", "HEAD"], env);
      await git(cwd, ["add", "--all", "--", ":/"], env);
      const tree = (await git(cwd, ["write-tree"], env)).trim();
      commit = (await git(cwd, ["commit-tree", tree, "-p", head, "-m",
        `timber arena pick: uncommitted work of ${label}`], identity)).trim();
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  const base = `refs/timber/arena/${arena}/${label}`;
  for (let attempt = 1; attempt <= 100; attempt++) {
    const ref = attempt === 1 ? base : `${base}-${attempt}`;
    const existing = await resolveRef(repository, ref);
    if (existing === commit) return { ref, commit, snapshot };
    if (existing !== null) continue;
    // Empty old value: create only, never replace an archive written meanwhile.
    const created = await execa(gitCommand(), ["update-ref", "-m", "timber arena pick", ref, commit, ""], {
      cwd: repository.primaryWorktreeRoot, stdin: "ignore", reject: false, timeout: 8000,
    });
    if (created.exitCode === 0 && await resolveRef(repository, ref) === commit) return { ref, commit, snapshot };
  }
  throw new Error(`Could not create an archive ref under ${base}; inspect refs/timber/arena.`);
}
