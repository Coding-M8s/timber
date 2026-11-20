import { expect, test } from "bun:test";
import { runCli, placeholderHandlers } from "../src/cli";
import { createListHandler } from "../src/commands/list";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CommandServices } from "../src/services";
import type { Worktree } from "../src/types";
import type { BaseAssociationRead } from "../src/git/base-metadata";
import { expectColumnPositions } from "./helpers/columns";

async function list(trees: readonly Worktree[], overrides: Partial<CommandServices> = {}) {
  const repository = repositoryFixture({ currentWorktreeRoot: "/repo-worktrees/feature" });
  let stdout = "";
  let stderr = "";
  const services = createServiceDouble({
    discoverRepository: async cwd => {
      expect(cwd).toBe("/repo-worktrees/feature/nested");
      return repository;
    },
    loadConfig: async () => ({ baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null }),
    listWorktrees: async context => {
      expect(context).toBe(repository);
      return trees;
    },
    ...overrides,
  });
  const exitCode = await runCli(["ls"], {
    context: {
      cwd: "/repo-worktrees/feature/nested",
      io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
    },
    handlers: { ...placeholderHandlers, list: createListHandler(services) },
  });
  return { exitCode, stdout, stderr };
}

test("list marks the primary, shows branches and paths, and deduplicates Git status counts", async () => {
  const trees = [
    worktreeFixture({ path: "/repo-worktrees/z-last", branch: "feature/z", isPrimary: false,
      status: { kind: "known", modified: ["one", "one", "two"], untracked: ["new", "new"], ignored: [".env"] } }),
    worktreeFixture(),
    worktreeFixture({ path: "/manual tree", branch: null, isPrimary: false }),
  ];
  const result = await list(trees);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("WORKTREE  ");
  expect(result.stdout).toContain("BASE  STATUS");
  expect(result.stdout).not.toContain("WORKFLOW");
  expect(result.stdout).toMatch(/primary\s+main\s+-\s+clean\s+\/repo\n/);
  expect(result.stdout).toMatch(/linked\s+\(detached HEAD\)\s+-\s+clean\s+\/manual tree\n/);
  expect(result.stdout).toMatch(/linked\s+feature\/z\s+-\s+dirty \(2 modified, 1 untracked\)\s+\/repo-worktrees\/z-last\n/);
  expect(trees[0]?.path).toBe("/repo-worktrees/z-last");
});

