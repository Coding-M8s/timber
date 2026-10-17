import { expect, test } from "bun:test";
import { parseConfigSource, resolveConfig } from "../src/config";
import { renderConfig } from "../src/setup/render";
import type { RepositoryConfig } from "../src/types";

const scope = (source: string) => ({
  path: "/config",
  source,
  values: parseConfigSource(source, "/config"),
});
const config = (): RepositoryConfig =>
  resolveConfig(
    {
      global: scope(`
[arena.agents.fast]
tool = "codex"
command = "codex"
args = ["--model", "chosen-model"]
[arena.agents.review]
tool = "claude"
command = "claude"
`),
      local: null,
    },
    "/repo",
  );

test("arena presets merge by name, replacing complete command/argument pairs", () => {
  const global = scope(
    '[arena.agents.fast]\ntool="codex"\ncommand="old"\nargs=["--model","old"]\n[arena.agents.review]\ntool="claude"\ncommand="claude"',
  );
  const local = scope(
    '[arena.agents.fast]\ntool="wrapper"\ncommand="/new"\n[arena.agents]\nreview=false',
  );
  expect(resolveConfig({ global, local }, "/repo").arena).toEqual({
    agents: { fast: { tool: "wrapper", command: "/new", args: [] } },
  });
  expect(
    resolveConfig({ global, local: scope("arena=false") }, "/repo").arena,
  ).toEqual({ agents: {} });
  expect(
    parseConfigSource(renderConfig(global.values), "/roundtrip").arena,
  ).toEqual(global.values.arena);
});

test("invalid presets fail safely even when repository scope overrides them", () => {
  for (const source of [
    '[arena.agents.manual]\ntool="codex"\ncommand="SECRET"',
    '[arena.agents.fast]\ntool="unknown"\ncommand="SECRET"',
    '[arena.agents.fast]\ntool="wrapper"\ncommand="SECRET"\nmodel="SECRET"',
  ]) {
    expect(() => parseConfigSource(source, "/config")).toThrow(/arena/);
    try {
      parseConfigSource(source, "/config");
    } catch (e) {
      expect(String(e)).not.toContain("SECRET");
    }
  }
});

test("repeated presets expand into distinct ordered attempts and stable labels", async () => {
  const { resolveArenaParticipants } = await import(
    "../src/arena/participants"
  );
  const result = resolveArenaParticipants(config(), [
    "fast:2",
    "review",
    "fast",
  ]);
  expect(result.map((p) => [p.label, p.preset, p.tool])).toEqual([
    ["fast-1", "fast", "codex"],
    ["fast-2", "fast", "codex"],
    ["review-1", "review", "claude"],
    ["fast-3", "fast", "codex"],
  ]);
  expect(new Set(result.map((p) => p.id)).size).toBe(4);
  for (const invalid of [
    ["fast"],
    ["fast:0"],
    ["fast:-2"],
    ["fast:1.5"],
    ["fast:9007199254740992"],
    ["missing:2"],
    ["Fast:2"],
    ["manual:2:2"],
  ])
    expect(() => resolveArenaParticipants(config(), invalid)).toThrow();
  expect(
    resolveArenaParticipants(config(), ["manual:2"]).every(
      (p) => p.command === null,
    ),
  ).toBe(true);
});

test("native task handoff uses identical file instructions and literal args; wrapper gets no guessed flags", async () => {
  const { resolveArenaParticipants, buildArenaAgentCommand } = await import(
    "../src/arena/participants"
  );
  const participants = resolveArenaParticipants(config(), ["fast", "review"]);
  const commands = participants.map((p) =>
    buildArenaAgentCommand(p, "/private/task ' $x.txt"),
  );
  expect(commands[0]?.args.slice(0, 2)).toEqual(["--model", "chosen-model"]);
  expect(commands[0]?.args.at(-2)).toBe("--");
  expect(commands[0]?.args.at(-1)).toBe(commands[1]?.args.at(-1));
  expect(commands[0]?.args.at(-1)).toContain("/private/task ' $x.txt");
  expect(
    buildArenaAgentCommand(
      { ...participants[0]!, tool: "wrapper" },
      "/private/task",
    )?.args,
  ).toEqual(["--model", "chosen-model"]);
  for (const args of [
    ["--background"],
    ["--worktree"],
    ["--cd", "/wrong"],
    ["resume"],
    ["--print"],
    ["--model", "ok", "extra-prompt"],
  ]) {
    expect(() =>
      resolveArenaParticipants(
        {
          ...config(),
          arena: { agents: { bad: { tool: "codex", command: "codex", args } } },
        },
        ["bad:2"],
      ),
    ).toThrow();
  }
});

test("unknown prototype-shaped preset names produce actionable validation errors", async () => {
  const { resolveArenaParticipants } = await import(
    "../src/arena/participants"
  );
  expect(() =>
    resolveArenaParticipants({ ...config(), arena: { agents: {} } }, [
      "constructor:2",
    ]),
  ).toThrow(/Unknown arena preset/);
});

test("overridden and unused arena presets still reject invalid executable/native arguments without exposing values", () => {
  for (const invalid of [
    '[arena.agents.hidden]\ntool="codex"\ncommand="./PRIVATE_SENTINEL"',
    '[arena.agents.hidden]\ntool="codex"\ncommand="codex"\nargs=["exec","PRIVATE_SENTINEL"]',
    '[arena.agents.hidden]\ntool="wrapper"\ncommand="../PRIVATE_SENTINEL"',
  ]) {
    for (const local of [null, scope("arena=false")]) {
      let error: unknown;
      try {
        resolveConfig({ global: scope(invalid), local }, "/repo");
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("arena.agents.hidden");
      expect(String(error)).not.toContain("PRIVATE_SENTINEL");
    }
  }
});

test("native preset effort cannot be supplied twice and wrappers cannot claim native effort", () => {
  for (const source of [
    '[arena.agents.review]\ntool="claude"\ncommand="claude"\neffort="high"\nargs=["--effort","medium"]',
    '[arena.agents.review]\ntool="codex"\ncommand="codex"\neffort="high"\nargs=["-c",\'model_reasoning_effort="low"\']',
    '[arena.agents.review]\ntool="wrapper"\ncommand="custom"\neffort="high"',
    '[arena.agents.review]\ntool="claude"\ncommand="claude"\neffort="invalid"',
  ]) expect(() => parseConfigSource(source, "/config")).toThrow(/arena/);
});
