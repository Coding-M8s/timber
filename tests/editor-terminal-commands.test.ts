import { expect, test } from "bun:test";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import type { CommandContext, EditorTerminalLaunch } from "../src/services";
import type { RepositoryConfig } from "../src/types";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";

const config: RepositoryConfig = { baseBranch: null, remote: null, worktreeDir: null,
  editor: { command: "orca-ide", args: [], enabled: true, integration: "orca" },
  agent: { command: "claude", args: [], enabled: true, waitForSetup: true }, hooks: { postCreate: ["ordinary"] },
  workflows: { review: { postCreate: ["workflow"], agent: { command: "codex", args: ["prompt"], waitForSetup: false } } } };
const ctx: CommandContext = { cwd: "/repo", interactive: true, io: { stdout: () => {}, stderr: () => {} } };
function harness(existing = false, loaded = config) {
  const calls: string[] = [];
  const launches: EditorTerminalLaunch[] = [];
  const services = createServiceDouble({ discoverRepository: async () => repositoryFixture(), loadConfig: async () => loaded,
    resolveBase: async () => ({ ref: "refs/heads/main", commit: "a".repeat(40), source: "fallback" }),
    resolveOpenTarget: async () => ({ kind: "found", value: existing ? { kind: "worktree", worktree: worktreeFixture() }
      : { kind: "branch", branch: { kind: "local", name: "feature", ref: "refs/heads/feature", upstream: null } } }),
    createWorktree: async () => { calls.push("create"); return worktreeFixture(); },
    writeWorkflowAssociation: async () => { calls.push("save-workflow"); },
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
    expect(h.calls).toEqual(["create", "save-workflow", "editor-terminals"]);
    expect(h.launches[0]).toMatchObject({ setup: true, workflowName: "review", workflowScripts: ["workflow"],
      agent: { command: "codex", args: ["prompt"], waitForSetup: false } });
  });
  test(`${command} --no-editor retains sequential foreground behavior`, async () => {
    const h = harness();
    const handler = command === "new" ? createNewHandler(h.services) : createOpenHandler(h.services);
    await handler("feature", { editor: false }, ctx);
    expect(h.calls).toEqual(["create", "foreground-setup", "generic-editor", "foreground-agent"]);
    expect(h.launches).toHaveLength(0);
  });
  test(`${command} explicit noninteractive agent fails before mutation in Orca mode`, async () => {
    const h = harness();
    const handler = command === "new" ? createNewHandler(h.services) : createOpenHandler(h.services);
    await expect(handler("feature", { agent: true }, { ...ctx, interactive: false })).rejects.toThrow(/interactive/);
    expect(h.calls).toEqual([]);
  });
}

test("existing Orca open neither repeats setup nor implicitly starts global agent; explicit flags are independent", async () => {
  const h = harness(true);
  const open = createOpenHandler(h.services);
  await open("main", {}, ctx);
  expect(h.launches[0]).toMatchObject({ setup: false, agent: null });
  await open("main", { setup: true }, ctx);
  expect(h.launches[1]).toMatchObject({ setup: true, agent: null });
  await open("main", { agent: true }, ctx);
  expect(h.launches[2]).toMatchObject({ setup: false, agent: { command: "claude", waitForSetup: true } });
  await open("main", { agent: false }, ctx);
  expect(h.launches[3]?.agent).toBeNull();
});

test("handoff failures propagate without calling a foreground launcher", async () => {
  const h = harness();
  h.services.launchEditorTerminals = async () => { throw new Error("handoff failed; retained"); };
  await expect(createNewHandler(h.services)("feature", {}, ctx)).rejects.toThrow(/retained/);
  expect(h.calls).toEqual(["create"]);
});
