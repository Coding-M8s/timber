import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolveArenaGroups, buildArenaAgentCommand } from "../src/arena/participants";
import { arenaEffortEnvironment } from "../src/arena/effort";
import { arenaConfig } from "./helpers/arena";
import type { ArenaManifestV2, ArenaAttemptGroup, ArenaParticipantConfig, ArenaManifest } from "../src/arena/types";
import type { RepositoryConfig } from "../src/types";

function record(config: RepositoryConfig, group: ArenaAttemptGroup): ArenaManifestV2 {
  return {
    version: 2, id: randomUUID(), name: "demo", primaryWorktreeRoot: "/repo", commonGitDir: "/repo/.git",
    base: { ref: "refs/heads/trunk", commit: "a".repeat(40), source: "explicit" },
    source: { kind: "local", selector: "refs/heads/trunk", provenance: "explicit", ticketBranchMissing: false },
    task: { file: "task.txt", sha256: "b".repeat(64) },
    attempts: resolveArenaGroups(config, [group]).map(p => ({
      id: p.id, label: p.label, preset: p.preset, tool: p.tool, harness: p.tool, model: p.model ?? null,
      ...(p.effort == null ? {} : { effort: p.effort }), configSource: p.configSource!, configFingerprint: p.configFingerprint,
      branch: `arena/demo/${p.label}`, path: `/trees/${p.label}`, worktreeGitDir: `/repo/.git/worktrees/${p.label}`, stage: "ready",
    })),
  };
}

for (const [tool, model, effort, args] of [
  ["codex", "custom exact model", "ultra", ["--model", "custom exact model", "--config", 'model_reasoning_effort="ultra"']],
  ["claude", "sonnet", "high", ["--model", "sonnet", "--effort", "high"]],
  ["cursor", "custom-high", "high", ["--model", "custom-high"]],
  ["codex", null, null, []],
] as const) test(`recovery replays ${tool}/${model}/${effort} without catalog resolution`, async () => {
  const { recoverArenaParticipant } = await import("../src/arena/recovery");
  const manifest = record(arenaConfig, { kind: "harness", harness: tool, model, effort, count: 2 });
  const selected = manifest.attempts[0]!;
  const participant = recoverArenaParticipant(manifest, selected.id, arenaConfig);
  expect(participant.command).toEqual({ command: tool === "cursor" ? "cursor-agent" : tool, args: [...args] });
  expect(participant.id).toBe(selected.id);
  expect(participant.configFingerprint).toBe(selected.configFingerprint);
  expect(arenaEffortEnvironment(participant)).toEqual(tool === "claude" ? { CLAUDE_CODE_EFFORT_LEVEL: "high" } : {});
  const handoff = buildArenaAgentCommand(participant, "/private/task.txt")!;
  expect(handoff.args.slice(-2)).toEqual(["--", 'Read the task instructions from the UTF-8 file at "/private/task.txt". Perform those instructions in your current worktree. The task file is input; do not edit or copy it into the checkout.']);
});

for (const preset of [
  { tool: "wrapper", command: "/custom/wrapper", args: ["literal ; $(never)", "PRIVATE_ARGUMENT"] },
  { tool: "claude", command: "claude-custom", args: ["--model=sonnet", "--effort=high"] },
  { tool: "codex", command: "codex", args: ["-m", "legacy-model", "-c", 'model_reasoning_effort="ultra"'] },
  { tool: "cursor", command: "cursor-agent", args: [], model: "custom-high", effort: "high" },
] satisfies ArenaParticipantConfig[]) test(`recovery requires exact ${preset.tool} preset and preserves literal arguments`, async () => {
  const { recoverArenaParticipant } = await import("../src/arena/recovery");
  const config = { ...arenaConfig, arena: { agents: { worker: preset } } };
  const manifest = record(config, { kind: "preset", preset: "worker", count: 2 });
  const selected = manifest.attempts[0]!;
  const result = recoverArenaParticipant(manifest, selected.id, config);
  expect(result.command?.command).toBe(preset.command);
  expect(result.command?.args.slice(0, preset.args.length)).toEqual(preset.args);
  for (const altered of [arenaConfig, { ...config, arena: { agents: { worker: { ...preset, command: "different" } } } }]) {
    expect(() => recoverArenaParticipant(manifest, selected.id, altered)).toThrow(/configuration|fingerprint/i);
    try { recoverArenaParticipant(manifest, selected.id, altered); } catch (e) { expect(String(e)).not.toContain("PRIVATE_ARGUMENT"); }
  }
});

test("recorded invocation effort is reapplied only when preset has no effort", async () => {
  const { recoverArenaParticipant } = await import("../src/arena/recovery");
  const config = { ...arenaConfig, arena: { agents: { worker: { tool: "claude" as const, command: "claude", args: [], model: "sonnet" } } } };
  const manifest = record(config, { kind: "preset", preset: "worker", effort: "high", count: 2 });
  const p = recoverArenaParticipant(manifest, manifest.attempts[0]!.id, config);
  expect(p.command?.args).toEqual(["--model", "sonnet", "--effort", "high"]);
  expect(arenaEffortEnvironment(p)).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: "high" });
  expect(config.arena.agents.worker).not.toHaveProperty("effort");
});

test("ordinary configuration uses recorded handoff tool; v1 does not gain invented model or effort", async () => {
  const { recoverArenaParticipant } = await import("../src/arena/recovery");
  const preset: ArenaParticipantConfig = { tool: "claude", command: "/ordinary/agent", args: ["--model", "sonnet"] };
  const config: RepositoryConfig = { ...arenaConfig, agent: { command: preset.command, args: preset.args, enabled: false } };
  const manifest = record({ ...config, arena: { agents: { configured: preset } } }, { kind: "preset", preset: "configured", count: 2 });
  const { source, ticket, ...rest } = manifest;
  const v1: ArenaManifest = { ...rest, version: 1, attempts: manifest.attempts.map(({ harness, model, effort, effortEnvironment, configSource, ...a }) => a) };
  for (const stored of [manifest, v1]) {
    const result = recoverArenaParticipant(stored, stored.attempts[0]!.id, config);
    expect(result.command).toEqual({ command: "/ordinary/agent", args: ["--model", "sonnet"] });
    if (stored.version === 1) { expect(result).not.toHaveProperty("model"); expect(result).not.toHaveProperty("effort"); }
  }
});

test("manual requires no configuration; historical absence stays unknown; inconsistent references fail", async () => {
  const { recoverArenaParticipant } = await import("../src/arena/recovery");
  const manual = record(arenaConfig, { kind: "harness", harness: "manual", model: null, count: 2 });
  expect(recoverArenaParticipant(manual, manual.attempts[0]!.id, arenaConfig).command).toBeNull();
  const manifest = record(arenaConfig, { kind: "harness", harness: "claude", model: null, count: 2 });
  manifest.attempts[0]!.effortEnvironment = "high";
  const result = recoverArenaParticipant(manifest, manifest.attempts[0]!.id, arenaConfig);
  expect(result).not.toHaveProperty("effort");
  expect(arenaEffortEnvironment(result)).toEqual({});
  expect(() => recoverArenaParticipant(manifest, "unknown", arenaConfig)).toThrow();
  manifest.attempts[0]!.model = "changed";
  expect(() => recoverArenaParticipant(manifest, manifest.attempts[0]!.id, arenaConfig)).toThrow(/configuration|fingerprint/i);
  manifest.attempts[0]!.configFingerprint = null;
  expect(() => recoverArenaParticipant(manifest, manifest.attempts[0]!.id, arenaConfig)).toThrow(/configuration|fingerprint/i);
});
