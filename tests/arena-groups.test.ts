import { expect, test } from "bun:test";
import { runCli, placeholderHandlers } from "../src/cli";
import { parseConfigSource, resolveConfig } from "../src/config";
import type { RepositoryConfig } from "../src/types";
const config: RepositoryConfig = {
  baseBranch: null,
  remote: null,
  worktreeDir: null,
  editor: null,
  agent: null,
};

test("ordered harness/model/count flags stay associated and presets share normalization", async () => {
  let captured: any;
  let stdout = "",
    stderr = "";
  const context = {
    cwd: "/repo",
    io: {
      stdout(s: string) {
        stdout += s;
      },
      stderr(s: string) {
        stderr += s;
      },
    },
  };
  const handlers = {
    ...placeholderHandlers,
    arenaNew: async (...args: any[]) => {
      captured = args;
      return 0;
    },
  };
  expect(
    await runCli(
      [
        "arena",
        "new",
        "TIM-123",
        "--name",
        "api",
        "--tool",
        "codex",
        "--model",
        "model-a",
        "--runs",
        "2",
        "--tool",
        "claude",
        "--model",
        "model-b",
        "--preset",
        "custom", "--runs", "3",
      ],
      { context, handlers },
    ),
  ).toBe(0);
  expect(captured[1]).toEqual({
    name: "api",
    groups: [
      { kind: "harness", harness: "codex", model: "model-a", count: 2 },
      { kind: "harness", harness: "claude", model: "model-b", count: 1 },
      { kind: "preset", preset: "custom", count: 3 },
    ],
  });
  expect(
    await runCli(["arena", "new", "demo", "--preset", "custom", "--runs", "2"], {
      context,
      handlers,
    }),
  ).toBe(0);
  expect(captured[1].groups).toEqual([
    { kind: "preset", preset: "custom", count: 2 },
  ]);
  expect(await runCli(["arena", "new", "--help"], { context, handlers })).toBe(
    0,
  );
  expect(stdout).toContain("--tool");
  expect(stdout).toContain("--model");
  expect(stdout).not.toContain("--participant");
  for (const flags of [
    ["--model", "orphan"],
    ["--runs", "2"],
    ["--tool", "codex", "--model", "a", "--model", "b"],
    ["--tool", "manual", "--model", "a"],
    ["--tool", "claude", "--runs", "0"],
    ["--preset", "custom", "--model", "x"],
    ["--tool", "codex", "--runs", "2", "--runs", "3"],
  ]) {
    captured = undefined;
    expect(
      await runCli(["arena", "new", "demo", ...flags], { context, handlers }),
    ).toBe(1);
    expect(captured).toBeUndefined();
  }
});

test("built-in harness groups expand models literally without configured presets", async () => {
  const { resolveArenaGroups, buildArenaAgentCommand } = await import(
    "../src/arena/participants"
  );
  const participants = resolveArenaGroups(config, [
    { kind: "harness", harness: "codex", model: "model-a", count: 2 },
    { kind: "harness", harness: "claude", model: null, count: 1 },
  ]);
  expect(
    participants.map((p) => [p.label, p.tool, p.model, p.configSource]),
  ).toEqual([
    ["codex-1", "codex", "model-a", "builtin"],
    ["codex-2", "codex", "model-a", "builtin"],
    ["claude-1", "claude", null, "builtin"],
  ]);
  expect(
    buildArenaAgentCommand(participants[0]!, "/task")?.args.slice(0, 2),
  ).toEqual(["--model", "model-a"]);
  expect(buildArenaAgentCommand(participants[2]!, "/task")?.args[0]).toBe("--");
  expect(
    resolveArenaGroups(config, [
      { kind: "harness", harness: "manual", model: null, count: 2 },
    ]).every((p) => p.command === null),
  ).toBe(true);
});

test("native preset model fields round trip and conflict with existing model args safely", async () => {
  const { resolveArenaGroups } = await import("../src/arena/participants");
  const source =
    '[arena.agents.fast]\ntool="codex"\ncommand="codex"\nmodel="model-a"\nargs=["--no-alt-screen"]';
  const loaded = resolveConfig(
    {
      global: {
        path: "/config",
        source,
        values: parseConfigSource(source, "/config"),
      },
      local: null,
    },
    "/repo",
  );
  const result = resolveArenaGroups(loaded, [
    { kind: "preset", preset: "fast", count: 2 },
  ]);
  expect(result[0]?.model).toBe("model-a");
  expect(result[0]?.command?.args).toEqual([
    "--no-alt-screen",
    "--model",
    "model-a",
  ]);
  for (const invalid of [
    source + '\nunknown="SECRET"',
    source.replace('["--no-alt-screen"]', '["-m","SECRET"]'),
    source.replace('tool="codex"', 'tool="wrapper"'),
  ]) {
    expect(() => parseConfigSource(invalid, "/config")).toThrow(/arena/);
    try {
      parseConfigSource(invalid, "/config");
    } catch (e) {
      expect(String(e)).not.toContain("SECRET");
    }
  }
});

test("completion offers built-in harnesses and omits hidden participant alias without reading config", async () => {
  const { candidates } = await import("./helpers/completion");
  expect(await candidates("timber arena new demo --tool c")).toEqual([
    "claude",
    "codex",
    "copilot",
    "cursor",
  ]);
  expect(await candidates("timber arena new demo --tool=ma")).toEqual([
    "--tool=manual",
  ]);
  expect(await candidates("timber arena new demo --tool p")).toEqual(["pi"]);
  expect(await candidates("timber arena new demo --tool=a")).toEqual(["--tool=amp"]);
  expect(await candidates("timber arena new demo --tool q")).toEqual(["qwen"]);
  expect(await candidates("timber arena new --part")).toEqual([]);
});
