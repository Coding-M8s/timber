import { expect, test } from "bun:test";
import { parseArenaGroups, resolveArenaGroups, buildArenaAgentCommand } from "../src/arena/participants";
import { parseConfigSource, resolveConfig } from "../src/config";
import { collectParticipants } from "../src/arena/prompt";
import type { RepositoryConfig } from "../src/types";
import type { SetupPrompt } from "../src/setup/types";
import { candidates } from "./helpers/completion";

const config: RepositoryConfig = {
  baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null,
};

test("Cursor groups launch cursor-agent rather than ambiguous agent or editor executable", () => {
  const groups = parseArenaGroups([
    { option: "tool", value: "cursor" },
    { option: "model", value: "model;$literal" },
    { option: "tool", value: "cursor" },
  ]);
  const runs = resolveArenaGroups(config, groups);
  expect(runs.map(r => [r.label, r.tool, r.model])).toEqual([
    ["cursor-1", "cursor", "model;$literal"], ["cursor-2", "cursor", null],
  ]);
  const command = buildArenaAgentCommand(runs[0]!, "/private/task.txt");
  expect(command?.command).toBe("cursor-agent");
  expect(command?.args.slice(0, 3)).toEqual(["--model", "model;$literal", "--"]);
  expect(command?.args[3]).toContain('"/private/task.txt"');
  expect(buildArenaAgentCommand(runs[1]!, "/private/task.txt")?.args[0]).toBe("--");
});

test("Cursor presets retain exact models and reject arguments that change interactive workspace lifecycle", () => {
  for (const fields of [
    'model="model-a"', 'args=["--model","model-a"]', 'args=["--model=model-a"]',
  ]) {
    const source = `[arena.agents.review]\ntool="cursor"\ncommand="cursor-agent"\n${fields}`;
    const loaded = resolveConfig({ global: { path: "/config", source,
      values: parseConfigSource(source, "/config") }, local: null }, "/repo");
    expect(resolveArenaGroups(loaded, [{ kind: "preset", preset: "review", count: 2 }])[0]?.model).toBe("model-a");
  }
  for (const args of [
    ["--print"], ["--workspace", "/elsewhere"], ["--worktree"], ["--resume"],
    ["--continue"], ["--list-models"], ["--effort", "high"], ["-m", "model-a"],
    ["--model", "a", "--model=b"], ["--model"], ["--", "another task"],
  ]) {
    const source = `[arena.agents.review]\ntool="cursor"\ncommand="cursor-agent"\nargs=${JSON.stringify(args)}`;
    expect(() => parseConfigSource(source, "/config")).toThrow(/arena/);
  }
  expect(() => parseConfigSource('[arena.agents.review]\ntool="cursor"\ncommand="cursor-agent"\nmodel="a"\nargs=["--model=b"]', "/config")).toThrow(/arena/);
});

test("Arena wizard offers Cursor and model choices from Cursor presets", async () => {
  const selections = ["cursor", "model:configured-model"], counts = ["2"];
  const prompt: SetupPrompt = {
    select: async (_message, choices) => {
      const selected = selections.shift()!;
      expect(choices.some(c => c.value === selected)).toBe(true);
      return selected;
    },
    text: async () => counts.shift() ?? null,
    confirm: async () => false,
    close() {},
  };
  const runs = await collectParticipants({ ...config, arena: { agents: {
    review: { tool: "cursor", command: "cursor-agent", args: [], model: "configured-model" },
  } } }, prompt);
  expect(runs?.map(r => [r.tool, r.model, r.command?.command])).toEqual([
    ["cursor", "configured-model", "cursor-agent"], ["cursor", "configured-model", "cursor-agent"],
  ]);
});

test("Cursor completion works for separate and equals flag values", async () => {
  expect(await candidates("timber arena new demo --tool cu")).toEqual(["cursor"]);
  expect(await candidates("timber arena new demo --tool=cu")).toEqual(["--tool=cursor"]);
});
