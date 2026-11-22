import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { parseConfigSource } from "../src/config";
import { arenaTaskPrompt, buildArenaAgentCommand, configuredArenaModel, resolveArenaGroups, validateParticipant } from "../src/arena/participants";
import { recoverArenaParticipant } from "../src/arena/recovery";
import { normalizeArenaGroups } from "../src/arena/selection";
import { collectParticipants } from "../src/arena/prompt";
import type { ModelDiscovery } from "../src/arena/models";
import type { SetupPrompt } from "../src/setup/types";
import { nativeArenaTools } from "../src/arena/tools";
import { arenaConfig } from "./helpers/arena";
import { withRepository } from "./helpers/git";
import { discoverRepository } from "../src/git/repository";
import { resolveBase } from "../src/git/branches";
import type { ArenaManifestV2, ArenaAttemptGroup, ArenaParticipantConfig, ArenaPlan } from "../src/arena/types";

type NewTool = "gemini" | "grok" | "opencode" | "copilot";

const task = "/private/task ' $x.txt";
const prompt = arenaTaskPrompt(task);

function argv(group: ArenaAttemptGroup, config = arenaConfig) {
  const participant = resolveArenaGroups(config, [group, { kind: "harness", harness: "manual", model: null, count: 1 }])[0]!;
  const command = buildArenaAgentCommand(participant, task)!;
  return [command.command, ...command.args];
}

const builtins: [NewTool, string, string[]][] = [
  ["gemini", "gemini", [`--prompt-interactive=${prompt}`]],
  ["grok", "grok", ["--", prompt]],
  ["opencode", "opencode", [`--prompt=${prompt}`]],
  ["copilot", "copilot", [`--interactive=${prompt}`]],
];

for (const [tool, executable, handoff] of builtins) {
  test(`${tool} built-in starts ${executable} with the task as its interactive initial prompt`, () => {
    expect(argv({ kind: "harness", harness: tool, model: null, count: 1 })).toEqual([executable, ...handoff]);
    expect(argv({ kind: "harness", harness: tool, model: "exact model;$(x)", count: 1 }))
      .toEqual([executable, "--model", "exact model;$(x)", ...handoff]);
  });
}

test("existing tools keep their exact task handoff", () => {
  for (const [tool, executable] of [["codex", "codex"], ["claude", "claude"], ["cursor", "cursor-agent"]] as const)
    expect(argv({ kind: "harness", harness: tool, model: "m", count: 1 })).toEqual([executable, "--model", "m", "--", prompt]);
});

const allowed: [NewTool, string[], string | null][] = [
  ["gemini", ["-m", "flash", "--approval-mode", "auto_edit", "--sandbox", "-s"], "flash"],
  ["gemini", ["--model=pro", "--approval-mode=plan"], "pro"],
  ["grok", ["-m", "grok-4.7", "--permission-mode", "acceptEdits", "--agent", "reviewer", "--no-alt-screen", "--no-memory", "--disable-web-search", "--no-subagents"], "grok-4.7"],
  ["opencode", ["--model", "anthropic/claude-sonnet", "--agent", "build"], "anthropic/claude-sonnet"],
  ["opencode", ["-m=openai/gpt"], "openai/gpt"],
  ["copilot", ["--model=gpt-5.3-codex", "--agent", "docs", "--mode", "plan", "--no-banner", "--sandbox", "--screen-reader"], "gpt-5.3-codex"],
  ["copilot", ["--no-sandbox"], null],
];
for (const [tool, args, model] of allowed) test(`${tool} preset accepts documented interactive arguments ${JSON.stringify(args)}`, () => {
  const preset: ArenaParticipantConfig = { tool, command: tool, args };
  expect(() => validateParticipant(preset)).not.toThrow();
  expect(configuredArenaModel(preset)).toBe(model);
  const config = { ...arenaConfig, arena: { agents: { worker: preset } } };
  const built = argv({ kind: "preset", preset: "worker", count: 1 }, config);
  expect(built.slice(1, 1 + args.length)).toEqual(args);
});

