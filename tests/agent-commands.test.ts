import { expect, test } from "bun:test";
import { runCli, placeholderHandlers } from "../src/cli";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CommandServices } from "../src/services";
import type { AgentResult, EditorResult, RepositoryConfig } from "../src/types";

const repository = repositoryFixture();
const worktree = worktreeFixture({ path: "/repo linked", isPrimary: false, branch: "feature" });
const config: RepositoryConfig = {
  baseBranch: null, remote: null, worktreeDir: null, editor: null,
  agent: { command: "codex", args: ["--literal"], enabled: true },
};

async function invoke(
  command: "new" | "open", {
    flags = [] as string[], interactive = true, loaded = config,
    editor = { kind: "skipped" } as EditorResult,
    agent = { kind: "exited", exitCode: 0, signal: null } as AgentResult,
    overrides = {} as Partial<CommandServices>, materialize = false,
  } = {},
) {
  const calls: string[] = [];
  let stdout = "", stderr = "";
  const services = createServiceDouble({
    discoverRepository: async () => { calls.push("discover"); return repository; },
    loadConfig: async () => { calls.push("config"); return loaded; },
    resolveBase: async () => { calls.push("base"); return { ref: "refs/heads/main", commit: "a".repeat(40), source: "fallback" }; },
    resolveOpenTarget: async () => {
      calls.push("resolve");
      return { kind: "found", value: materialize
        ? { kind: "branch", branch: { kind: "local", name: "feature", ref: "refs/heads/feature", upstream: null } }
        : { kind: "worktree", worktree } };
    },
    createWorktree: async () => { calls.push("create"); return worktree; },
    runSetup: async () => { calls.push("setup"); },
    launchEditor: async (_tree, _config, disabled) => {
      calls.push("editor");
      if (flags.includes("--no-editor")) expect(disabled).toBe(true);
      return editor;
    },
    launchAgent: async (tree, selected) => {
      calls.push("agent");
      expect(tree).toBe(worktree);
      expect(selected).toBe(loaded.agent);
      expect(stdout).toContain(worktree.path);
      return agent;
    },
    ...overrides,
  });
  const exitCode = await runCli([command, "feature", ...flags], {
    context: { cwd: "/repo/nested", interactive, io: {
      stdout: value => { stdout += value; }, stderr: value => { stderr += value; },
    } },
    handlers: { ...placeholderHandlers,
      new: createNewHandler(services), open: createOpenHandler(services),
    },
  });
  return { exitCode, stdout, stderr, calls };
}

