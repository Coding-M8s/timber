import { expect, test } from "bun:test";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import type { CommandContext, EditorTerminalLaunch, NewOptions } from "../src/services";
import type { RepositoryConfig } from "../src/types";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";

const config: RepositoryConfig = { baseBranch: null, remote: null, worktreeDir: null,
  editor: { command: "orca-ide", args: [], enabled: true, integration: "orca" },
  agent: { command: "claude", args: [], enabled: true, waitForSetup: true }, hooks: { postCreate: ["ordinary"] },
  workflows: { review: { postCreate: ["workflow"], agent: { command: "codex", args: ["prompt"], waitForSetup: false } } } };
const ordinaryConfig = { ...config };
delete ordinaryConfig.workflows;
const ctx: CommandContext = { cwd: "/repo", interactive: true, io: { stdout: () => {}, stderr: () => {} } };
function harness(existing = false, loaded = config) {
  const calls: string[] = [];
  const launches: EditorTerminalLaunch[] = [];
  const services = createServiceDouble({ discoverRepository: async () => repositoryFixture(), loadConfig: async () => loaded,
    resolveBase: async () => ({ ref: "refs/heads/main", commit: "a".repeat(40), source: "fallback" }),
    resolveOpenTarget: async () => ({ kind: "found", value: existing ? { kind: "worktree", worktree: worktreeFixture() }
      : { kind: "branch", branch: { kind: "local", name: "feature", ref: "refs/heads/feature", upstream: null } } }),
    createWorktree: async () => { calls.push("create"); return worktreeFixture(); },
    runSetup: async () => { calls.push("foreground-setup"); },
    launchEditor: async () => { calls.push("generic-editor"); return { kind: "skipped" }; },
    launchAgent: async () => { calls.push("foreground-agent"); return { kind: "skipped" }; },
    launchEditorTerminals: async launch => { calls.push("editor-terminals"); launches.push(launch); } });
  return { services, calls, launches };
}

