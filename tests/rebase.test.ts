import { expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { createRebaseHandler } from "../src/commands/rebase";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CommandContext, CommandServices } from "../src/services";
import type { OpenTarget, RepositoryConfig } from "../src/types";

const repository = repositoryFixture();
const config: RepositoryConfig = { baseBranch: "main", remote: "origin", worktreeDir: null,
  editor: { command: "must-not-run", args: [], enabled: true }, agent: { command: "must-not-run", args: [], enabled: true },
  hooks: { postCreate: ["must-not-run"] } };
const tree = worktreeFixture({ path: "/repo/feature", branch: "TIM-28-feature", isPrimary: false });
const found = (path = tree.path): OpenTarget => ({ kind: "worktree", worktree: { ...tree, path } });
function harness(overrides: Partial<CommandServices> = {}, choose?: CommandContext["choose"]) {
  let stdout = "", stderr = "";
  const services = createServiceDouble({ discoverRepository: async () => repository, loadConfig: async () => config,
    resolveOpenTarget: async () => ({ kind: "found", value: found() }), rebaseWorktree: async () => 0, ...overrides });
  const context: CommandContext = { cwd: "/repo/nested", io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
    ...(choose === undefined ? {} : { choose }) };
  const invoke = (args = ["rebase", "TIM-28"]) => runCli(args, { context, handlers: { rebase: createRebaseHandler(services),
    setup: async () => {}, new: async () => {}, open: async () => {}, list: async () => {}, done: async () => {} } });
  return { invoke, context, output: () => ({ stdout, stderr }) };
}

test("rebase works without launch services and forwards explicit base without changing effective config", async () => {
  const rebase = mock(async () => 143);
  const h = harness({ rebaseWorktree: rebase });
  expect(await h.invoke(["rebase", tree.path, "--base", "backup/trunk"])).toBe(143);
  expect(rebase).toHaveBeenCalledWith(repository, tree, config, "backup/trunk", h.context.io);
  expect(config.baseBranch).toBe("main");
});

test("rebase cancellation and invalid selection never fetch or mutate", async () => {
  const choices: OpenTarget[] = [found("/repo/b"), found("/repo/a")];
  for (const selection of [null, "/repo/forged"]) {
    const rebase = mock(async () => 0);
    const h = harness({ resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: choices }), rebaseWorktree: rebase }, async () => selection);
    expect(await h.invoke()).toBe(selection === null ? 0 : 1);
    expect(rebase).not.toHaveBeenCalled();
    if (selection === null) expect(h.output().stdout).toBe("Cancelled.\n");
  }
});

test("rebase chooser filters branches and revalidates path, branch and tip", async () => {
  const resolver = mock(async (_repo, input) => input === "TIM-28"
    ? { kind: "ambiguous" as const, candidates: [found("/repo/b"), found("/repo/a"),
      { kind: "branch" as const, branch: { kind: "local" as const, name: "unchecked", ref: "refs/heads/unchecked", upstream: null } }] }
    : { kind: "found" as const, value: { kind: "worktree" as const, worktree: { ...tree, path: input, head: "b".repeat(40) } } });
  const rebase = mock(async () => 0);
  const h = harness({ resolveOpenTarget: resolver, rebaseWorktree: rebase }, async (_message, choices) => {
    expect(choices.map(choice => choice.value)).toEqual(["/repo/a", "/repo/b"]);
    return "/repo/b";
  });
  expect(await h.invoke()).toBe(1);
  expect(h.output().stderr).toContain("changed");
  expect(rebase).not.toHaveBeenCalled();
});

test("rebase noninteractive ambiguity shows only five sorted paths and full count", async () => {
  const h = harness({ resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: Array.from({ length: 7 }, (_, i) => found(`/repo/${i}`)) }) });
  expect(await h.invoke()).toBe(1);
  expect(h.output().stderr).toContain("7 worktrees (showing 5)");
  expect(h.output().stderr).toContain("/repo/0");
  expect(h.output().stderr).not.toContain("/repo/5");
});

test("one registered worktree wins over unchecked branches without prompting", async () => {
  const rebase = mock(async () => 0);
  const h = harness({ resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: [found(),
    { kind: "branch", branch: { kind: "local", name: "unchecked", ref: "refs/heads/unchecked", upstream: null } }] }), rebaseWorktree: rebase });
  expect(await h.invoke()).toBe(0);
  expect(rebase).toHaveBeenCalledTimes(1);
});

test("unchecked branches and missing targets cannot trigger rebase", async () => {
  for (const resolution of [{ kind: "not-found" as const }, { kind: "found" as const,
    value: { kind: "branch" as const, branch: { kind: "local" as const, name: "unchecked", ref: "refs/heads/unchecked", upstream: null } } }]) {
    const rebase = mock(async () => 0);
    const h = harness({ resolveOpenTarget: async () => resolution, rebaseWorktree: rebase });
    expect(await h.invoke()).toBe(1);
    expect(rebase).not.toHaveBeenCalled();
  }
});

test("result-file ambiguity fails with exact-selection guidance instead of opening an available chooser", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber rebase "));
  try {
    const choose = mock(async () => "/repo/a");
    const rebase = mock(async () => 0);
    // The record canonicalizes the common Git directory, so it has to exist.
    const h = harness({ discoverRepository: async () => ({ ...repository, commonGitDir: directory }),
      resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: [found("/repo/b"), found("/repo/a")] }),
      rebaseWorktree: rebase }, choose);
    const output = join(directory, "result.json");
    expect(await h.invoke(["rebase", "TIM-28", "--result-file", output])).toBe(1);
    expect(choose).not.toHaveBeenCalled();
    expect(rebase).not.toHaveBeenCalled();
    expect(h.output().stderr).toContain("Use an exact branch or absolute path");
    const data = JSON.parse(await readFile(output, "utf8"));
    expect(data).toMatchObject({ command: "rebase", outcome: "failed", exitCode: 1, worktree: null, materialized: false,
      rebase: { result: "refused", base: null, baseCommit: null, originalTip: null, conflicts: [], baseSaved: false } });
    expect(data.diagnostic).toContain("matches 2 worktrees");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
