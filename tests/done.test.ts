import { expect, test } from "bun:test";
import { placeholderHandlers, runCli } from "../src/cli";
import { createDoneHandler } from "../src/commands/done";
import type { TerminalChooser } from "../src/selection";
import type { CommandServices } from "../src/services";
import type { CleanupOptions, OpenTarget, RepositoryConfig, Resolution } from "../src/types";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";

const repository = repositoryFixture({ currentWorktreeRoot: "/repo-worktrees/current" });
const config: RepositoryConfig = {
  baseBranch: "main", remote: null, worktreeDir: null,
  editor: { command: "editor", args: [], enabled: true }, agent: { enabled: true, command: "agent", args: [] },
};
const tree = worktreeFixture({ path: "/manual feature", branch: "feature/one", isPrimary: false });
const selected: Resolution<OpenTarget> = { kind: "found", value: { kind: "worktree", worktree: tree } };

async function invoke(services: CommandServices, args = ["done", "feature/one"], choose?: TerminalChooser) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    handlers: { ...placeholderHandlers, done: createDoneHandler(services) },
    context: {
      cwd: "/repo-worktrees/current/nested",
      ...(choose ? { choose } : {}),
      io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
    },
  });
  return { exitCode, stdout, stderr };
}

function services(overrides: Partial<CommandServices> = {}) {
  return createServiceDouble({
    discoverRepository: async () => repository,
    loadConfig: async () => config,
    resolveOpenTarget: async () => selected,
    ...overrides,
  });
}

