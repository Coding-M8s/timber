import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { withArena, arenaConfig, type ArenaFixture } from "./helpers/arena";
import { git, withRepository } from "./helpers/git";
import { runAppArena, type AppArenaServices } from "../src/commands/app-arena";
import { createArenaResumeHandler } from "../src/commands/arena-resume";
import { createArenaPickHandler } from "../src/commands/arena-pick";
import { discoverRepository } from "../src/git/repository";
import { cleanupWorktree } from "../src/git/cleanup";
import { readArena, openArenaForResume, openArenaForPick, readArenaPick, validateArenaAttempt } from "../src/arena/storage";
import { summarizeArenaAttempt, inspectArenaRemoval } from "../src/arena/summary";
import { archiveArenaAttempt } from "../src/arena/archive";
import type { CommandContext } from "../src/services";
import type { ArenaAttemptGroup } from "../src/arena/types";
import type { ExecutableCommand } from "../src/types";

const SENTINEL = "PRIVATE_TASK_SENTINEL";

/** Every file's bytes under the fixture directory: repository, .git, worktrees and arena records. */
async function everything(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files[relative(root, path)] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  };
  await walk(root);
  return files;
}

async function state(f: ArenaFixture) {
  return { files: await everything(f.directory), refs: await git(f.primary, "show-ref"),
    worktrees: await git(f.primary, "worktree", "list", "--porcelain") };
}

function app(cwd: string, overrides: Partial<AppArenaServices> = {}) {
  let stdout = "", stderr = "";
  const context: CommandContext = { cwd, io: { stdout(s) { stdout += s; }, stderr(s) { stderr += s; } } };
  const services: AppArenaServices = { discoverRepository, loadConfig: async () => arenaConfig,
    checkExecutable: async () => true, ...overrides };
  return {
    run: async (action: string, name?: string, options: { attempt?: string } = {}) => {
      stdout = ""; stderr = "";
      const code = await runAppArena(action, name, options, context, services);
      return { code, record: JSON.parse(stdout), stdout, stderr };
    },
  };
}

test("list reports each arena and attempt from the records and Git, and changes nothing", async () => {
  await withArena(async f => {
    await writeFile(join(f.manifest.attempts[0]!.path, "work.txt"), "work\n");
    const before = await state(f);
    const { code, record, stdout, stderr } = await app(f.primary).run("list");
    expect(code).toBe(0);
    expect(await state(f)).toEqual(before);
    expect(stdout + stderr).not.toContain(SENTINEL);
    expect(stderr).toBe("");
    expect(record.schemaVersion).toBe(1);
    expect(record.diagnostic).toBeNull();
    expect(record.repository.primaryWorktreeRoot).toBe(f.primary);
    expect(record.arenas).toHaveLength(1);
    const arena = record.arenas[0];
    expect(arena).toMatchObject({ name: "demo", outcome: "read", diagnostic: null, id: f.manifest.id,
      base: { ref: f.manifest.base.ref, commit: f.manifest.base.commit }, active: false, winner: null });
    expect(Number.isNaN(Date.parse(arena.createdAt))).toBe(false);
    expect(arena.attempts).toEqual(f.manifest.attempts.map(a => ({
      label: a.label, tool: "manual", preset: "manual", model: null, effort: null, branch: a.branch, path: a.path,
      state: "prepared", stage: "ready", failedStage: null, exitCode: null, signal: null, archive: null, git: "ok",
    })));
  });
});

test("list reports a removed attempt as missing and a replaced one as stale, never guessing from branches", async () => {
  await withArena(async f => {
    const [kept, removed] = f.manifest.attempts;
    await git(f.primary, "worktree", "remove", "--force", removed!.path);
    // Same branch and path, but not the worktree Timber bound: its identity marker is gone.
    const markers = join(kept!.worktreeGitDir!, "timber", "arena.json");
    await unlink(markers);
    // A branch in the arena namespace that no record mentions is not an attempt.
    await git(f.primary, "branch", "arena/demo/manual-3");
    const before = await state(f);
    const { code, record } = await app(f.primary).run("list");
    expect(await state(f)).toEqual(before);
    expect(code).toBe(0);
    const attempts = record.arenas[0].attempts;
    expect(attempts.map((a: { label: string }) => a.label)).toEqual(["manual-1", "manual-2"]);
    expect(attempts[0].git).toBe("stale");
    expect(attempts[1].git).toBe("missing");
  });
});