for (const command of ["new", "open"] as const) {
  test(`${command} awaits agent after setup/editor and reports workspace first`, async () => {
    const result = await invoke(command, {
      flags: ["--no-editor"],
      loaded: { ...config, hooks: { postCreate: ["setup"] } },
      materialize: command === "open",
    });
    expect(result.calls).toEqual(command === "new"
      ? ["discover", "config", "base", "create", "setup", "editor", "agent"]
      : ["discover", "config", "resolve", "create", "setup", "editor", "agent"]);
    expect(result.exitCode).toBe(0);
  });
  test(`${command} explicit enable overrides disabled config`, async () => {
    const result = await invoke(command, { flags: ["--agent"], loaded: {
      ...config, agent: { ...config.agent!, enabled: false },
    } });
    expect(result.calls.at(-1)).toBe("agent");
    expect(result.exitCode).toBe(0);
  });
  test(`${command} skips disabled/unconfigured/unattended agents`, async () => {
    for (const options of [
      { flags: ["--no-agent"] }, { interactive: false },
      { loaded: { ...config, agent: null } },
      { loaded: { ...config, agent: { ...config.agent!, enabled: false } } },
    ]) {
      const result = await invoke(command, options);
      expect(result.calls).not.toContain("agent");
      expect(result.exitCode).toBe(0);
    }
  });
  test(`${command} explicit agent preflight rejects before Git mutation`, async () => {
    for (const options of [{ interactive: false }, { loaded: { ...config, agent: null } }]) {
      const result = await invoke(command, { ...options, flags: ["--agent"] });
      expect(result.exitCode).toBe(1);
      expect(result.calls).toEqual(["discover", "config"]);
      expect(result.stdout).toBe("");
    }
  });
  test(`${command} noninteractive generic editor skips implicit agents and explains explicit rejection`, async () => {
    const loaded = { ...config, editor: { command: "zed", args: [], enabled: true } };
    const implicit = await invoke(command, { loaded, interactive: false, materialize: true });
    expect(implicit.exitCode).toBe(0);
    expect(implicit.calls).not.toContain("agent");
    const explicit = await invoke(command, { loaded, interactive: false, flags: ["--agent"] });
    expect(explicit.exitCode).toBe(1);
    expect(explicit.calls).toEqual(["discover", "config"]);
    expect(explicit.stderr).toContain("or enable an editor terminal integration (Orca or VS Code)");
    expect(explicit.stderr).toContain("--no-agent");
  });
  test(`${command} preserves editor failure behavior and suppresses agent`, async () => {
    const result = await invoke(command, {
      editor: { kind: "failed", message: "editor failed", retryCommand: "retry" },
    });
    expect(result.exitCode).toBe(command === "new" ? 1 : 0);
    expect(result.calls).not.toContain("agent");
    expect(result.stderr).toContain("editor failed");
  });
  test(`${command} propagates agent failures exactly once and retains workspace`, async () => {
    for (const agent of [
      { kind: "exited", exitCode: 23, signal: null },
      { kind: "exited", exitCode: 130, signal: "SIGINT" },
      { kind: "failed", message: "agent failed; workspace retained", retryCommand: "retry-agent" },
    ] satisfies AgentResult[]) {
      const result = await invoke(command, { agent });
      expect(result.exitCode).toBe(agent.kind === "failed" ? 1 : agent.exitCode);
      expect(result.stdout).toContain(worktree.path);
      expect(result.stderr.match(/error:/g)).toHaveLength(1);
      expect(result.stderr).toMatch(/retain/i);
    }
  });
  test(`${command} never launches agent after Git/setup failure`, async () => {
    const overrides = command === "new"
      ? { resolveBase: async () => { throw new Error("base failed"); } }
      : { resolveOpenTarget: async () => { throw new Error("resolution failed"); } };
    const result = await invoke(command, { overrides });
    expect(result.exitCode).toBe(1);
    expect(result.calls).not.toContain("editor");
    expect(result.calls).not.toContain("agent");
  });
  test(`${command} setup failure suppresses editor and agent`, async () => {
    const result = await invoke(command, {
      loaded: { ...config, hooks: { postCreate: ["setup"] } },
      materialize: command === "open",
      overrides: { runSetup: async () => { throw new Error("setup failed"); } },
    });
    expect(result.exitCode).toBe(1);
    expect(result.calls).not.toContain("editor");
    expect(result.calls).not.toContain("agent");
  });
}

test("open materializes selected branch before editor and agent", async () => {
  const result = await invoke("open", { materialize: true });
  expect(result.calls).toEqual(["discover", "config", "resolve", "create", "editor", "agent"]);
  expect(result.exitCode).toBe(0);
});

test("open of an existing worktree with an enabled editor never implicitly launches an agent", async () => {
  const loaded = { ...config, editor: { command: "editor", args: [], enabled: true } };
  const implicit = await invoke("open", { loaded, editor: { kind: "launched" } });
  expect(implicit.calls).toEqual(["discover", "config", "resolve", "editor"]);
  expect(implicit.exitCode).toBe(0);
  const explicit = await invoke("open", { loaded, flags: ["--agent"], editor: { kind: "launched" } });
  expect(explicit.calls).toEqual(["discover", "config", "resolve", "editor", "agent"]);
  const editorOff = await invoke("open", { loaded, flags: ["--no-editor"] });
  expect(editorOff.calls).toEqual(["discover", "config", "resolve", "editor", "agent"]);
  const materialized = await invoke("open", { loaded, materialize: true, editor: { kind: "launched" } });
  expect(materialized.calls).toEqual(["discover", "config", "resolve", "create", "editor", "agent"]);
});
