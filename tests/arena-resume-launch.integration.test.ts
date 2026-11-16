import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withArena, arenaConfig } from "./helpers/arena";
import { git } from "./helpers/git";
import { evolve, harness, snapshot, withWorker, workerConfig } from "./helpers/arena-resume";
import { readArena } from "../src/arena/storage";
import type { AgentResult } from "../src/types";

test("resume preserves evolved HEAD, all file classes and other attempts; exact task/argv/environment reach agent", async () => {
  await withWorker(async f => {
    await evolve(f); const before = await snapshot(f); const other = structuredClone(f.manifest.attempts[1]);
    const h = await harness(f);
    expect(await h.run()).toBe(0);
    expect(h.calls).toEqual(["editor", "agent"]);
    expect(await snapshot(f)).toEqual(before);
    expect(before.head).not.toBe(f.manifest.base.commit);
    const saved = (await readArena(f.repository, "demo")).manifest;
    expect(saved.attempts[0]).toMatchObject({ stage: "exited", exitCode: 0, signal: null });
    expect(saved.attempts[1]).toEqual(other);
    expect(h.output()).not.toContain("PRIVATE_TASK_SENTINEL");
    expect(existsSync(f.lockPath)).toBe(false);
  });
});

test("interactive cancellation is byte-for-byte mutation free; explicit picker values must be offered UUIDs", async () => {
  await withWorker(async f => {
    const before = await readFile(f.manifestPath); const refs = await git(f.primary, "show-ref");
    const h = await harness(f, { openArenaForResume: async () => { throw new Error("must not lock"); } });
    h.context.choose = async (_message, choices) => { expect(choices.map(c => c.value)).toContain(f.manifest.attempts[0]!.id); return null; };
    expect(await h.run({})).toBe(0);
    expect(h.output()).toContain("Cancelled."); expect(h.calls).toEqual([]);
    expect(await readFile(f.manifestPath)).toEqual(before); expect(await git(f.primary, "show-ref")).toBe(refs);
    expect(existsSync(f.lockPath)).toBe(false);
    h.context.choose = async () => "worker-1";
    await expect(h.run({})).rejects.toThrow(/selection/i);
  });
});

test("unattended selection is exact and agent launch requires TTY before writes", async () => {
  await withWorker(async f => {
    const h = await harness(f); h.context.interactive = false;
    const before = await readFile(f.manifestPath);
    await expect(h.run({})).rejects.toThrow(/--attempt/);
    await expect(h.run({ attempt: "work" })).rejects.toThrow(/--attempt|exact/i);
    await expect(h.run()).rejects.toThrow(/interactive|terminal/i);
    expect(await readFile(f.manifestPath)).toEqual(before);
    expect(existsSync(f.lockPath)).toBe(false);
    expect(await h.run({ attempt: "worker-1", agent: false, editor: false })).toBe(0);
    expect(await readFile(f.manifestPath)).toEqual(before);
    expect(h.calls).not.toContain("agent");
  });
});

for (const failure of ["missing config", "changed config", "missing executable"]) test(`${failure} blocks agent but permits --no-agent revisit`, async () => {
  await withWorker(async f => {
    const h = await harness(f, failure === "missing executable" ? { checkExecutable: async () => false }
      : { loadConfig: async () => failure === "missing config" ? arenaConfig : { ...workerConfig, arena: { agents: { worker: { ...workerConfig.arena.agents.worker, args: ["PRIVATE_CHANGED_ARGS"] } } } } });
    const before = await readFile(f.manifestPath);
    await expect(h.run()).rejects.toThrow(/configuration|executable/i);
    expect(await readFile(f.manifestPath)).toEqual(before);
    expect(await h.run({ attempt: "worker-1", agent: false })).toBe(0);
    expect(h.calls).not.toContain("agent");
    expect(h.output()).not.toContain("PRIVATE_CHANGED_ARGS");
  });
});