test("unknown, missing, locked, and prunable rows remain visible without looking clean", async () => {
  const result = await list([
    worktreeFixture({ path: "/missing", branch: null, isPrimary: false, pathExists: false,
      prunable: { reason: "metadata is stale" }, status: { kind: "unknown", reason: "path missing" } }),
    worktreeFixture({ locked: { reason: "private lock reason" },
      status: { kind: "unknown", reason: "cannot read status" } }),
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/primary\s+main\s+-\s+unknown \(cannot read status\); locked\s+\/repo\n/);
  expect(result.stdout).toMatch(/linked\s+\(detached HEAD\)\s+-\s+unknown \(path missing\); missing; prunable\s+\/missing\n/);
});

test("untracked files make a worktree dirty and ignored files never affect the listing", async () => {
  const result = await list([
    worktreeFixture({ status: { kind: "known", modified: [], untracked: ["new"], ignored: [] } }),
    worktreeFixture({ path: "/ignored", isPrimary: false,
      status: { kind: "known", modified: [], untracked: [], ignored: [".env", ".env"] } }),
  ]);
  expect(result.stdout).toContain("dirty (0 modified, 1 untracked)");
  expect(result.stdout).toMatch(/linked\s+main\s+-\s+clean\s+\/ignored\n/);
  expect(result.stdout).not.toMatch(/\d ignored/);
  expect(result.exitCode).toBe(0);
});

test("list asks for worktree status without ignored files", async () => {
  const requests: unknown[] = [];
  const result = await list([], {
    listWorktrees: async (_repository, options) => { requests.push(options?.includeIgnored); return []; },
  });
  expect(result.exitCode).toBe(0);
  expect(requests).toEqual([false]);
});

test("control characters in paths and status reasons cannot forge additional rows", async () => {
  const result = await list([worktreeFixture({ path: "/repo\nforged\tpath\u001b[31m",
    status: { kind: "unknown", reason: "failure\nforged" } })]);
  expect(result.stdout).toMatch(/WORKTREE\s+BRANCH\s+BASE\s+STATUS\s+PATH\n/);
  expect(result.stdout).toMatch(/primary\s+main\s+-\s+unknown \("failure\\nforged"\)\s+"\/repo\\nforged\\tpath\\u001b\[31m"\n/);
  expect(result.stderr).toBe("");
});

test("C1 terminal controls and Unicode line separators are escaped in displayed paths", async () => {
  const result = await list([worktreeFixture({ path: "/repo\u009b31m\u2028next\u2029row\u007f" })]);
  expect(result.stdout).toContain('"/repo\\u009b31m\\u2028next\\u2029row\\u007f"');
  expect(result.stdout).not.toMatch(/[\u007f-\u009f\u2028\u2029]/u);
});

test("empty inventory has a clear successful result", async () => {
  expect(await list([])).toEqual({ exitCode: 0, stdout: "No worktrees found.\n", stderr: "" });
});

test("list shows saved bases in aligned columns and preserves all rows", async () => {
  const trees = [worktreeFixture(), worktreeFixture({ path: "/wide/界", branch: "review", isPrimary: false })];
  const result = await list(trees, {
    readBaseAssociation: async (_repo, tree) => tree.isPrimary
      ? { kind: "unassigned" } : { kind: "assigned", ref: "refs/remotes/origin/main" },
  });
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]!.indexOf("BASE")).toBe(lines[1]!.indexOf("-"));
  expect(lines[0]!.indexOf("BASE")).toBe(lines[2]!.indexOf("origin/main"));
});

test("every list column aligns for full mixed status, Unicode, base, and escaped values", async () => {
  const trees = [
    worktreeFixture({ path: "/z flag 🇺🇸1️⃣", branch: "🇺🇸1️⃣", isPrimary: false,
      status: { kind: "known", modified: ["m", "m"], untracked: ["u"], ignored: ["i"] } }),
    worktreeFixture({ branch: "very-long-primary-branch-name" }),
    worktreeFixture({ path: "/a detached", branch: null, isPrimary: false }),
    worktreeFixture({ path: "/b 界e\u0301", branch: "界e\u0301", isPrimary: false,
      pathExists: false, locked: { reason: "lock" }, prunable: { reason: "prune" },
      status: { kind: "unknown", reason: "path missing" } }),
    worktreeFixture({ path: "/c\n\t\u001b[2J", branch: "control\nbranch", isPrimary: false,
      status: { kind: "unknown", reason: "failure\n\u001b[2J" } }),
  ];
  const before = structuredClone(trees);
  const result = await list(trees, {
    readBaseAssociation: async (_repo, tree) => tree.isPrimary
      ? { kind: "assigned", ref: "refs/heads/long_base_name" }
      : tree.path.startsWith("/b") ? { kind: "invalid", reason: "stale" }
      : tree.path.startsWith("/z") ? { kind: "assigned", ref: "refs/remotes/origin/main" } : { kind: "unassigned" },
  });
  const cells = [
    ["WORKTREE", "BRANCH", "BASE", "STATUS", "PATH"],
    ["primary", "very-long-primary-branch-name", "refs/heads/long_base_name", "clean", "/repo"],
    ["linked", "(detached HEAD)", "-", "clean", "/a detached"],
    ["linked", "界e\u0301", "?", "unknown (path missing); missing; locked; prunable", "/b 界e\u0301"],
    ["linked", '"control\\nbranch"', "-", 'unknown ("failure\\n\\u001b[2J")', '"/c\\n\\t\\u001b[2J"'],
    ["linked", "🇺🇸1️⃣", "origin/main", "dirty (1 modified, 1 untracked)", "/z flag 🇺🇸1️⃣"],
  ];
  const widths = cells.map(row => row.map(cell => cell.length));
  widths[3]![1] = 3;
  widths[3]![4] = 6;
  widths[5]![1] = 4;
  widths[5]![4] = 12;
  expect(result.exitCode).toBe(0);
  expectColumnPositions(result.stdout, cells, widths);
  expect(trees).toEqual(before);
  expect(result.stderr).toBe("warning: Cannot read base association for /b 界e\u0301 (stale); Git worktree remains listed.\n");
});

