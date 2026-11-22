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

const newTools = ["gemini", "grok", "opencode", "copilot", "qwen", "amp", "pi"] as const;
type NewTool = (typeof newTools)[number];

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
  ["qwen", "qwen", [`--prompt-interactive=${prompt}`]],
  ["amp", "amp", ["--execute", prompt]],
  ["pi", "pi", ["--", prompt]],
];

test("the task prompt never starts with '-', so a separate prompt value is never read as a flag", () => {
  expect(prompt.startsWith("-")).toBe(false);
});

for (const [tool, executable, handoff] of builtins) {
  test(`${tool} built-in starts ${executable} with the task as its initial prompt`, () => {
    expect(argv({ kind: "harness", harness: tool, model: null, count: 1 })).toEqual([executable, ...handoff]);
    // Amp needs provider/name with no spaces.
    const model = tool === "amp" ? "p/exact;$(x)" : "exact model;$(x)";
    expect(argv({ kind: "harness", harness: tool, model, count: 1 }))
      .toEqual([executable, "--model", model, ...handoff]);
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
  ["qwen", ["-m", "qwen3-coder-plus", "--approval-mode", "auto-edit", "--auth-type", "openai", "--screen-reader"], "qwen3-coder-plus"],
  ["qwen", ["--model=qwen3-coder", "--approval-mode=plan"], "qwen3-coder"],
  ["amp", ["--model", "openai/gpt-6-astra", "--no-ide", "--no-notifications", "--no-archive-after-execute"], "openai/gpt-6-astra"],
  ["amp", ["--model=anthropic/claude-opus"], "anthropic/claude-opus"],
  ["pi", ["--provider", "deepseek", "--model", "deepseek-v4-pro", "--tui-mode", "regular", "--offline", "--verbose"], "deepseek-v4-pro"],
  ["pi", ["--model", "openrouter/qwen/qwen3-coder:high"], "openrouter/qwen/qwen3-coder:high"],
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
  ["qwen", ["-p", "other"]], ["qwen", ["-i", "other"]], ["qwen", ["--prompt-interactive=other"]], ["qwen", ["--yolo"]], ["qwen", ["-y"]],
  ["qwen", ["--sandbox"]], ["qwen", ["-s", "docker"]], ["qwen", ["--continue"]], ["qwen", ["-r", "id"]], ["qwen", ["--session-id", "id"]],
  ["qwen", ["--worktree", "x"]], ["qwen", ["--openai-api-key", "k"]], ["qwen", ["--system-prompt", "x"]], ["qwen", ["--allowed-tools", "shell"]],
  ["qwen", ["--output-format", "json"]], ["qwen", ["--acp"]], ["qwen", ["extra prompt"]], ["qwen", ["--approval-mode", "--yolo"]],
  ["amp", ["-x", "other"]], ["amp", ["--execute", "other"]], ["amp", ["--execute=other"]], ["amp", ["--dangerously-allow-all"]],
  ["amp", ["--mode", "high"]], ["amp", ["-m", "high"]], ["amp", ["--effort", "high"]], ["amp", ["--stream-json"]], ["amp", ["-ox"]],
  ["amp", ["--settings-file", "/elsewhere/settings.json"]], ["amp", ["--visibility", "public"]], ["amp", ["--no-tui"]],
  ["amp", ["threads", "continue"]], ["amp", ["--model", "--dangerously-allow-all"]],
  ["pi", ["-p"]], ["pi", ["--print"]], ["pi", ["--mode", "json"]], ["pi", ["--thinking", "high"]], ["pi", ["--api-key", "k"]],
  ["pi", ["-a"]], ["pi", ["--approve"]], ["pi", ["-c"]], ["pi", ["--resume"]], ["pi", ["--session", "id"]], ["pi", ["--fork", "id"]],
  ["pi", ["--tools", "read"]], ["pi", ["-e", "./ext.ts"]], ["pi", ["--system-prompt", "x"]], ["pi", ["--models", "a,b"]],
  ["pi", ["-m", "model"]], ["pi", ["@file.md"]], ["pi", ["extra prompt"]], ["pi", ["install", "x"]], ["pi", ["--provider", "--offline"]],
  // Pi matches flags exactly, so the = form would fail at launch.
  ["pi", ["--model=deepseek/deepseek-v4-pro"]], ["pi", ["--provider=deepseek", "--model", "m"]], ["pi", ["--tui-mode=regular"]],
  // Pi refuses --provider without --model.
  ["pi", ["--provider", "deepseek"]],
  // Amp refuses a model that is not provider/name.
  ["amp", ["--model", "gpt-6-astra"]], ["amp", ["--model=astra"]],
];
for (const [tool, args] of refused) test(`${tool} preset refuses ${JSON.stringify(args)}`, () => {
  expect(() => validateParticipant({ tool, command: tool, args })).toThrow();
  const source = `[arena.agents.bad]\ntool="${tool}"\ncommand="${tool}"\nargs=${JSON.stringify(args)}`;
  expect(() => parseConfigSource(source, "/config")).toThrow(/arena|args/i);
});

test("each new tool takes its model once and has no Timber effort override", () => {
  for (const tool of newTools) {
    expect(() => validateParticipant({ tool, command: tool, args: ["--model", "p/a"], model: "p/b" })).toThrow(/once/);
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
[arena.agents.q]
tool = "qwen"
command = "qwen"
model = "qwen3-coder-plus"
args = ["--approval-mode", "auto-edit"]
[arena.agents.a]
tool = "amp"
command = "/opt/amp/bin/amp"
args = ["--no-archive-after-execute"]
[arena.agents.p]
tool = "pi"
command = "pi"
args = ["--provider", "deepseek", "--model", "deepseek-v4-pro"]
`, "/config");
  expect(values.arena && Object.keys(values.arena.agents).sort()).toEqual(["a", "c", "g", "o", "p", "q", "x"]);
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
  const manifest = record({ kind: "harness", harness: tool, model: "p/exact", count: 2 });
  const participant = recoverArenaParticipant(manifest, manifest.attempts[0]!.id, arenaConfig);
  expect(participant.command).toEqual({ command: executable, args: ["--model", "p/exact"] });
  expect(buildArenaAgentCommand(participant, task)?.args).toEqual(["--model", "p/exact", ...handoff]);
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
    ...newTools.map(harness => ({ kind: "harness" as const, harness, model: null, count: 1 })),
    { kind: "preset", preset: "mine", count: 1 },
  ], config, catalog, undefined, "high");
  const none = [...newTools, "mine"].map(() => null);
  expect(groups?.map(g => g.effort ?? null)).toEqual(["high", ...none]);
  const runs = resolveArenaGroups(config, groups!);
  expect(runs.map(r => r.effort)).toEqual(["high", ...none]);
  expect(runs[1]!.command?.args).toEqual([]);
});

test("explicit effort for a tool without effort support fails clearly; native default is accepted", async () => {
  for (const harness of newTools) {
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
  expect((await resolve("q"))?.[0]).toMatchObject({ harness: "qwen" });
  expect((await resolve("am"))?.[0]).toMatchObject({ harness: "amp" });
  // "pi" is also inside "copilot"; the exact name wins.
  expect((await resolve("pi"))?.[0]).toMatchObject({ harness: "pi" });
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

test("the ordinary-agent handoff names Amp's one-turn execute mode and the others' interactive prompt", async () => {
  const config = { ...arenaConfig, agent: { command: "amp", args: [], enabled: true } };
  const selections = ["configured", "amp", "custom"], texts = ["2"];
  let handoffs: { value: string; label: string }[] = [];
  const prompt: SetupPrompt = {
    select: async (message, choices) => {
      if (/handoff/.test(message)) handoffs = [...choices];
      return selections.shift()!;
    },
    text: async () => texts.shift() ?? null,
    confirm: async () => false,
    close() {},
  };
  await collectParticipants(config, prompt, catalog);
  expect(handoffs.find(h => h.value === "amp")?.label).toBe("Amp one-turn execute prompt");
  expect(handoffs.find(h => h.value === "pi")?.label).toBe("Pi interactive initial prompt");
  expect(handoffs.find(h => h.value === "qwen")?.label).toBe("Qwen Code interactive initial prompt");
});

test("tool-specific model rules apply to tool groups and saved model fields before any worktree", () => {
  expect(() => resolveArenaGroups(arenaConfig, [{ kind: "harness", harness: "amp", model: "gpt-6-astra", count: 2 }]))
    .toThrow(/provider\/name/);
  expect(argv({ kind: "harness", harness: "amp", model: "openai/gpt-6-astra", count: 1 }))
    .toEqual(["amp", "--model", "openai/gpt-6-astra", "--execute", prompt]);
  expect(() => validateParticipant({ tool: "amp", command: "amp", args: [], model: "astra" })).toThrow(/provider\/name/);
  expect(() => validateParticipant({ tool: "pi", command: "pi", args: ["--provider", "deepseek"] })).toThrow(/--provider needs a model/);
  expect(() => validateParticipant({ tool: "pi", command: "pi", args: ["--provider", "deepseek"], model: "deepseek-v4-pro" })).not.toThrow();
  expect(() => validateParticipant({ tool: "pi", command: "pi", args: ["--model=m"] })).toThrow(/does not read --option=value/);
  expect(() => validateParticipant({ tool: "pi", command: "pi", args: ["--tui-mode", "-x"] })).toThrow(/Pi option values cannot start/);
});

test("the tool picker warns that Amp runs one turn", async () => {
  let labels: { value: string; label: string }[] = [];
  const prompt: SetupPrompt = {
    select: async (_message, choices) => { labels = [...choices]; return null; },
    text: async () => null, confirm: async () => false, close() {},
  };
  await collectParticipants(arenaConfig, prompt, catalog);
  expect(labels.find(c => c.value === "amp")?.label).toBe("Amp (one turn, no replies): select model");
  expect(labels.find(c => c.value === "pi")?.label).toBe("Pi: select model");
});

test("a saved Amp model that is not provider/name names the model field", () => {
  expect(() => parseConfigSource('[arena.agents.a]\ntool="amp"\ncommand="amp"\nmodel="astra"', "/config")).toThrow(/model/);
  expect(() => parseConfigSource('[arena.agents.a]\ntool="amp"\ncommand="amp"\nmodel="openai/astra"', "/config")).not.toThrow();
});
