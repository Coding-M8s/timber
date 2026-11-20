import { expect, mock, test } from "bun:test";
import { runCli } from "../src/cli";
import { createBaseHandler } from "../src/commands/base";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CommandContext, CommandServices } from "../src/services";
import type { OpenTarget, RepositoryConfig } from "../src/types";

const repository = repositoryFixture();
const config: RepositoryConfig = { baseBranch: "main", remote: "origin", worktreeDir: null,
  editor: { command: "must-not-run", args: [], enabled: true }, agent: { command: "must-not-run", args: [], enabled: true },
  hooks: { postCreate: ["must-not-run"] } };
const tree = worktreeFixture({ path: "/repo/feature", branch: "GH-186-feature", isPrimary: false });
const found = (path = tree.path): OpenTarget => ({ kind: "worktree", worktree: { ...tree, path } });

function harness(overrides: Partial<CommandServices>, choose?: CommandContext["choose"]) {
  let stdout = "", stderr = "";
  const services = createServiceDouble({ discoverRepository: async () => repository, loadConfig: async () => config,
    resolveOpenTarget: async () => ({ kind: "found", value: found() }), ...overrides });
  const context: CommandContext = { cwd: "/repo", io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
    ...(choose === undefined ? {} : { choose }) };
  const invoke = (args: string[]) => runCli(args, { context, handlers: { base: createBaseHandler(services),
    setup: async () => {}, new: async () => {}, open: async () => {}, list: async () => {}, done: async () => {} } });
  return { invoke, output: () => ({ stdout, stderr }) };
}

test("base passes the worktree's own branch to the shared resolver and saves its canonical ref", async () => {
  const select = mock(async () => ({ ref: "refs/remotes/origin/main", commit: "b".repeat(40), local: false }));
  const write = mock(async () => {});
  const h = harness({ selectBaseRef: select, writeBaseAssociation: write });
  expect(await h.invoke(["base", tree.path, "--set", "main"])).toBe(0);
  expect(select).toHaveBeenCalledWith(repository, config, "main", tree.path, tree.branch, { flag: "--set", stopped: "The base was not changed." });
  expect(write).toHaveBeenCalledWith(repository, tree, "refs/remotes/origin/main");
});

test("base never offers a chooser for ambiguous input and changes nothing", async () => {
  const choose = mock(async () => "/repo/a");
  const write = mock(async () => {});
  const clear = mock(async () => {});
  const h = harness({ resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: [found("/repo/b"), found("/repo/a")] }),
    writeBaseAssociation: write, clearBaseAssociation: clear }, choose);
  expect(await h.invoke(["base", "GH-186", "--clear"])).toBe(1);
  expect(h.output().stderr).toContain("matches 2 worktrees");
  expect(choose).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

test("a stale saved base may be replaced or cleared", async () => {
  const clear = mock(async () => {});
  const h = harness({ readBaseAssociation: async () => ({ kind: "invalid", reason: "stale" }), clearBaseAssociation: clear });
  expect(await h.invoke(["base", tree.path, "--clear"])).toBe(0);
  expect(clear).toHaveBeenCalledTimes(1);
  expect(h.output().stdout).toContain("(was invalid (stale))");
});