const refused: [NewTool, string[]][] = [
  ["gemini", ["-p", "other prompt"]], ["gemini", ["--prompt=other"]], ["gemini", ["-i", "other"]],
  ["gemini", ["--yolo"]], ["gemini", ["--resume"]], ["gemini", ["--include-directories", "/elsewhere"]],
  ["gemini", ["--worktree"]], ["gemini", ["--output-format", "json"]], ["gemini", ["extra prompt"]],
  ["grok", ["-p", "other"]], ["grok", ["--single"]], ["grok", ["--continue"]], ["grok", ["-r"]],
  ["grok", ["--cwd", "/elsewhere"]], ["grok", ["--add-dir", "/elsewhere"]], ["grok", ["--worktree"]],
  ["grok", ["--always-approve"]], ["grok", ["--reasoning-effort", "high"]], ["grok", ["agent"]], ["grok", ["--model", "a", "extra"]],
  ["opencode", ["--prompt", "other"]], ["opencode", ["--continue"]], ["opencode", ["-s", "id"]], ["opencode", ["run"]],
  ["opencode", ["/other/project"]], ["opencode", ["--server", "http://host"]], ["opencode", ["--auto"]],
  ["copilot", ["-p", "other"]], ["copilot", ["-i", "other"]], ["copilot", ["--interactive=other"]], ["copilot", ["--continue"]],
  ["copilot", ["--resume"]], ["copilot", ["--add-dir", "/elsewhere"]], ["copilot", ["--allow-all"]], ["copilot", ["--allow-all-tools"]], ["copilot", ["--yolo"]],
  ["opencode", ["--agent", "--continue"]], ["gemini", ["--approval-mode", "--resume"]], ["copilot", ["--mode", "--allow-all"]],
  ["grok", ["--agent", "-c"]],
  ["copilot", ["--allow-tool", "shell"]], ["copilot", ["--effort", "high"]], ["copilot", ["-m", "model"]], ["copilot", ["--worktree"]],
];
for (const [tool, args] of refused) test(`${tool} preset refuses ${JSON.stringify(args)}`, () => {
  expect(() => validateParticipant({ tool, command: tool, args })).toThrow();
  const source = `[arena.agents.bad]\ntool="${tool}"\ncommand="${tool}"\nargs=${JSON.stringify(args)}`;
  expect(() => parseConfigSource(source, "/config")).toThrow(/arena|args/i);
});

test("each new tool takes its model once and has no Timber effort override", () => {
  for (const tool of ["gemini", "grok", "opencode", "copilot"] as const) {
    expect(() => validateParticipant({ tool, command: tool, args: ["--model", "a"], model: "b" })).toThrow(/once/);
    expect(() => validateParticipant({ tool, command: tool, args: [], effort: "high" })).toThrow(/effort/i);
  }
});

test("saved presets for new tools load from TOML", () => {
  const values = parseConfigSource(`
[arena.agents.g]
tool = "gemini"
command = "gemini"
model = "flash"
[arena.agents.x]
tool = "grok"
command = "/opt/grok/bin/grok"
args = ["--no-alt-screen"]
[arena.agents.o]
tool = "opencode"
command = "opencode"
args = ["--model", "anthropic/claude-sonnet"]
[arena.agents.c]
tool = "copilot"
command = "copilot"
args = ["--model", "gpt-5.3-codex"]
`, "/config");
  expect(values.arena && Object.keys(values.arena.agents).sort()).toEqual(["c", "g", "o", "x"]);
});

function record(group: ArenaAttemptGroup): ArenaManifestV2 {
  return {
    version: 2, id: randomUUID(), name: "demo", primaryWorktreeRoot: "/repo", commonGitDir: "/repo/.git",
    base: { ref: "refs/heads/trunk", commit: "a".repeat(40), source: "explicit" },
    source: { kind: "local", selector: "refs/heads/trunk", provenance: "explicit", ticketBranchMissing: false },
    task: { file: "task.txt", sha256: "b".repeat(64) },
    attempts: resolveArenaGroups(arenaConfig, [group]).map(p => ({
      id: p.id, label: p.label, preset: p.preset, tool: p.tool, harness: p.tool, model: p.model ?? null,
      configSource: p.configSource!, configFingerprint: p.configFingerprint,
      branch: `arena/demo/${p.label}`, path: `/trees/${p.label}`, worktreeGitDir: `/repo/.git/worktrees/${p.label}`, stage: "ready",
    })),
  };
}

for (const [tool, executable, handoff] of builtins) test(`recovery replays a recorded ${tool} attempt`, () => {
  const manifest = record({ kind: "harness", harness: tool, model: "exact", count: 2 });
  const participant = recoverArenaParticipant(manifest, manifest.attempts[0]!.id, arenaConfig);
  expect(participant.command).toEqual({ command: executable, args: ["--model", "exact"] });
  expect(buildArenaAgentCommand(participant, task)?.args).toEqual(["--model", "exact", ...handoff]);
});