for (const command of ["new", "open"] as const) {
  test(`${command} creation hands selected workflow context to editor seam without foreground fallback`, async () => {
    const h = harness();
    const handler = command === "new" ? createNewHandler(h.services) : createOpenHandler(h.services);
    await handler("feature", { workflow: "review" }, ctx);
    expect(h.calls).toEqual(["create", "editor-terminals"]);
    expect(h.launches[0]).toMatchObject({ setup: true, workflowName: "review", workflowScripts: ["workflow"],
      agent: { command: "codex", args: ["prompt"], waitForSetup: false } });
  });
  test(`${command} --no-setup hands Orca no setup terminal and skips foreground setup`, async () => {
    const h = harness();
    const handler = command === "new" ? createNewHandler(h.services) : createOpenHandler(h.services);
    await handler("feature", { setup: false }, ctx);
    expect(h.calls).toEqual(["create", "editor-terminals"]);
    expect(h.launches[0]).toMatchObject({ setup: false });
    const foreground = harness();
    const plain = command === "new" ? createNewHandler(foreground.services) : createOpenHandler(foreground.services);
    await plain("feature", { editor: false, setup: false }, ctx);
    expect(foreground.calls).toEqual(["create", "generic-editor", "foreground-agent"]);
  });
  test(`${command} --no-editor retains sequential foreground behavior`, async () => {
    const h = harness();
    const handler = command === "new" ? createNewHandler(h.services) : createOpenHandler(h.services);
    await handler("feature", { editor: false }, ctx);
    expect(h.calls).toEqual(["create", "foreground-setup", "generic-editor", "foreground-agent"]);
    expect(h.launches).toHaveLength(0);
  });
  for (const workflow of [undefined, "review"]) for (const agent of [undefined, true]) {
    test(`${command} noninteractive Orca creation hands off ${agent ? "explicit" : "implicit"} ${workflow ?? "ordinary"} agent`, async () => {
      const h = harness(false, workflow ? config : ordinaryConfig);
      const handler = command === "new" ? createNewHandler(h.services) : createOpenHandler(h.services);
      await handler("feature", { ...(workflow ? { workflow } : {}), ...(agent ? { agent } : {}) }, { ...ctx, interactive: false });
      expect(h.calls).toEqual(["create", "editor-terminals"]);
      expect(h.launches[0]?.agent).toMatchObject(workflow
        ? { command: "codex", args: ["prompt"], waitForSetup: false }
        : { command: "claude", args: [], waitForSetup: true });
    });
  }
  test(`${command} noninteractive hosting follows workflow selection and explicit editor enable`, async () => {
    const workflowConfig: RepositoryConfig = { ...config, editor: { command: "zed", args: [], enabled: true },
      workflows: { review: { postCreate: [], editor: { command: "orca-ide", args: [], integration: "orca" },
        agent: { command: "codex", args: ["review"] } } } };
    const disabledConfig: RepositoryConfig = { ...ordinaryConfig, editor: { ...config.editor!, enabled: false } };
    const suppressedConfig: RepositoryConfig = { ...config, workflows: { quiet: { postCreate: [], editor: false } } };
    for (const [loaded, options] of [
      [workflowConfig, { workflow: "review", agent: true }],
      [workflowConfig, { workflow: "review" }],
      [disabledConfig, { editor: true, agent: true }],
      [suppressedConfig, { workflow: "quiet", editor: true, agent: true }],
    ] satisfies [RepositoryConfig, NewOptions][]) {
      const h = harness(false, loaded);
      const handler = command === "new" ? createNewHandler(h.services) : createOpenHandler(h.services);
      await handler("feature", options, { ...ctx, interactive: false });
      expect(h.calls).not.toContain("foreground-agent");
      expect(h.launches).toHaveLength(1);
      expect(h.launches[0]?.agent?.command).toBe(loaded === workflowConfig ? "codex" : "claude");
      expect(h.launches[0]?.config.editor).toMatchObject({ enabled: true, integration: "orca" });
    }
  });
  test(`${command} noninteractive agents require an effective Orca editor`, async () => {
    for (const [loaded, options] of [
      [{ ...ordinaryConfig, editor: { command: "zed", args: [], enabled: true } }, {}],
      [{ ...ordinaryConfig, editor: { ...config.editor!, enabled: false } }, {}],
      [ordinaryConfig, { editor: false }],
      [{ ...config, workflows: { review: { postCreate: [], editor: { command: "zed", args: [] } } } }, { workflow: "review" }],
      [{ ...config, workflows: { review: { postCreate: [], editor: false } } }, { workflow: "review" }],
    ] satisfies [RepositoryConfig, NewOptions][]) {
      const h = harness(false, loaded);
      const handler = command === "new" ? createNewHandler(h.services) : createOpenHandler(h.services);
      await expect(handler("feature", { ...options, agent: true }, { ...ctx, interactive: false })).rejects.toThrow(/interactive/);
      expect(h.calls).toEqual([]);
      await handler("feature", options, { ...ctx, interactive: false });
      expect(h.calls).not.toContain("foreground-agent");
      expect(h.launches).toHaveLength(0);
    }
  });
  test(`${command} noninteractive Orca still honors agent suppression and missing configuration`, async () => {
    const h = harness(false, ordinaryConfig);
    const handler = command === "new" ? createNewHandler(h.services) : createOpenHandler(h.services);
    await handler("feature", { agent: false }, { ...ctx, interactive: false });
    expect(h.launches[0]?.agent).toBeNull();
    const absent = harness(false, { ...ordinaryConfig, agent: null });
    const missingHandler = command === "new" ? createNewHandler(absent.services) : createOpenHandler(absent.services);
    await expect(missingHandler("feature", { agent: true }, { ...ctx, interactive: false })).rejects.toThrow(/Configure an agent/);
    expect(absent.calls).toEqual([]);
  });
}