test.each([
  [[], { keepBranch: false, discardIgnored: true }],
  [["--keep-branch"], { keepBranch: true, discardIgnored: true }],
  [["--discard-ignored"], { keepBranch: false, discardIgnored: true }],
  [["--keep-branch", "--discard-ignored"], { keepBranch: true, discardIgnored: true }],
  [["--keep-ignored"], { keepBranch: false, discardIgnored: false }],
  [["--keep-branch", "--keep-ignored"], { keepBranch: true, discardIgnored: false }],
  [["--base", "feature/parent"], { keepBranch: false, discardIgnored: true, base: "feature/parent" }],
] satisfies [string[], CleanupOptions][])("done passes cleanup options %j and reports the verified result", async (flags, options) => {
  const order: string[] = [];
  const result = await invoke(services({
    discoverRepository: async cwd => {
      order.push("discover");
      expect(cwd).toBe("/repo-worktrees/current/nested");
      return repository;
    },
    loadConfig: async actual => { order.push("config"); expect(actual).toBe(repository); return config; },
    resolveOpenTarget: async (actual, input, loaded, resolveOptions) => {
      order.push("resolve");
      expect(actual).toBe(repository);
      expect(input).toBe("feature/one");
      expect(loaded).toBe(config);
      expect(resolveOptions).toEqual({ assertOpenable: false });
      return selected;
    },
    cleanupWorktree: async (actual, worktree, loaded, actualOptions) => {
      order.push("cleanup");
      expect(actual).toBe(repository);
      expect(worktree).toBe(tree);
      expect(loaded).toBe(config);
      expect(actualOptions).toEqual(options);
      return options.keepBranch
        ? { removedWorktreePath: "/verified removed", deletedLocalBranch: null, retainedLocalBranch: "verified/branch" }
        : { removedWorktreePath: "/verified removed", deletedLocalBranch: "verified/branch", retainedLocalBranch: null };
    },
  }), ["done", "feature/one", ...flags]);
  expect(order).toEqual(["discover", "config", "resolve", "cleanup"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Removed worktree at /verified removed");
  expect(result.stdout).toContain(options.keepBranch ? "Retained local branch verified/branch" : "Deleted local branch verified/branch");
});

test("done reports retained branches only from CleanupResult, never selection-time branch names", async () => {
  const result = await invoke(services({
    cleanupWorktree: async () => ({
      removedWorktreePath: tree.path,
      deletedLocalBranch: null,
      retainedLocalBranch: "verified/retained",
    }),
  }));
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Retained local branch verified/retained");
  expect(result.stdout).not.toContain("feature/one");
  expect(result.stdout).not.toContain("Deleted");
});

test("done streams hook output through the invoking command IO", async () => {
  const result = await invoke(services({ cleanupWorktree: async (_repository, _tree, _config, _options, io) => {
    io!.stdout("cleanup output\n");
    io!.stderr("cleanup warning\n");
    return { removedWorktreePath: tree.path, deletedLocalBranch: null, retainedLocalBranch: tree.branch };
  } }));
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toStartWith("cleanup output\nRemoved worktree");
  expect(result.stderr).toBe("cleanup warning\n");
});

test("detached cleanup reports only completed worktree removal", async () => {
  const detached = { ...tree, branch: null };
  const result = await invoke(services({
    resolveOpenTarget: async () => ({ kind: "found", value: { kind: "worktree", worktree: detached } }),
    cleanupWorktree: async () => ({
      removedWorktreePath: detached.path,
      deletedLocalBranch: null,
      retainedLocalBranch: null,
    }),
  }));
  expect(result).toEqual({ exitCode: 0, stdout: "Removed worktree at /manual feature\n", stderr: "" });
});

test("blank done input rejects before discovery while nonblank input is passed literally", async () => {
  const blank = await invoke(createServiceDouble(), ["done", " \t"]);
  expect(blank.exitCode).toBe(1);
  expect(blank.stdout).toBe("");
  expect(blank.stderr).toContain("Provide");
  const result = await invoke(services({
    resolveOpenTarget: async (_repository, input) => { expect(input).toBe(" /manual feature "); return selected; },
    cleanupWorktree: async () => ({
      removedWorktreePath: tree.path,
      deletedLocalBranch: null,
      retainedLocalBranch: "feature/one",
    }),
  }), ["done", " /manual feature "]);
  expect(result.exitCode).toBe(0);
});

test("unknown, unchecked local, and remote-only targets reject without cleanup or creation", async () => {
  const resolutions: Resolution<OpenTarget>[] = [
    { kind: "not-found" },
    { kind: "found", value: { kind: "branch", branch: { kind: "local", name: "feature/one", ref: "refs/heads/feature/one", upstream: null } } },
    { kind: "found", value: { kind: "branch", branch: { kind: "remote", remote: "backup", name: "feature/one", ref: "refs/remotes/backup/feature/one" } } },
  ];
  for (const resolution of resolutions) {
    const result = await invoke(services({ resolveOpenTarget: async () => resolution }));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(resolution.kind === "not-found" ? "matches" : "no registered worktree");
    expect(result.stderr).not.toContain("Unexpected service call");
  }
});

test("done refuses the primary worktree before the cleanup boundary", async () => {
  const result = await invoke(services({
    resolveOpenTarget: async () => ({ kind: "found", value: { kind: "worktree", worktree: worktreeFixture() } }),
  }));
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("primary");
  expect(result.stderr).not.toContain("Unexpected service call");
});

test("ambiguity lists only registered worktrees and gives exact selectors without guessing", async () => {
  const result = await invoke(services({
    resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: [
      { kind: "worktree", worktree: { ...tree, path: "/z path", branch: "TIM-42-last" } },
      { kind: "branch", branch: { kind: "local", name: "backup/TIM-42", ref: "refs/heads/backup/TIM-42", upstream: null } },
      { kind: "worktree", worktree: { ...tree, path: "/a path", branch: "TIM-42-first" } },
      { kind: "branch", branch: { kind: "remote", remote: "backup", name: "TIM-42", ref: "refs/remotes/backup/TIM-42" } },
    ] }),
  }), ["done", "TIM-42"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("multiple");
  expect(result.stderr).toContain("exact branch name or absolute worktree path");
  for (const identity of ["/a path", "/z path"]) {
    expect(result.stderr).toContain(identity);
  }
  expect(result.stderr).not.toContain("refs/heads/backup/TIM-42");
  expect(result.stderr).not.toContain("refs/remotes/backup/TIM-42");
  expect(result.stderr.indexOf("/a path")).toBeLessThan(result.stderr.indexOf("/z path"));
  expect(result.stderr).not.toContain("Unexpected service call");
});

for (const seam of ["discoverRepository", "loadConfig", "resolveOpenTarget", "cleanupWorktree"] as const) {
  test(`done reports ${seam} failure once without claiming success`, async () => {
    const result = await invoke(services({ [seam]: async () => { throw new Error("operation failed"); } }));
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "error: operation failed\n" });
  });
}

test.each(["choose", "cancel", "invalid", "changed"] as const)("done chooser %s validates selection before cleanup", async scenario => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({ ...tree, path: `/tree-${index}`, branch: `TIM-42-${index}` }));
  let cleaned: string | undefined;
  let resolutions = 0;
  const result = await invoke(services({
    loadConfig: async () => ({ ...config, hooks: { postCreate: [], preDelete: ["exit 99"] } }),
    resolveOpenTarget: async (_repo, input, _config, options) => {
      expect(options).toEqual({ assertOpenable: false });
      resolutions++;
      if (input === "TIM-42") return { kind: "ambiguous", candidates: candidates.map(worktree => ({ kind: "worktree", worktree })) };
      expect(input).toBe("/tree-6");
      return scenario === "changed" ? { kind: "not-found" } : { kind: "found", value: { kind: "worktree", worktree: candidates[6]! } };
    },
    cleanupWorktree: async (_repo, worktree) => {
      cleaned = worktree.path;
      return { removedWorktreePath: worktree.path, deletedLocalBranch: worktree.branch, retainedLocalBranch: null };
    },
  }), ["done", "TIM-42"], async (_message, choices) => {
    expect(cleaned).toBeUndefined();
    expect(choices).toHaveLength(8);
    return scenario === "cancel" ? null : scenario === "invalid" ? "/unknown" : "/tree-6";
  });
  expect(result.exitCode).toBe(scenario === "choose" || scenario === "cancel" ? 0 : 1);
  expect(cleaned).toBe(scenario === "choose" ? "/tree-6" : undefined);
  expect(resolutions).toBe(scenario === "choose" || scenario === "changed" ? 2 : 1);
  if (scenario === "cancel") expect(result).toEqual({ exitCode: 0, stdout: "Cancelled.\n", stderr: "" });
});

