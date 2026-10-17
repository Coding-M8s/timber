import { expect, test } from "bun:test";
import { collectArenaInput } from "../src/arena/input";
import { collectParticipants } from "../src/arena/prompt";
import { arenaEffortEnvironment, captureArenaEffortEnvironment } from "../src/arena/effort";
import { arenaRunBlock } from "../src/arena/display";
import { terminalStyle } from "../src/terminal-style";
import { runCli, placeholderHandlers } from "../src/cli";
import type { RepositoryConfig } from "../src/types";
import type { ModelDiscovery } from "../src/arena/models";

const config: RepositoryConfig = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };
const context = { cwd: "/repo", interactive: false, io: { stdout() {}, stderr() {} } };
const noPrompt = () => { throw new Error("unexpected prompt"); };
const catalog: ModelDiscovery = async tool => ({ models: tool === "cursor"
  ? [{ value: "composer", label: "Composer" }]
  : [{ value: "model-a", label: "Model A", efforts: ["low", "medium"] }] });

test("arena-wide effort parses independently of ordered tool groups", async () => {
  let captured: any;
  expect(await runCli(["arena", "new", "demo", "--default-effort", "low", "--tool", "codex", "--model", "model-a", "--effort", "medium", "--runs", "2"], {
    context, handlers: { ...placeholderHandlers, arenaNew: async (_name, options) => { captured = options; return 0; } },
  })).toBe(0);
  expect(captured.defaultEffort).toBe("low");
  expect(captured.groups[0].effort).toBe("medium");
});

test("default effort applies to each native tool group; run overrides and native opt-out win", async () => {
  const input = await collectArenaInput({ prompt: "task", agent: false, defaultEffort: "low", groups: [
    { kind: "harness", harness: "codex", model: "model-a", count: 1 },
    { kind: "harness", harness: "codex", model: "model-a", effort: "medium", count: 1 },
    { kind: "harness", harness: "cursor", model: "composer", effort: "default", count: 1 },
    { kind: "harness", harness: "manual", model: null, count: 1 },
  ] }, config, context, noPrompt, catalog);
  expect(input?.participants.map(run => run.effort)).toEqual(["low", "medium", null, null]);
  expect(input?.participants[0]?.command?.args).toEqual(["--model", "model-a", "--config", 'model_reasoning_effort="low"']);
  input?.close?.();
});

test("unsupported global default fails per model and never silently skips native groups", async () => {
  for (const [tool, model] of [["cursor", "composer"], ["codex", null], ["codex", "custom-model"]] as const) {
    await expect(collectArenaInput({ prompt: "task", agent: false, defaultEffort: "low", groups: [
      { kind: "harness", harness: tool, model, count: 2 },
    ] }, config, context, noPrompt, catalog)).rejects.toThrow(/effort/i);
  }
  await expect(collectArenaInput({ prompt: "task", agent: false, defaultEffort: "bogus", groups: [
    { kind: "harness", harness: "manual", model: null, count: 2 },
  ] }, config, context, noPrompt, catalog)).rejects.toThrow(/effort/i);
});

test("preset effort wins over arena default, absent preset effort inherits it, wrappers stay opaque", async () => {
  const loaded: RepositoryConfig = { ...config, arena: { agents: {
    saved: { tool: "codex", command: "codex", args: [], model: "model-a", effort: "medium" },
    bare: { tool: "codex", command: "codex", args: ["--model", "model-a"] },
    wrap: { tool: "wrapper", command: "custom", args: [] },
  } } };
  const input = await collectArenaInput({ prompt: "task", agent: false, defaultEffort: "low", groups: [
    { kind: "preset", preset: "saved", count: 1 }, { kind: "preset", preset: "bare", count: 1 }, { kind: "preset", preset: "wrap", count: 1 },
  ] }, loaded, context, noPrompt, catalog);
  expect(input?.participants.map(run => run.effort)).toEqual(["medium", "low", null]);
  expect(input?.participants[1]?.command?.args).toEqual(["--model", "model-a", "--config", 'model_reasoning_effort="low"']);
  expect(loaded.arena!.agents.bare!.effort).toBeUndefined();
  input?.close?.();
});

test("wizard offers inherited arena effort and native opt-out after model selection", async () => {
  const answers = ["codex", "model:model-a", "inherit"];
  const runs = await collectParticipants(config, {
    select: async (message, choices, selected) => {
      if (message.includes("effort")) {
        expect(selected).toBe("inherit");
        expect(choices.map(choice => choice.value)).toEqual(["inherit", "default", "low", "medium"]);
      }
      return answers.shift() ?? null;
    }, text: async () => "2", confirm: async () => false, close() {},
  }, catalog, "low");
  expect(runs?.map(run => run.effort)).toEqual(["low", "low"]);
});

test("Claude effort reporting captures only safe inherited levels and launch overrides stay per run", () => {
  const run = { id: "id", label: "claude-1", preset: "claude", tool: "claude" as const, command: null, configFingerprint: null, model: null, effort: null, branch: "arena/demo/claude-1", path: "/tree" };
  const inherited = captureArenaEffortEnvironment([run], { CLAUDE_CODE_EFFORT_LEVEL: "low" })[0]!;
  expect(inherited.effortEnvironment).toBe("low");
  const text = arenaRunBlock(inherited, 1, 2, terminalStyle(false, {}));
  expect(text).toContain("CLAUDE_CODE_EFFORT_LEVEL=low");
  expect(text).toContain("effective unknown");
  const redacted = captureArenaEffortEnvironment([run], { CLAUDE_CODE_EFFORT_LEVEL: "SECRET-unrecognized" })[0]!;
  expect(redacted.effortEnvironment).toBe("unrecognized");
  expect(JSON.stringify(redacted)).not.toContain("SECRET");
  expect(arenaEffortEnvironment({ ...run, effort: "medium" })).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: "medium" });
  expect(arenaEffortEnvironment(run)).toEqual({});
  expect(arenaEffortEnvironment({ ...run, tool: "codex", effort: "low" })).toEqual({});
  expect(arenaRunBlock({ ...run, effort: "medium" }, 1, 2, terminalStyle(false, {}))).toContain("medium (requested); effective unknown");
});


test("legacy participant seam rejects a global effort instead of silently dropping it", async () => {
  await expect(collectArenaInput({ prompt: "task", agent: false, defaultEffort: "low", participants: ["manual:2"] }, config, context, noPrompt, catalog)).rejects.toThrow(/legacy.*groups/i);
});

test("normalized preset fallback is revalidated if reused with a changed catalog", async () => {
  const { normalizeArenaGroups } = await import("../src/arena/selection");
  const loaded: RepositoryConfig = { ...config, arena: { agents: { saved: { tool: "codex", command: "codex", args: [], model: "model-a" } } } };
  const groups = await normalizeArenaGroups([{ kind: "preset", preset: "saved", count: 2 }], loaded, catalog, undefined, "low");
  expect(groups?.[0]?.effort).toBe("low");
  await expect(normalizeArenaGroups(groups!, loaded, async () => ({ models: [] }))).rejects.toThrow(/effort/i);
});