test("list reads an arena with an invocation lock and reports it active without touching the lock", async () => {
  await withArena(async f => {
    await writeFile(f.lockPath, "someone-else", { mode: 0o600 });
    const before = await state(f);
    const { code, record } = await app(f.primary).run("list");
    expect(code).toBe(0);
    expect(record.arenas[0]).toMatchObject({ name: "demo", outcome: "read", active: true });
    expect(await state(f)).toEqual(before);
    expect(await readFile(f.lockPath, "utf8")).toBe("someone-else");
  });
});

test("list without arenas is empty and creates no storage", async () => {
  await withRepository(async primary => {
    const { code, record } = await app(primary).run("list");
    expect(code).toBe(0);
    expect(record).toMatchObject({ schemaVersion: 1, diagnostic: null, arenas: [] });
    expect(existsSync(join(primary, ".git", "timber"))).toBe(false);
  });
});

test("a damaged arena is a failed entry with a safe diagnostic, and exits 1", async () => {
  await withArena(async f => {
    await writeFile(f.manifestPath, `{"broken": "${SENTINEL}"`, { mode: 0o600 });
    const { code, record, stdout, stderr } = await app(f.primary).run("list");
    expect(code).toBe(1);
    expect(record.arenas[0]).toMatchObject({ name: "demo", outcome: "failed", attempts: [] });
    expect(record.arenas[0].diagnostic).toMatch(/manifest|arena/i);
    expect(stdout + stderr).not.toContain(SENTINEL);
  });
});

test("list outside a repository is a failed record", async () => {
  await withRepository(async (_primary, directory) => {
    const { code, record } = await app(directory).run("list");
    expect(code).toBe(1);
    expect(record).toMatchObject({ schemaVersion: 1, repository: null, arenas: [] });
    expect(typeof record.diagnostic).toBe("string");
  });
});

test("after pick, the winner is picked and an archived loser points at its live archive ref", async () => {
  await withArena(async f => {
    const [winner, loser] = f.manifest.attempts;
    await writeFile(join(loser!.path, "loser.txt"), "unique\n");
    let out = "";
    const context: CommandContext = { cwd: f.primary, io: { stdout(s) { out += s; }, stderr(s) { out += s; } } };
    const pick = createArenaPickHandler({ discoverRepository, loadConfig: async () => ({ ...f.config, baseBranch: "trunk" }),
      readArena, readArenaPick, openArenaForPick, validateArenaAttempt, summarizeArenaAttempt, inspectArenaRemoval,
      archiveArenaAttempt, cleanupWorktree });
    expect(await pick("demo", { winner: winner!.label }, context)).toBe(0);
    const { record } = await app(f.primary).run("list");
    const [w, l] = record.arenas[0].attempts;
    expect(record.arenas[0].winner).toBe(winner!.label);
    expect(w).toMatchObject({ state: "picked", git: "ok", archive: null });
    expect(l).toMatchObject({ state: "archived", git: "missing" });
    expect(l.archive).toMatchObject({ ref: `refs/timber/arena/demo/${loser!.label}`, present: true });
    expect(await git(f.primary, "rev-parse", l.archive.ref)).toBe(l.archive.commit);
    await git(f.primary, "update-ref", "-d", l.archive.ref);
    expect((await app(f.primary).run("list")).record.arenas[0].attempts[1].archive.present).toBe(false);
  });
});

