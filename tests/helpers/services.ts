import type { CommandServices } from "../../src/services";
import type { RepositoryContext, Worktree } from "../../src/types";

const unexpected = (name: keyof CommandServices) => async (): Promise<never> => {
  throw new Error(`Unexpected service call: ${name}`);
};

/** Override only what a test needs; accidental network/mutation paths fail closed. */
export function createServiceDouble(overrides: Partial<CommandServices> = {}): CommandServices {
  return {
    discoverRepository: unexpected("discoverRepository"),
    loadConfig: unexpected("loadConfig"),
    listWorktrees: unexpected("listWorktrees"),
    resolveBranch: unexpected("resolveBranch"),
    resolveBase: unexpected("resolveBase"),
    resolveOpenTarget: unexpected("resolveOpenTarget"),
    createWorktree: unexpected("createWorktree"),
    inspectCleanup: unexpected("inspectCleanup"),
    cleanupWorktree: unexpected("cleanupWorktree"),
    launchEditor: unexpected("launchEditor"),
    runSetup: unexpected("runSetup"),
    ...overrides,
  };
}

export function repositoryFixture(overrides: Partial<RepositoryContext> = {}): RepositoryContext {
  return {
    currentWorktreeRoot: "/repo",
    primaryWorktreeRoot: "/repo",
    commonGitDir: "/repo/.git",
    currentBranch: "main",
    remotes: [],
    ...overrides,
  };
}

export function worktreeFixture(overrides: Partial<Worktree> = {}): Worktree {
  return {
    path: "/repo", branch: "main", head: "a".repeat(40), isPrimary: true,
    pathExists: true, locked: null, prunable: null,
    status: { kind: "known", modified: [], untracked: [], ignored: [] },
    ...overrides,
  };
}
