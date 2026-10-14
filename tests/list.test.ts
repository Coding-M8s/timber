import { expect, test } from "bun:test";
import { runCli, placeholderHandlers } from "../src/cli";
import { createListHandler } from "../src/commands/list";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CommandServices } from "../src/services";
import type { Worktree } from "../src/types";

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
  expect(result.stdout).toContain("WORKFLOW  STATUS");
  expect(result.stdout).toMatch(/primary\s+main\s+-\s+clean\s+\/repo\n/);
  expect(result.stdout).toMatch(/linked\s+\(detached HEAD\)\s+-\s+clean\s+\/manual tree\n/);
  expect(result.stdout).toMatch(/linked\s+feature\/z\s+-\s+dirty \(2 modified, 1 untracked\); 1 ignored\s+\/repo-worktrees\/z-last\n/);
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

test("untracked files make a worktree dirty while ignored files remain explicitly visible", async () => {
  const result = await list([
    worktreeFixture({ status: { kind: "known", modified: [], untracked: ["new"], ignored: [] } }),
    worktreeFixture({ path: "/ignored", isPrimary: false,
      status: { kind: "known", modified: [], untracked: [], ignored: [".env", ".env"] } }),
  ]);
  expect(result.stdout).toContain("dirty (0 modified, 1 untracked)");
  expect(result.stdout).toContain("clean; 1 ignored");
  expect(result.exitCode).toBe(0);
});

test("control characters in paths and status reasons cannot forge additional rows", async () => {
  const result = await list([worktreeFixture({ path: "/repo\nforged\tpath\u001b[31m",
    status: { kind: "unknown", reason: "failure\nforged" } })]);
  expect(result.stdout).toMatch(/WORKTREE\s+BRANCH\s+WORKFLOW\s+STATUS\s+PATH\n/);
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

test("list shows assigned workflows in aligned columns and preserves all rows", async () => {
  const trees = [worktreeFixture(), worktreeFixture({ path: "/wide/界", branch: "review", isPrimary: false })];
  const result = await list(trees, {
    readWorkflowAssociation: async (_repo, tree) => tree.isPrimary
      ? { kind: "unassigned" } : { kind: "assigned", name: "review" },
  });
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("WORKFLOW");
  expect(lines[1]).toContain("-");
  expect(lines[2]).toContain("review");
  expect(lines[0]!.indexOf("WORKFLOW")).toBe(lines[1]!.indexOf("-"));
  expect(lines[0]!.indexOf("WORKFLOW")).toBe(lines[2]!.lastIndexOf("review"));
});

test("list shows a saved name even when its definition is missing", async () => {
  const result = await list([worktreeFixture()], {
    readWorkflowAssociation: async () => ({ kind: "assigned", name: "retired" }),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/primary\s+main\s+retired\s+clean\s+\/repo\n/);
});

test("list keeps every Git row when an association is malformed or stale", async () => {
  const result = await list([
    worktreeFixture(),
    worktreeFixture({ path: "/repo-worktrees/feature", branch: "feature", isPrimary: false }),
  ], {
    readWorkflowAssociation: async (_repo, tree) => tree.isPrimary
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
