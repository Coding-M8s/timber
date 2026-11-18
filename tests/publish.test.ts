import { expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { createPublishHandler } from "../src/commands/publish";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CommandContext, CommandServices } from "../src/services";
import type { OpenTarget, RepositoryConfig } from "../src/types";

const repository = repositoryFixture();
const config: RepositoryConfig = { baseBranch: "main", remote: "origin", worktreeDir: null,
  editor: { command: "must-not-run", args: [], enabled: true }, agent: { command: "must-not-run", args: [], enabled: true },
  hooks: { postCreate: ["must-not-run"] } };
const tree = worktreeFixture({ path: "/repo/feature", branch: "GH-154-feature", isPrimary: false });
const found = (path = tree.path): OpenTarget => ({ kind: "worktree", worktree: { ...tree, path } });
function harness(overrides: Partial<CommandServices> = {}, choose?: CommandContext["choose"]) {
  let stdout = "", stderr = "";
  const services = createServiceDouble({ discoverRepository: async () => repository, loadConfig: async () => config,
    resolveOpenTarget: async () => ({ kind: "found", value: found() }), publishWorktree: async () => 0, ...overrides });
  const context: CommandContext = { cwd: "/repo/nested", io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
    ...(choose === undefined ? {} : { choose }) };
  const invoke = (args = ["publish", "GH-154"]) => runCli(args, { context, handlers: { publish: createPublishHandler(services),
    setup: async () => {}, new: async () => {}, open: async () => {}, list: async () => {}, done: async () => {} } });
  return { invoke, context, output: () => ({ stdout, stderr }) };
}

test("publish selects one registered worktree without launch services and never pushes after cancellation", async () => {
  const publish = mock(async () => 0);
  const h = harness({ publishWorktree: publish });
  expect(await h.invoke(["publish", tree.path])).toBe(0);
  expect(publish).toHaveBeenCalledWith(repository, tree, config, h.context.io, undefined);

  const skipped = mock(async () => 0);
  const cancelled = harness({ resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: [found("/repo/b"), found("/repo/a")] }),
    publishWorktree: skipped }, async () => null);
  expect(await cancelled.invoke()).toBe(0);
  expect(cancelled.output().stdout).toBe("Cancelled.\n");
  expect(skipped).not.toHaveBeenCalled();
});

test("result-file ambiguity is a refusal with exact-selection guidance instead of an available chooser", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber publish "));
  try {
    const choose = mock(async () => "/repo/a");
    const publish = mock(async () => 0);
    // The record canonicalizes the common Git directory, so it has to exist.
    const h = harness({ discoverRepository: async () => ({ ...repository, commonGitDir: directory }),
      resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: [found("/repo/b"), found("/repo/a")] }),
      publishWorktree: publish }, choose);
    const output = join(directory, "result.json");
    expect(await h.invoke(["publish", "GH-154", "--result-file", output])).toBe(1);
    expect(choose).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    const data = JSON.parse(await readFile(output, "utf8"));
    expect(data).toMatchObject({ command: "publish", outcome: "failed", exitCode: 1, worktree: null, materialized: false,
      publish: { result: "refused", remote: null, upstream: null, pushedCommit: null } });
    expect(data.diagnostic).toContain("matches 2 worktrees");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