for (const state of ["created", "setup-running", "failed"] as const) test(`${state} setup requires --setup; editor-only success/failure cannot erase it`, async () => {
  await withWorker(async f => {
    const a = f.manifest.attempts[0]!; a.stage = state;
    if (state === "failed") a.failedStage = "setup";
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    const before = await readFile(f.manifestPath);
    const h = await harness(f);
    await expect(h.run()).rejects.toThrow(/--setup/);
    expect(await h.run({ attempt: "worker-1", agent: false })).toBe(0);
    expect(await readFile(f.manifestPath)).toEqual(before);
    const failedEditor = await harness(f, { launchEditor: async () => ({ kind: "failed", message: "PRIVATE_ERROR", retryCommand: "private" }) });
    expect(await failedEditor.run({ attempt: "worker-1", agent: false })).toBe(1);
    expect(await readFile(f.manifestPath)).toEqual(before);
    expect(failedEditor.output()).not.toContain("PRIVATE_ERROR");
    expect(await h.run({ attempt: "worker-1", setup: true })).toBe(0);
    expect(h.calls).toEqual(["editor", "setup", "editor", "agent"]);
  });
});

test("--setup reruns ordinary hooks from beginning and stops on failed step without rollback", async () => {
  await withWorker(async f => {
    await evolve(f); const before = await snapshot(f);
    const config = { ...workerConfig, hooks: { postCreate: ["printf 'first\n' >> setup-order", "printf 'second\n' >> setup-order; exit 9", "touch NEVER"] } };
    const h = await harness(f, { loadConfig: async () => config });
    expect(await h.run({ attempt: "worker-1", setup: true })).toBe(1);
    expect(h.calls).toEqual(["setup"]);
    const path = f.manifest.attempts[0]!.path;
    expect(await readFile(join(path, "setup-order"), "utf8")).toBe("first\nsecond\n");
    expect(existsSync(join(path, "NEVER"))).toBe(false);
    expect((await readArena(f.repository, "demo")).manifest.attempts[0]).toMatchObject({ stage: "failed", failedStage: "setup" });
    expect(h.output()).toContain("--setup"); expect(h.output()).toContain("worker-1");
    expect(await snapshot(f)).toEqual(before);
    const retry = await harness(f, { loadConfig: async () => ({ ...config, hooks: { postCreate: ["printf 'first\n' >> setup-order", "printf 'second\n' >> setup-order"] } }) });
    expect(await retry.run({ attempt: "worker-1", setup: true, agent: false })).toBe(0);
    expect(await readFile(join(path, "setup-order"), "utf8")).toBe("first\nsecond\nfirst\nsecond\n");
    expect(retry.calls).toEqual(["setup", "editor"]);
  });
});

for (const [label, result] of [
  ["nonzero", { kind: "exited", exitCode: 17, signal: null }],
  ["SIGINT", { kind: "exited", exitCode: 130, signal: "SIGINT" }],
  ["startup", { kind: "failed", message: "PRIVATE_AGENT_ERROR", retryCommand: "private" }],
] satisfies [string, AgentResult][]) test(`${label} retains workspace, persists actual outcome, and propagates numeric status`, async () => {
  await withWorker(async f => {
    await evolve(f); const before = await snapshot(f);
    const h = await harness(f, { launchAgent: async () => result });
    expect(await h.run()).toBe(result.kind === "exited" ? result.exitCode : 1);
    const saved = (await readArena(f.repository, "demo")).manifest.attempts[0]!;
    expect(saved.stage).toBe(result.kind === "exited" ? "exited" : "failed");
    if (result.kind === "exited") { expect(saved.exitCode).toBe(result.exitCode); expect(saved.signal).toBe(result.signal); }
    expect(h.output()).toContain("resume"); expect(h.output()).toContain("worker-1");
    expect(h.output()).not.toContain("PRIVATE_AGENT_ERROR");
    expect(await snapshot(f)).toEqual(before); expect(existsSync(f.lockPath)).toBe(false);
  });
});

for (const stage of ["planned", "launch-running"] as const) test(`uncertain/unbound ${stage} cannot trigger external actions`, async () => {
  await withWorker(async f => {
    f.manifest.attempts[0]!.stage = stage;
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    const h = await harness(f);
    await expect(h.run({ attempt: "worker-1", setup: true })).rejects.toThrow(/inspect|uncertain|created/i);
    expect(h.calls).toEqual([]); expect(existsSync(f.lockPath)).toBe(false);
  });
});

test("manual revisit requires no executable/agent config or terminal and keeps prior outcome", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[0]!; a.stage = "exited"; a.exitCode = 7;
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    const before = await readFile(f.manifestPath);
    const h = await harness(f, { checkExecutable: async () => { throw new Error("manual must not check agent"); } });
    h.context.interactive = false;
    expect(await h.run()).toBe(0); expect(h.calls).toEqual(["editor"]);
    expect(await readFile(f.manifestPath)).toEqual(before);
  });
});