test("arena records with every tool round-trip, and records written by older versions still load", async () => {
  const { planArena } = await import("../src/arena/plan");
  const { reserveArena, readArena } = await import("../src/arena/storage");
  await withRepository(async primary => {
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, arenaConfig, "trunk");
    const groups = nativeArenaTools.map(harness => ({ kind: "harness" as const, harness, model: null, count: 1 }));
    const plan: ArenaPlan = await planArena(repository, arenaConfig, "all", resolveArenaGroups(arenaConfig, groups), base);
    const session = await reserveArena(repository, plan, Buffer.from("task"));
    try { await session.save(); } finally { await session.close(); }
    const current = (await readArena(repository, "all")).manifest;
    expect(current.attempts.map(a => a.tool)).toEqual([...nativeArenaTools]);
    if (current.version !== 2) throw new Error("expected v2");
    // An older Timber wrote only codex, claude and cursor, in either record version.
    const old = current.attempts.filter(a => ["codex", "claude", "cursor"].includes(a.tool));
    const file = join(repository.commonGitDir, "timber/arenas/all/manifest.json");
    const v2 = { ...current, attempts: old };
    await writeFile(file, JSON.stringify(v2));
    expect((await readArena(repository, "all")).manifest).toEqual(v2);
    const { source, ticket, ...common } = v2;
    const v1 = { ...common, version: 1 as const, attempts: old.map(({ harness, model, effort, effortEnvironment, configSource, ...a }) => a) };
    await writeFile(file, JSON.stringify(v1));
    expect((await readArena(repository, "all")).manifest).toEqual(v1);
  });
});

const catalog: ModelDiscovery = async () => ({ models: [{ value: "model-a", label: "Model A", efforts: ["low", "high"] }] });

test("arena default effort skips tools without effort support, for tool groups and presets", async () => {
  const config = { ...arenaConfig, arena: { agents: { mine: { tool: "gemini" as const, command: "gemini", args: [] } } } };
  const groups = await normalizeArenaGroups([
    { kind: "harness", harness: "codex", model: "model-a", count: 1 },
    ...(["gemini", "grok", "opencode", "copilot"] as const).map(harness => ({ kind: "harness" as const, harness, model: null, count: 1 })),
    { kind: "preset", preset: "mine", count: 1 },
  ], config, catalog, undefined, "high");
  expect(groups?.map(g => g.effort ?? null)).toEqual(["high", null, null, null, null, null]);
  const runs = resolveArenaGroups(config, groups!);
  expect(runs.map(r => r.effort)).toEqual(["high", null, null, null, null, null]);
  expect(runs[1]!.command?.args).toEqual([]);
});

test("explicit effort for a tool without effort support fails clearly; native default is accepted", async () => {
  for (const harness of ["gemini", "grok", "opencode", "copilot"] as const) {
    await expect(normalizeArenaGroups([{ kind: "harness", harness, model: "model-a", effort: "high", count: 2 }], arenaConfig, catalog))
      .rejects.toThrow(/effort is not supported in arena/);
    expect((await normalizeArenaGroups([{ kind: "harness", harness, model: null, effort: "default", count: 2 }], arenaConfig, catalog))?.[0]?.effort).toBeNull();
  }
});

test("short tool queries resolve the new names and stay explicit when ambiguous", async () => {
  const resolve = (harness: string) => normalizeArenaGroups([{ kind: "harness", harness, model: null, count: 2 }], arenaConfig, catalog);
  expect((await resolve("gem"))?.[0]).toMatchObject({ harness: "gemini" });
  expect((await resolve("grok"))?.[0]).toMatchObject({ harness: "grok" });
  expect((await resolve("open"))?.[0]).toMatchObject({ harness: "opencode" });
  expect((await resolve("cop"))?.[0]).toMatchObject({ harness: "copilot" });
  await expect(resolve("co")).rejects.toThrow(/Ambiguous.*codex.*copilot/);
});

test("arena wizard offers the new tools and skips the effort picker for them", async () => {
  const selections = ["gemini", "custom"], texts = ["flash", "2"], questions: string[] = [];
  const prompt: SetupPrompt = {
    select: async (message, choices) => {
      questions.push(message);
      const selected = selections.shift()!;
      expect(choices.some(c => c.value === selected)).toBe(true);
      return selected;
    },
    text: async () => texts.shift() ?? null,
    confirm: async () => false,
    close() {},
  };
  const runs = await collectParticipants(arenaConfig, prompt, catalog, "high");
  expect(questions.some(q => /effort/i.test(q))).toBe(false);
  expect(runs?.map(r => [r.tool, r.model, r.effort, r.command?.command])).toEqual([
    ["gemini", "flash", null, "gemini"], ["gemini", "flash", null, "gemini"],
  ]);
});

test("a saved effort on a tool without effort support names the effort field", () => {
  expect(() => parseConfigSource('[arena.agents.g]\ntool="gemini"\ncommand="gemini"\neffort="high"', "/config")).toThrow(/effort/);
});