test.each([false, true])("existing Orca open preserves explicit-only agent policy with interactive=%s", async interactive => {
  const context = { ...ctx, interactive };
  const h = harness(true);
  const open = createOpenHandler(h.services);
  await open("main", {}, context);
  expect(h.launches[0]).toMatchObject({ setup: false, agent: null });
  await open("main", { setup: true }, context);
  expect(h.launches[1]).toMatchObject({ setup: true, agent: null });
  await open("main", { agent: true }, context);
  expect(h.launches[2]).toMatchObject({ setup: false, agent: { command: "claude", waitForSetup: true } });
  await open("main", { agent: false }, context);
  expect(h.launches[3]?.agent).toBeNull();
});

test("handoff failures propagate without calling a foreground launcher", async () => {
  const h = harness();
  h.services.launchEditorTerminals = async () => { throw new Error("handoff failed; retained"); };
  await expect(createNewHandler(h.services)("feature", {}, ctx)).rejects.toThrow(/retained/);
  expect(h.calls).toEqual(["create"]);
});

test.each(["new", "open"] as const)(
  "%s with enabled VS Code uses generic window open, not editor terminals",
  async command => {
    const loaded: RepositoryConfig = {
      ...ordinaryConfig,
      editor: { command: "code", args: ["--new-window"], enabled: true },
      agent: { command: "claude", args: [], enabled: true },
    };
    const h = harness(false, loaded);
    const handler = command === "new" ? createNewHandler(h.services) : createOpenHandler(h.services);
    await handler("feature", {}, ctx);
    expect(h.calls).toEqual(["create", "foreground-setup", "generic-editor", "foreground-agent"]);
    expect(h.launches).toHaveLength(0);
  },
);

test.each(["new", "open"] as const)(
  "%s noninteractive VS Code never hosts an agent in editor terminals",
  async command => {
    const loaded: RepositoryConfig = {
      ...ordinaryConfig,
      editor: { command: "code", args: ["--new-window"], enabled: true },
      agent: { command: "claude", args: [], enabled: true },
    };
    const h = harness(false, loaded);
    const handler = command === "new" ? createNewHandler(h.services) : createOpenHandler(h.services);
    await expect(handler("feature", { agent: true }, { ...ctx, interactive: false }))
      .rejects.toThrow(/interactive/);
    expect(h.calls).toEqual([]);
    expect(h.launches).toHaveLength(0);
  },
);


test("noninteractive open uses the named workflow editor and agent for that invocation only", async () => {
  const loaded: RepositoryConfig = { ...config, editor: { command: "zed", args: [], enabled: true },
    workflows: { review: { postCreate: [], editor: { command: "orca-ide", args: [], integration: "orca" },
      agent: { command: "codex", args: ["saved review"] } } } };
  const h = harness(true, loaded);
  const open = createOpenHandler(h.services);
  await open("main", { agent: true, workflow: "review" }, { ...ctx, interactive: false });
  expect(h.launches[0]).toMatchObject({ setup: false, workflowName: "review",
    agent: { command: "codex", args: ["saved review"] } });
  await open("main", { workflow: "review" }, { ...ctx, interactive: false });
  expect(h.launches[1]?.agent).toBeNull();
  expect(h.calls).toEqual(["editor-terminals", "editor-terminals"]);
  // Nothing is remembered: a later plain open uses the ordinary editor.
  await open("main", {}, { ...ctx, interactive: false });
  expect(h.calls).toEqual(["editor-terminals", "editor-terminals", "generic-editor"]);
});

test.each(["new", "open"] as const)("%s noninteractive Orca handoff failure never falls back", async command => {
  const h = harness(false, ordinaryConfig);
  h.services.launchEditorTerminals = async launch => {
    expect(launch.agent?.command).toBe("claude");
    throw new Error("handoff failed; workspace retained");
  };
  const handler = command === "new" ? createNewHandler(h.services) : createOpenHandler(h.services);
  await expect(handler("feature", { agent: true }, { ...ctx, interactive: false })).rejects.toThrow(/workspace retained/);
  expect(h.calls).toEqual(["create"]);
});