test("list maps recorded stages to states and keeps the raw stage", async () => {
  await withArena(async f => {
    const cases = [
      ["planned", undefined, "incomplete"], ["created", undefined, "incomplete"], ["setup-running", undefined, "incomplete"],
      ["failed", "creation", "incomplete"], ["failed", "setup", "setup-failed"], ["ready", undefined, "prepared"],
      ["launch-running", undefined, "launched"], ["exited", undefined, "launched"], ["failed", "agent", "launched"],
      ["failed", "editor", "prepared"],
    ] as const;
    for (const [stage, failedStage, expected] of cases) {
      const saved = JSON.parse(await readFile(f.manifestPath, "utf8"));
      saved.attempts[0].stage = stage;
      delete saved.attempts[0].failedStage;
      if (failedStage) saved.attempts[0].failedStage = failedStage;
      if (stage === "exited") { saved.attempts[0].exitCode = 3; saved.attempts[0].signal = null; }
      else { delete saved.attempts[0].exitCode; delete saved.attempts[0].signal; }
      await rm(f.manifestPath);
      await writeFile(f.manifestPath, JSON.stringify(saved), { mode: 0o600 });
      const attempt = (await app(f.primary).run("list")).record.arenas[0].attempts[0];
      expect([stage, attempt.state]).toEqual([stage, expected]);
      expect(attempt.stage).toBe(stage);
      expect(attempt.failedStage).toBe(failedStage ?? null);
      if (stage === "exited") expect(attempt.exitCode).toBe(3);
    }
  });
});

const nativeGroups: readonly ArenaAttemptGroup[] = [
  { kind: "harness", harness: "codex", model: "gpt-5-codex", effort: "high", count: 1 },
  { kind: "harness", harness: "claude", model: "opus", effort: "high", count: 1 },
  { kind: "harness", harness: "cursor", model: "sonnet-4", count: 1 },
  { kind: "harness", harness: "manual", model: null, count: 1 },
];

test("launch gives exactly the command and environment arena resume runs, for every tool", async () => {
  await withArena(async f => {
    const client = app(f.primary);
    for (const attempt of f.manifest.attempts) {
      const before = await state(f);
      const { code, record, stdout, stderr } = await client.run("launch", "demo", { attempt: attempt.label });
      expect(await state(f)).toEqual(before);
      expect(code).toBe(0);
      expect(stdout + stderr).not.toContain(SENTINEL);
      expect(record).toMatchObject({ schemaVersion: 1, arena: "demo", attempt: attempt.label, diagnostic: null });

      let launched: { command: ExecutableCommand | null; env: NodeJS.ProcessEnv | undefined; cwd: string } | undefined;
      const resume = createArenaResumeHandler({ discoverRepository, loadConfig: async () => arenaConfig, readArena,
        openArenaForResume, validateArenaAttempt, checkExecutable: async () => true,
        runSetup: async () => {}, launchEditor: async () => ({ kind: "skipped" }),
        launchAgent: async (tree, command, env) => {
          launched = { command, env, cwd: tree.path };
          return { kind: "exited", exitCode: 0, signal: null };
        } });
      const context: CommandContext = { cwd: f.primary, interactive: true, io: { stdout() {}, stderr() {} } };
      expect(await resume("demo", { attempt: attempt.label, editor: false }, context)).toBe(0);

      if (attempt.tool === "manual") {
        expect(record.outcome).toBe("no-agent");
        expect(record.launch).toBeNull();
        expect(launched).toBeUndefined();
        continue;
      }
      expect(record.outcome).toBe("ready");
      expect(launched).toBeDefined();
      const env = launched!.env!;
      expect(record.launch).toEqual({
        argv: [launched!.command!.command, ...launched!.command!.args],
        cwd: launched!.cwd,
        environment: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)),
        unset: Object.entries(env).filter(([, v]) => v === undefined).map(([k]) => k).sort(),
      });
      expect(record.launch.unset).toEqual(["TIMBER_TASK_ID", "TIMBER_WORKFLOW"]);
      expect(await readFile(record.launch.environment.TIMBER_TASK_FILE, "utf8")).toContain(SENTINEL);
      expect(record.launch.argv.join(" ")).not.toContain(SENTINEL);
    }
    const argv0 = async (label: string) => (await client.run("launch", "demo", { attempt: label })).record.launch.argv;
    expect((await argv0("codex-1")).slice(0, 5)).toEqual(["codex", "--model", "gpt-5-codex", "--config", 'model_reasoning_effort="high"']);
    expect((await argv0("claude-1")).slice(0, 5)).toEqual(["claude", "--model", "opus", "--effort", "high"]);
    expect((await argv0("cursor-1")).slice(0, 3)).toEqual(["cursor-agent", "--model", "sonnet-4"]);
    expect((await client.run("launch", "demo", { attempt: "claude-1" })).record.launch.environment.CLAUDE_CODE_EFFORT_LEVEL).toBe("high");
  }, arenaConfig, nativeGroups);
});