test("warnings follow sorted inventory regardless of metadata completion order", async () => {
  const trees = [worktreeFixture({ path: "/linked", isPrimary: false }), worktreeFixture()];
  async function run(reverse: boolean) {
    const records = trees.map(() => Promise.withResolvers<BaseAssociationRead>());
    const started = Promise.withResolvers<void>();
    let reads = 0;
    const pending = list(trees, {
      readBaseAssociation: (_repo, tree) => {
        if (++reads === 2) started.resolve();
        return records[tree.isPrimary ? 0 : 1]!.promise;
      },
    });
    await started.promise;
    for (const index of reverse ? [1, 0] : [0, 1]) {
      records[index]!.resolve({ kind: "invalid", reason: "stale" });
      await Promise.resolve();
    }
    return pending;
  }
  const forward = await run(false);
  const reverse = await run(true);
  expect(reverse).toEqual(forward);
  expect(reverse.stderr.split("\n").slice(0, -1)).toEqual([
    "warning: Cannot read base association for /repo (stale); Git worktree remains listed.",
    "warning: Cannot read base association for /linked (stale); Git worktree remains listed.",
  ]);
});

test.each([0, 3])("formatting %i worktrees uses only one collected inventory", async count => {
  const calls: string[] = [];
  const trees = Array.from({ length: count }, (_, index) => worktreeFixture({
    path: `/repo-${index}`, isPrimary: index === 0,
  }));
  const result = await list(trees, {
    discoverRepository: async () => { calls.push("discover"); return repositoryFixture(); },
    loadConfig: async () => {
      calls.push("config");
      return { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };
    },
    listWorktrees: async () => { calls.push("list"); return trees; },
    readBaseAssociation: async (_repo, tree) => { calls.push(tree.path); return { kind: "unassigned" }; },
  });
  expect(result.exitCode).toBe(0);
  expect(calls).toEqual(["discover", "config", "list", ...trees.map(tree => tree.path)]);
});

test("list keeps every Git row when an association is malformed or stale", async () => {
  const result = await list([
    worktreeFixture(),
    worktreeFixture({ path: "/repo-worktrees/feature", branch: "feature", isPrimary: false }),
  ], {
    readBaseAssociation: async (_repo, tree) => tree.isPrimary
      ? { kind: "invalid", reason: "malformed" } : { kind: "invalid", reason: "stale" },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/primary\s+main\s+\?\s+clean\s+\/repo\n/);
  expect(result.stdout).toMatch(/linked\s+feature\s+\?\s+clean\s+\/repo-worktrees\/feature\n/);
  expect(result.stderr).toContain("/repo (malformed)");
  expect(result.stderr).toContain("/repo-worktrees/feature (stale)");
});

for (const service of ["discoverRepository", "listWorktrees"] as const) {
  test(`${service} failure produces one error on stderr and no successful list`, async () => {
    expect(await list([], { [service]: async () => { throw new Error("Cannot read repository"); } })).toEqual({
      exitCode: 1, stdout: "", stderr: "error: Cannot read repository\n",
    });
  });
}
