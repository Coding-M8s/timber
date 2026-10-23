import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { withArena, arenaConfig, type ArenaFixture } from "./helpers/arena";
import { git } from "./helpers/git";
import { discoverRepository } from "../src/git/repository";
import { readArena, openArenaForResume, validateArenaAttempt } from "../src/arena/storage";
import { runSetup } from "../src/hooks";
import type { CommandContext } from "../src/services";
import type { ArenaResumeServices } from "../src/arena/services";
import type { ArenaResumeOptions } from "../src/arena/types";
import type { AgentResult } from "../src/types";

const workerConfig = { ...arenaConfig, arena: { agents: { worker: {
  tool: "wrapper" as const, command: process.execPath, args: ["literal ; $(never)"] } } } };
const groups = [{ kind: "preset" as const, preset: "worker", count: 2 }];
const withWorker = (run: (f: ArenaFixture) => Promise<void>) => withArena(run, workerConfig, groups);

async function harness(f: ArenaFixture, overrides: Partial<ArenaResumeServices> = {}) {
  const { createArenaResumeHandler } = await import("../src/commands/arena-resume");
  const calls: string[] = []; let output = "";
  const services: ArenaResumeServices = {
    discoverRepository, loadConfig: async () => f.config, readArena, openArenaForResume, validateArenaAttempt,
    checkExecutable: async () => true,
    runSetup: async (...args) => { calls.push("setup"); await runSetup(...args); },
    launchEditor: async () => { calls.push("editor"); return { kind: "skipped" }; },
    launchAgent: async (tree, command, env) => {
      calls.push("agent");
      expect(tree.path).toBe(f.manifest.attempts[0]!.path);
      expect(command).toEqual({ command: process.execPath, args: ["literal ; $(never)"] });
      expect(await readFile(env!.TIMBER_TASK_FILE!, "utf8")).toBe("PRIVATE_TASK_SENTINEL\n' $(touch NEVER)\n");
      expect(env).toMatchObject({ TIMBER_ARENA: "demo", TIMBER_ATTEMPT: "worker-1", TIMBER_WORKTREE: tree.path,
        TIMBER_REPO: f.primary, TIMBER_BRANCH: "arena/demo/worker-1", TIMBER_WORKFLOW: undefined, TIMBER_TASK_ID: undefined });
      return { kind: "exited", exitCode: 0, signal: null };
    }, ...overrides,
  };
  const context: CommandContext = { cwd: f.primary, interactive: true, io: {
    stdout(s) { output += s; }, stderr(s) { output += s; },
  } };
  const handler = createArenaResumeHandler(services);
  return { calls, context, output: () => output, services,
    run: (options: ArenaResumeOptions = { attempt: f.manifest.attempts[0]!.label }) => handler("demo", options, context) };
}
async function snapshot(f: ArenaFixture) {
  const a = f.manifest.attempts[0]!;
  return { refs: await git(f.primary, "show-ref"), worktrees: await git(f.primary, "worktree", "list", "--porcelain"),
    head: await git(a.path, "rev-parse", "HEAD"), files: await Promise.all(["tracked.txt", "untracked", ".env"].map(p => readFile(join(a.path, p), "utf8"))) };
}
async function evolve(f: ArenaFixture) {
  const path = f.manifest.attempts[0]!.path;
  await writeFile(join(path, "tracked.txt"), "committed progress\n");
  await git(path, "add", "tracked.txt");
  await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "attempt progress");
  await writeFile(join(path, "tracked.txt"), "dirty progress\n");
  await writeFile(join(path, "untracked"), "untracked progress\n");
  await writeFile(join(path, ".env"), "ignored progress\n");
}

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
  ["SIGTERM", { kind: "exited", exitCode: 143, signal: "SIGTERM" }],
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

