import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showInstallationHint } from "../src/guidance";
import { createListHandler } from "../src/commands/list";
import { runCli, placeholderHandlers } from "../src/cli";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";

test("installation fallback appears once with a marker outside repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber-hint-"));
  const env = { HOME: root, XDG_STATE_HOME: join(root, "state") };
  let stderr = "";
  const io = { stdout: () => { throw new Error("success stream must stay clean"); }, stderr: (text: string) => { stderr += text; } };
  try {
    await showInstallationHint(io, env);
    await showInstallationHint(io, env);
    expect(stderr.match(/Before using Timber/g)).toHaveLength(1);
    expect(await readFile(join(root, "state/timber/setup-hint-shown"), "utf8")).toBe("1\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unwritable installation marker never turns a one-time hint into repeated noise", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber-hint-failure-"));
  try {
    await writeFile(join(root, "blocked"), "file");
    let stderr = "";
    await showInstallationHint({ stdout: () => {}, stderr: text => { stderr += text; } }, { HOME: root, XDG_STATE_HOME: join(root, "blocked") });
    await showInstallationHint({ stdout: () => {}, stderr: text => { stderr += text; } }, { HOME: root, XDG_STATE_HOME: join(root, "blocked") });
    expect(stderr).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ordinary commands remain quiet across invocations when settings are absent", async () => {
  let stdout = ""; let stderr = "";
  const config = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };
  const services = createServiceDouble({ discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => config, listWorktrees: async () => [worktreeFixture()] });
  const handlers = { ...placeholderHandlers, list: createListHandler(services) };
  const context = { cwd: "/repo", io: { stdout: (text: string) => { stdout += text; },
    stderr: (text: string) => { stderr += text; } } };
  expect(await runCli(["ls"], { handlers, context })).toBe(0);
  expect(await runCli(["ls"], { handlers, context })).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain("WORKTREE");
});

test("invalid settings produce only the actionable config error", async () => {
  let stderr = "";
  const services = createServiceDouble({ discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => { throw new Error("Invalid TOML in /repo/.timber.toml"); } });
  expect(await runCli(["ls"], { handlers: { ...placeholderHandlers, list: createListHandler(services) },
    context: { cwd: "/repo", io: { stdout: () => { throw new Error("unexpected listing"); }, stderr: text => { stderr += text; } } } })).toBe(1);
  expect(stderr).toContain("Invalid TOML");
  expect(stderr).not.toContain("No Timber settings");
});
