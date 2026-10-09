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
  expect(await list(trees)).toEqual({
    exitCode: 0, stderr: "",
    stdout: "WORKTREE\tBRANCH\tSTATUS\tPATH\n" +
      "primary\tmain\tclean\t/repo\n" +
      "linked\t(detached HEAD)\tclean\t/manual tree\n" +
      "linked\tfeature/z\tdirty (2 modified, 1 untracked); 1 ignored\t/repo-worktrees/z-last\n",
  });
  expect(trees[0]?.path).toBe("/repo-worktrees/z-last");
});

test("unknown, missing, locked, and prunable rows remain visible without looking clean", async () => {
  const result = await list([
    worktreeFixture({ path: "/missing", branch: null, isPrimary: false, pathExists: false,
      prunable: { reason: "metadata is stale" }, status: { kind: "unknown", reason: "path missing" } }),
    worktreeFixture({ locked: { reason: "private lock reason" },
      status: { kind: "unknown", reason: "cannot read status" } }),
  ]);
  expect(result).toEqual({
    exitCode: 0, stderr: "",
    stdout: "WORKTREE\tBRANCH\tSTATUS\tPATH\n" +
      "primary\tmain\tunknown (cannot read status); locked\t/repo\n" +
      "linked\t(detached HEAD)\tunknown (path missing); missing; prunable\t/missing\n",
  });
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
  expect(result.stdout).toBe("WORKTREE\tBRANCH\tSTATUS\tPATH\n" +
    'primary\tmain\tunknown ("failure\\nforged")\t"/repo\\nforged\\tpath\\u001b[31m"\n');
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

for (const service of ["discoverRepository", "listWorktrees"] as const) {
  test(`${service} failure produces one error on stderr and no successful list`, async () => {
    expect(await list([], { [service]: async () => { throw new Error("Cannot read repository"); } })).toEqual({
      exitCode: 1, stdout: "", stderr: "error: Cannot read repository\n",
    });
  });
}