test("launch refuses what resume refuses, with a failed record and nothing changed", async () => {
  await withArena(async f => {
    const label = "codex-1";
    const check = async (client: ReturnType<typeof app>, pattern: RegExp, attempt = label) => {
      const before = await state(f);
      const { code, record, stdout, stderr } = await client.run("launch", "demo", { attempt });
      expect(await state(f)).toEqual(before);
      expect(code).toBe(1);
      expect(record).toMatchObject({ outcome: "failed", launch: null });
      expect(record.diagnostic).toMatch(pattern);
      expect(stdout + stderr).not.toContain(SENTINEL);
    };
    await check(app(f.primary), /--attempt|exact|attempt/i, "nope-1");
    await check(app(f.primary, { checkExecutable: async () => false }), /executable/i);

    const edit = async (change: (attempt: Record<string, unknown>) => void) => {
      const saved = JSON.parse(await readFile(f.manifestPath, "utf8"));
      change(saved.attempts[0]);
      await rm(f.manifestPath);
      await writeFile(f.manifestPath, JSON.stringify(saved), { mode: 0o600 });
    };
    const fingerprint = f.manifest.attempts[0]!.configFingerprint;
    await edit(a => { a.configFingerprint = "0".repeat(64); });
    await check(app(f.primary), /configuration is missing or changed/i);
    await edit(a => { a.configFingerprint = fingerprint; a.stage = "created"; });
    await check(app(f.primary), /incomplete setup.*--setup/i);
    await edit(a => { a.stage = "launch-running"; });
    await check(app(f.primary), /uncertain/i);
    await edit(a => { a.stage = "ready"; });

    await unlink(join(f.manifest.attempts[0]!.worktreeGitDir!, "timber", "arena.json"));
    await check(app(f.primary), /identity/i);

    await writeFile(f.lockPath, "other", { mode: 0o600 });
    await check(app(f.primary), /active|lock/i);
  }, arenaConfig, nativeGroups);
});

test("unknown action and a launch without --attempt fail before reading anything", async () => {
  await withArena(async f => {
    await expect(app(f.primary).run("remove", "demo")).rejects.toThrow(/list or launch/);
    const { code, record } = await app(f.primary).run("launch", "demo");
    expect(code).toBe(1);
    expect(record.diagnostic).toMatch(/--attempt/);
  });
});

test("tools lists every native tool arena new accepts, without a repository", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const outside = await mkdtemp(join(tmpdir(), "timber-app-arena-tools-"));
  try {
    const discover = async () => { throw new Error("no repository needed"); };
    const { code, record, stderr } = await app(outside, { discoverRepository: discover }).run("tools");
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(record).toEqual({ schemaVersion: 1, tools: [
      { tool: "codex", label: "Codex CLI", executable: "codex", effort: true },
      { tool: "claude", label: "Claude Code", executable: "claude", effort: true },
      { tool: "cursor", label: "Cursor CLI", executable: "cursor-agent", effort: true },
      { tool: "gemini", label: "Gemini CLI", executable: "gemini", effort: false },
      { tool: "grok", label: "Grok Build", executable: "grok", effort: false },
      { tool: "opencode", label: "OpenCode", executable: "opencode", effort: false },
      { tool: "copilot", label: "GitHub Copilot CLI", executable: "copilot", effort: false },
    ] });
    await expect(app(outside).run("tools", "extra")).rejects.toThrow(/no arguments/);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
