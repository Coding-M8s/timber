import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { withArena, arenaConfig } from "./helpers/arena";
import { git } from "./helpers/git";
import { evolve, harness, snapshot, withWorker, workerConfig } from "./helpers/arena-resume";
import { readArena, openArenaForResume } from "../src/arena/storage";
import type { ArenaResumeOptions } from "../src/arena/types";

for (const tamper of ["branch", "marker", "recreated"]) test(`${tamper} corruption refuses resume without external actions or recreation`, async () => {
  await withWorker(async f => {
    const a = f.manifest.attempts[0]!;
    if (tamper === "branch") await git(a.path, "checkout", "--detach");
    if (tamper === "marker") await unlink(join(a.worktreeGitDir!, "timber/arena.json"));
    if (tamper === "recreated") { await git(f.primary, "worktree", "remove", a.path); await git(f.primary, "worktree", "add", a.path, a.branch); }
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

for (const [stage, failedStage] of [["ready", "setup"]] as const)
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

for (const cause of ["setup", "editor", "identity"] as const)
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
    const interrupted = await execa(process.execPath, [fixture, configPath], { cwd: f.primary, reject: false, timeout: 30_000 });
    expect(interrupted.signal).toBe("SIGTERM"); expect(existsSync(f.lockPath)).toBe(true);
    const retained = JSON.parse(await readFile(f.manifestPath, "utf8"));
    expect(retained.attempts[0].stage).toBe("launch-running");
    expect(retained.attempts[1]).toEqual(f.manifest.attempts[1]);
    const retry = await harness(f); await expect(retry.run()).rejects.toThrow(/lock|active/);
    expect(retry.calls).toEqual([]); expect(await snapshot(f)).toEqual(before);
  });
});
