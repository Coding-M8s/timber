import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("unwritable installation marker does not reject CLI guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber-hint-failure-"));
  try {
    await writeFile(join(root, "blocked"), "file");
    let stderr = "";
    await showInstallationHint({ stdout: () => {}, stderr: text => { stderr += text; } }, { HOME: root, XDG_STATE_HOME: join(root, "blocked") });
    expect(stderr).toContain("Before using Timber");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const presence of [[false, false], [true, false], [false, true]] as const) {
  test(`normal command reminder follows human output and respects scoped presence ${presence}`, async () => {
    let stdout = ""; let stderr = ""; const order: string[] = [];
    const config = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };
    const services = createServiceDouble({ discoverRepository: async () => repositoryFixture(),
      loadCommandConfig: async () => ({ config, localExists: presence[0], globalExists: presence[1] }),
      listWorktrees: async () => [worktreeFixture()] });
    const handlers = { ...placeholderHandlers, list: createListHandler(services) };
    const context = { cwd: "/repo", io: { stdout: (text: string) => { stdout += text; order.push("out"); },
      stderr: (text: string) => { stderr += text; order.push("err"); } } };
    expect(await runCli(["ls"], { handlers, context })).toBe(0);
    if (!presence[0] && !presence[1]) {
      expect(stderr).toContain("No Timber settings found");
      expect(order.at(-1)).toBe("err");
      expect(await runCli(["ls"], { handlers, context })).toBe(0);
      expect(stderr.match(/No Timber settings found/g)).toHaveLength(2);
    } else expect(stderr).toBe("");
    expect(stdout).toContain("WORKTREE");
  });
}

test("invalid settings produce only the actionable config error", async () => {
  let stderr = "";
  const services = createServiceDouble({ discoverRepository: async () => repositoryFixture(),
    loadCommandConfig: async () => { throw new Error("Invalid TOML in /repo/.timber.toml"); } });
  expect(await runCli(["ls"], { handlers: { ...placeholderHandlers, list: createListHandler(services) },
    context: { cwd: "/repo", io: { stdout: () => { throw new Error("unexpected listing"); }, stderr: text => { stderr += text; } } } })).toBe(1);
  expect(stderr).toContain("Invalid TOML");
  expect(stderr).not.toContain("No Timber settings");
});