test("done without a chooser caps worktree matches at five and reports the total", async () => {
  const result = await invoke(services({
    resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: Array.from({ length: 8 }, (_, index) => ({
      kind: "worktree", worktree: { ...tree, path: `/tree-${index}`, branch: `TIM-42-${index}` },
    })) }),
  }), ["done", "TIM-42"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("8; showing 5");
  expect(result.stderr).toContain("/tree-4");
  expect(result.stderr).not.toContain("/tree-5");
});

test("done safely displays terminal controls in results and service diagnostics", async () => {
  const path = "/manual\n\u001b[31m\u009b\u2028feature";
  const successful = await invoke(services({
    cleanupWorktree: async () => ({
      removedWorktreePath: path,
      deletedLocalBranch: "feature/one",
      retainedLocalBranch: null,
    }),
  }));
  expect(successful.exitCode).toBe(0);
  expect(successful.stdout).toContain('"/manual\\n\\u001b[31m\\u009b\\u2028feature"');
  expect(successful.stdout.split("\n")).toHaveLength(3);
  const failed = await invoke(services({ cleanupWorktree: async () => { throw new Error(`cannot remove ${path}`); } }));
  expect(failed.exitCode).toBe(1);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).toContain("/manual\\n\\u001b[31m\\u009b\\u2028feature");
  expect(failed.stderr.split("\n")).toHaveLength(2);
});


test("done rejects contradictory ignored-file options before cleanup", async () => {
  const result = await invoke(services(), ["done", "feature/one", "--keep-ignored", "--discard-ignored"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/conflict|combine/i);
});

for (const choice of ["delete", "cancel", null]) test(`done discard confirmation handles ${choice}`, async () => {
  const result = await invoke(services({ cleanupWorktree: async (_repo, _tree, _config, _options, _io, confirm) => {
    expect(confirm).toBeDefined();
    if (!await confirm!("Unpublished local commits would be lost.")) {
      const { CleanupCancelled } = await import("../src/git/cleanup-discard");
      throw new CleanupCancelled();
    }
    return { removedWorktreePath: tree.path, deletedLocalBranch: tree.branch, retainedLocalBranch: null };
  } }), ["done", "feature/one"], async (message, choices) => {
    expect(message).toContain("Delete anyway");
    expect(message).toContain("modified and untracked");
    expect(choices[0]).toMatchObject({ value: "cancel", default: true });
    return choice;
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("Unpublished local commits would be lost.");
  expect(result.stdout).toContain(choice === "delete" ? "Removed worktree" : "Cancelled.");
  if (choice !== "delete") expect(result.stdout).not.toContain("Deleted local branch");
});

test("noninteractive done supplies no discard confirmation", async () => {
  const result = await invoke(services({ cleanupWorktree: async (_repo, _tree, _config, _options, _io, confirm) => {
    expect(confirm).toBeUndefined();
    throw new Error("Cannot preserve local commits.");
  } }));
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
});

test("done reports retained backups after cleanup and never fails cleanup over a backup read", async () => {
  const cleanupWorktree = async () => ({ removedWorktreePath: tree.path, deletedLocalBranch: "feature/one", retainedLocalBranch: null });
  const reported = await invoke(services({
    cleanupWorktree,
    retainedBackups: async (actual, path) => {
      expect(actual).toBe(repository);
      expect(path).toBe(tree.path);
      return [{ id: "20261115T090807Z-0123abcd", detail: "1.0 KiB, expires 2026-11-22T09:08:07.000Z" }];
    },
  }));
  expect(reported.exitCode).toBe(0);
  expect(reported.stdout).toContain("Kept 1 recovery backup of this worktree:\n  20261115T090807Z-0123abcd (1.0 KiB, expires 2026-11-22T09:08:07.000Z)\n");
  expect(reported.stdout).toContain("keep one with timber backup keep <id>");
  expect(reported.stdout).toContain("can still contain copies of ignored files");

  const none = await invoke(services({ cleanupWorktree, retainedBackups: async () => [] }));
  expect(none.stdout).toBe("Removed worktree at /manual feature\nDeleted local branch feature/one\n");

  const unreadable = await invoke(services({ cleanupWorktree, retainedBackups: async () => { throw new Error("unreadable"); } }));
  expect(unreadable.exitCode).toBe(0);
  expect(unreadable.stdout).toContain("Could not check for recovery backups of this worktree; review them with timber backup list.");
  expect(unreadable.stderr).toBe("");
});