for (const stage of ["planned", "launch-running", "failed"] as const) test(`uncertain/unbound ${stage} cannot trigger external actions`, async () => {
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

for (const tamper of ["task", "branch", "marker", "recreated", "lock"]) test(`${tamper} corruption refuses resume without external actions or recreation`, async () => {
  await withWorker(async f => {
    const a = f.manifest.attempts[0]!;
    if (tamper === "task") await writeFile(f.taskPath, "changed");
    if (tamper === "branch") await git(a.path, "checkout", "--detach");
    if (tamper === "marker") await unlink(join(a.worktreeGitDir!, "timber/arena.json"));
    if (tamper === "recreated") { await git(f.primary, "worktree", "remove", a.path); await git(f.primary, "worktree", "add", a.path, a.branch); }
    if (tamper === "lock") await writeFile(f.lockPath, "interrupted", { mode: 0o600 });
    const refs = await git(f.primary, "show-ref"), trees = await git(f.primary, "worktree", "list", "--porcelain"), before = await readFile(f.manifestPath);
    const h = await harness(f);
    await expect(h.run()).rejects.toThrow(/identity|snapshot|lock|stale|task/i);
    expect(h.calls).toEqual([]); expect(await readFile(f.manifestPath)).toEqual(before);
    expect(await git(f.primary, "show-ref")).toBe(refs); expect(await git(f.primary, "worktree", "list", "--porcelain")).toBe(trees);
  });
});

for (const boundary of ["setup", "editor"]) test(`identity/task changed during ${boundary} suppresses subsequent launch`, async () => {
  await withWorker(async f => {
    const h = await harness(f, boundary === "setup" ? {
      runSetup: async () => { await writeFile(f.taskPath, "tampered during hook"); },
    } : { launchEditor: async tree => { await git(tree.path, "checkout", "--detach"); return { kind: "launched" }; } });
    expect(await h.run({ attempt: "worker-1", ...(boundary === "setup" ? { setup: true as const } : {}) })).toBe(1);
    expect(h.calls).not.toContain("agent"); expect(existsSync(f.lockPath)).toBe(false);
  });
});

test("selection snapshot is rechecked under lock before execution", async () => {
  await withWorker(async f => {
    const h = await harness(f);
    h.context.choose = async () => {
      f.manifest.attempts[1]!.stage = "created";
      await writeFile(f.manifestPath, JSON.stringify(f.manifest));
      return f.manifest.attempts[0]!.id;
    };
    await expect(h.run({})).rejects.toThrow(/changed/);
    expect(h.calls).toEqual([]); expect(existsSync(f.lockPath)).toBe(false);
  });
});

test("failed intent save stops all later actions and preserves last record", async () => {
  await withWorker(async f => {
    const before = await readFile(f.manifestPath);
    const h = await harness(f, { openArenaForResume: async (...args) => {
      const session = await openArenaForResume(...args);
      return { ...session, save: async () => { throw new Error("PRIVATE_METADATA_ERROR"); } };
    } });
    expect(await h.run()).toBe(1); expect(h.calls).toEqual([]);
    expect(await readFile(f.manifestPath)).toEqual(before); expect(existsSync(f.lockPath)).toBe(false);
    expect(h.output()).not.toContain("PRIVATE_METADATA_ERROR");
  });
});

for (const [stage, failedStage] of [["ready", "setup"], ["exited", "setup"], ["created", "agent"]] as const)
test(`contradictory ${stage}/${failedStage} record cannot bypass setup or launch checks`, async () => {
  await withWorker(async f => {
    const a = f.manifest.attempts[0]!; a.stage = stage; a.failedStage = failedStage;
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    const before = await readFile(f.manifestPath), h = await harness(f);
    for (const options of [{ attempt: "worker-1" }, { attempt: "worker-1", setup: true }, { attempt: "worker-1", agent: false }] as const)
      await expect(h.run(options)).rejects.toThrow(/inconsistent|uncertain|inspect/i);
    expect(h.calls).toEqual([]); expect(existsSync(f.lockPath)).toBe(false);
    expect(await readFile(f.manifestPath)).toEqual(before);
  });
});

for (const cause of ["setup", "editor", "agent", "identity"] as const)
test(`${cause} failure remains actionable when failure-outcome publication also fails`, async () => {
  await withWorker(async f => {
    await evolve(f); const before = await snapshot(f);
    const h = await harness(f, {
      loadConfig: async () => ({ ...workerConfig, hooks: { postCreate: ["printf kept > setup-side-effect", "exit 9"] } }),
      openArenaForResume: async (...args) => {
        const session = await openArenaForResume(...args);
        if (cause === "identity") await git(f.manifest.attempts[0]!.path, "checkout", "--detach");
        return { ...session, save: async () => {
          if (session.manifest.attempts[0]!.stage === "failed") throw new Error("PRIVATE_PERSISTENCE_ERROR");
          await session.save();
        } };
      },
      ...(cause === "editor" ? { launchEditor: async () => ({ kind: "failed" as const, message: "PRIVATE_EDITOR_ERROR", retryCommand: "private" }) } : {}),
      ...(cause === "agent" ? { launchAgent: async () => ({ kind: "failed" as const, message: "PRIVATE_AGENT_ERROR", retryCommand: "private" }) } : {}),
    });
    expect(await h.run({ attempt: "worker-1", ...(cause === "setup" ? { setup: true as const } : {}) })).toBe(1);
    expect(h.output()).toMatch(cause === "setup" ? /post_create step 2 failed \(exit code 9\)/
      : cause === "identity" ? /Git identity, task integrity, or lock validation failed/
      : new RegExp(`${cause} startup/execution failed`));
    expect(h.output()).toMatch(/metadata update failed/i);
    expect(h.output()).not.toContain("PRIVATE_");
    expect(existsSync(f.lockPath)).toBe(false);
    const persisted = (await readArena(f.repository, "demo")).manifest.attempts[0]!;
    expect(persisted.stage).toBe(cause === "setup" ? "setup-running" : "launch-running");
    if (cause !== "identity") expect(await snapshot(f)).toEqual(before);
    if (cause === "setup") expect(await readFile(join(f.manifest.attempts[0]!.path, "setup-side-effect"), "utf8")).toBe("kept");
  });
});

for (const tamper of ["branch", "task", "lock"] as const)
test(`editor-only revisit detects ${tamper} replacement after startup and preserves lifecycle history`, async () => {
  await withWorker(async f => {
    f.manifest.attempts[0]!.stage = "failed"; f.manifest.attempts[0]!.failedStage = "setup";
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    const before = await readFile(f.manifestPath), refs = await git(f.primary, "show-ref");
    const h = await harness(f, { launchEditor: async tree => {
      if (tamper === "branch") await git(tree.path, "checkout", "--detach");
      if (tamper === "task") await writeFile(f.taskPath, "changed during editor startup");
      if (tamper === "lock") await writeFile(f.lockPath, "replacement owner");
      return { kind: "launched" };
    } });
    expect(await h.run({ attempt: "worker-1", agent: false })).toBe(1);
    expect(h.output()).toMatch(/validation failed/); expect(h.calls).not.toContain("agent");
    expect(await readFile(f.manifestPath)).toEqual(before); expect(await git(f.primary, "show-ref")).toBe(refs);
    if (tamper === "lock") expect(await readFile(f.lockPath, "utf8")).toBe("replacement owner");
    else expect(existsSync(f.lockPath)).toBe(false);
  });
});

test("completed editor has a durable ready checkpoint if agent intent publication fails; next resume remains possible", async () => {
  await withWorker(async f => {
    await evolve(f); const before = await snapshot(f); let editorReturned = false;
    const h = await harness(f, {
      launchEditor: async () => { editorReturned = true; return { kind: "launched" }; },
      openArenaForResume: async (...args) => {
        const session = await openArenaForResume(...args);
        return { ...session, save: async () => {
          if (editorReturned && session.manifest.attempts[0]!.stage === "launch-running")
            throw new Error("PRIVATE_AGENT_INTENT_ERROR");
          await session.save();
        } };
      },
    });
    expect(await h.run()).toBe(1); expect(h.calls).not.toContain("agent");
    expect((await readArena(f.repository, "demo")).manifest.attempts[0]!.stage).toBe("ready");
    expect(await snapshot(f)).toEqual(before);
    const retried = await harness(f); expect(await retried.run()).toBe(0); expect(retried.calls).toContain("agent");
  });
});

for (const failure of ["setup", "editor", "agent"] as const)
test(`executing ${failure} retry hint preserves explicit launch choices`, async () => {
  const { runCli, placeholderHandlers } = await import("../src/cli");
  const { createArenaResumeHandler } = await import("../src/commands/arena-resume");
  const { launchEditor } = await import("../src/editor");
  const { launchAgent } = await import("../src/agent");
  const preset = { tool: "wrapper" as const, command: process.execPath, args: ["-e",
    'const fs=require("node:fs");const n=fs.existsSync("agent-runs")?Number(fs.readFileSync("agent-runs","utf8")):0;fs.writeFileSync("agent-runs",String(n+1));process.exit(n===0?17:0)'] };
  const config = { ...arenaConfig, arena: { agents: { worker: preset } },
    editor: { enabled: true, command: process.execPath, args: ["-e", 'require("node:fs").writeFileSync("editor-ran","yes")'] },
    hooks: { postCreate: ["exit 9"] } };
  await withArena(async f => {
    let loaded = failure === "editor" ? { ...config, editor: { ...config.editor, command: join(f.directory, "missing-editor") } } : config;
    let editorsStarted = 0;
    const h = await harness(f, {
      loadConfig: async () => loaded,
      launchEditor: async (...args) => {
        const result = await launchEditor(...args); if (result.kind === "launched") editorsStarted++;
        return result;
      }, launchAgent,
    });
    const options: ArenaResumeOptions = { attempt: "worker-1",
      ...(failure === "setup" ? { setup: true, agent: false, editor: false }
        : failure === "editor" ? { agent: false, editor: true } : { editor: false }) };
    expect(await h.run(options)).toBe(failure === "agent" ? 17 : 1);
    const retry = h.output().match(/(?:Retry after inspection|Retry): (timber [^\n]+)/)?.[1];
    expect(retry).toBeDefined();
    loaded = { ...config, editor: { ...config.editor, enabled: failure !== "editor" }, hooks: { postCreate: ["printf prepared > setup-retried"] } };
    const handler = createArenaResumeHandler(h.services);
    expect(await runCli(retry!.split(" ").slice(1), { context: h.context, handlers: { ...placeholderHandlers, arenaResume: handler } })).toBe(0);
    const path = f.manifest.attempts[0]!.path;
    if (failure === "agent") expect(await readFile(join(path, "agent-runs"), "utf8")).toBe("2");
    else expect(existsSync(join(path, "agent-runs"))).toBe(false);
    expect(editorsStarted).toBe(failure === "editor" ? 1 : 0);
    if (failure === "editor") {
      const deadline = Date.now() + 2000;
      while (!existsSync(join(path, "editor-ran")) && Date.now() < deadline) await Bun.sleep(10);
      expect(await readFile(join(path, "editor-ran"), "utf8")).toBe("yes");
    }
    if (failure === "setup") expect(await readFile(join(path, "setup-retried"), "utf8")).toBe("prepared");
    expect((await readArena(f.repository, "demo")).manifest.attempts[1]).toEqual(f.manifest.attempts[1]);
  }, config, [{ kind: "preset", preset: "worker", count: 2 }]);
});

test("failed ready checkpoint retains uncertain editor intent and refuses implicit replay", async () => {
  await withWorker(async f => {
    await evolve(f); const before = await snapshot(f);
    const h = await harness(f, { openArenaForResume: async (...args) => {
      const session = await openArenaForResume(...args);
      return { ...session, save: async () => {
        if (session.manifest.attempts[0]!.stage === "ready") throw new Error("PRIVATE_CHECKPOINT_ERROR");
        await session.save();
      } };
    } });
    expect(await h.run()).toBe(1); expect(h.calls).toEqual(["editor"]);
    expect((await readArena(f.repository, "demo")).manifest.attempts[0]!.stage).toBe("launch-running");
    const retry = await harness(f); await expect(retry.run()).rejects.toThrow(/uncertain/);
    expect(retry.calls).toEqual([]); expect(await snapshot(f)).toEqual(before);
    expect(existsSync(f.lockPath)).toBe(false);
  });
});

test("termination during editor handoff keeps lock/intent and blocks replay without changing work", async () => {
  const { execa } = await import("execa"), { fileURLToPath } = await import("node:url");
  const fixture = fileURLToPath(new URL("./fixtures/arena-resume-interrupt.ts", import.meta.url));
  await withWorker(async f => {
    await evolve(f); const before = await snapshot(f), configPath = join(f.directory, "config.json");
    await writeFile(configPath, JSON.stringify(f.config));
    const interrupted = await execa(process.execPath, [fixture, configPath], { cwd: f.primary, reject: false, timeout: 5000 });
    expect(interrupted.signal).toBe("SIGTERM"); expect(existsSync(f.lockPath)).toBe(true);
    const retained = JSON.parse(await readFile(f.manifestPath, "utf8"));
    expect(retained.attempts[0].stage).toBe("launch-running");
    expect(retained.attempts[1]).toEqual(f.manifest.attempts[1]);
    const retry = await harness(f); await expect(retry.run()).rejects.toThrow(/lock|active/);
    expect(retry.calls).toEqual([]); expect(await snapshot(f)).toEqual(before);
  });
});
