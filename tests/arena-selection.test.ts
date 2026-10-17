import { expect, test } from "bun:test";
import { runCli, placeholderHandlers } from "../src/cli";
import { parseArenaGroups } from "../src/arena/participants";

test("canonical Arena flags bind model/effort/runs to ordered tool groups and counts to presets", async () => {
  let captured: any;
  const context = { cwd: "/repo", io: { stdout() {}, stderr() {} } };
  const handlers = { ...placeholderHandlers, arenaNew: async (_name: string, options: any) => { captured = options; return 0; } };
  expect(await runCli(["arena", "new", "demo", "--prompt", "write hello world", "--tool", "cur", "--model", "sonnet", "--effort", "high", "--runs", "2", "--preset", "review", "--runs", "3"], { context, handlers })).toBe(0);
  expect(captured).toEqual({ prompt: "write hello world", groups: [
    { kind: "harness", harness: "cur", model: "sonnet", effort: "high", count: 2 },
    { kind: "preset", preset: "review", count: 3 },
  ] });
  for (const flag of ["--harness", "--attempts", "--task-file", "--participant"]) {
    expect(await runCli(["arena", "new", "demo", flag, "x"], { context, handlers })).toBe(1);
  }
});

test("preset counts use runs while model and effort overrides and colon counts are rejected", () => {
  expect(parseArenaGroups([{ option: "preset", value: "review" }, { option: "runs", value: "2" }])).toEqual([{ kind: "preset", preset: "review", count: 2 }]);
  for (const option of ["model", "effort"] as const)
    expect(() => parseArenaGroups([{ option: "preset", value: "review" }, { option, value: "x" }])).toThrow();
  expect(() => parseArenaGroups([{ option: "preset", value: "review:2" }])).toThrow();
});

test("flag queries resolve tools and models before planning, asking only for ambiguity", async () => {
  const { collectArenaInput } = await import("../src/arena/input");
  const config = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };
  let closed = false;
  const prompt = { select: async (_message: string, choices: readonly { value: string }[], _default: string, options?: { search?: boolean; query?: string }) => {
    expect(options?.search).toBe(true);
    expect(options?.query).toBe("sonnet");
    expect(choices.map(c => c.value)).toEqual(["sonnet-high", "sonnet-medium"]);
    return "sonnet-high";
  }, text: async () => { throw new Error("task already supplied"); }, confirm: async () => true, close: () => { closed = true; } };
  const result = await collectArenaInput({ prompt: "write hello world", groups: [
    { kind: "harness", harness: "cur", model: "sonnet", effort: "high", count: 1 },
    { kind: "harness", harness: "cod", model: "sol", effort: "high", count: 1 },
  ] }, config, { cwd: "/repo", interactive: true, io: { stdout() {}, stderr() {} } }, () => prompt, async tool => ({ models: tool === "cursor" ? [
    { value: "sonnet-high", label: "Sonnet High", effort: "high", efforts: ["high"] },
    { value: "sonnet-medium", label: "Sonnet Medium", effort: "medium", efforts: ["medium"] },
  ] : [{ value: "gpt-sol", label: "Sol", efforts: ["low", "high"] }] }));
  expect(result?.task.toString()).toBe("write hello world");
  expect(result?.participants.map(p => [p.tool, p.model, p.effort])).toEqual([["cursor", "sonnet-high", "high"], ["codex", "gpt-sol", "high"]]);
  expect(result?.participants[1]?.command?.args).toEqual(["--model", "gpt-sol", "--config", 'model_reasoning_effort="high"']);
  result?.close?.(); expect(closed).toBe(true);
});

test("unattended fuzzy ambiguity never opens a prompt and prompt sources are exclusive", async () => {
  const { collectArenaInput } = await import("../src/arena/input");
  const config = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };
  const context = { cwd: "/repo", interactive: false, io: { stdout() {}, stderr() {} } };
  const noPrompt = () => { throw new Error("must not prompt"); };
  await expect(collectArenaInput({ prompt: "task", taskFile: "missing" }, config, context, noPrompt)).rejects.toThrow(/combine|exclusive/i);
  await expect(collectArenaInput({ prompt: "task", agent: false, groups: [
    { kind: "harness", harness: "c", model: null, count: 2 },
  ] }, config, context, noPrompt, async () => ({ models: [] }))).rejects.toThrow(/ambiguous/i);
});

test("wizard asks model then supported effort then runs, and records chosen native effort", async () => {
  const { collectParticipants } = await import("../src/arena/prompt");
  const messages: string[] = [];
  const answers = ["codex", "model:gpt-sol", "high"];
  const prompt = {
    select: async (message: string, choices: readonly { value: string }[]) => {
      messages.push(message);
      if (message.includes("effort")) expect(choices.map(c => c.value)).toEqual(["default", "low", "high"]);
      return answers.shift() ?? null;
    },
    text: async (message: string) => { messages.push(message); return "2"; },
    confirm: async () => false, close() {},
  };
  const runs = await collectParticipants({ baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null }, prompt,
    async () => ({ models: [{ value: "gpt-sol", label: "Sol", efforts: ["low", "high"] }] }));
  expect(messages.map(message => /tool|model|effort|runs/u.exec(message)?.[0])).toEqual(["tool", "model", "effort", "runs"]);
  expect(runs?.map(run => run.effort)).toEqual(["high", "high"]);
});

test("native preset effort arguments receive same capability validation as effort field", async () => {
  const { normalizeArenaGroups } = await import("../src/arena/selection");
  const config = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null,
    arena: { agents: { review: { tool: "claude" as const, command: "claude", args: ["--model", "sonnet", "--effort", "max"] } } } };
  await expect(normalizeArenaGroups([{ kind: "preset", preset: "review", count: 2 }], config,
    async () => ({ models: [{ value: "sonnet", label: "Sonnet", efforts: ["low", "high"] }] }))).rejects.toThrow(/supported/i);
});

test("wizard preserves custom model IDs that resemble catalog entries", async () => {
  const { collectParticipants } = await import("../src/arena/prompt");
  const config = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };
  const choices = ["codex", "custom"];
  const answers = ["foo", "2"];
  const runs = await collectParticipants(config, {
    select: async () => choices.shift() ?? null,
    text: async () => answers.shift() ?? null,
    confirm: async () => false,
    close() {},
  }, async () => ({ models: [{ value: "foo-latest", label: "Foo Latest" }] }));
  expect(runs?.map(run => run.model)).toEqual(["foo", "foo"]);
  expect(runs?.[0]?.command?.args).toEqual(["--model", "foo"]);
});

test("Codex ultra resolves from metadata through flag selection into native arguments", async () => {
  const { collectArenaInput } = await import("../src/arena/input");
  const { parseCodexModels } = await import("../src/arena/models");
  const models = parseCodexModels(JSON.stringify({ models: [
    { slug: "gpt-sol", supported_reasoning_levels: [{ effort: "high" }, { effort: "ultra" }] },
  ] }));
  const input = await collectArenaInput({ prompt: "task", agent: false, groups: [
    { kind: "harness", harness: "cod", model: "gpt-sol", effort: "ultra", count: 2 },
  ] }, { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null },
  { cwd: "/repo", interactive: false, io: { stdout() {}, stderr() {} } },
  () => { throw new Error("must not prompt"); }, async () => ({ models }));
  expect(input?.participants.map(run => run.effort)).toEqual(["ultra", "ultra"]);
  expect(input?.participants[0]?.command?.args).toEqual(["--model", "gpt-sol", "--config", 'model_reasoning_effort="ultra"']);
  input?.close?.();
});
