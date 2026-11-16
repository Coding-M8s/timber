import { expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withArena, arenaConfig, type ArenaFixture } from "./arena";
import { git } from "./git";
import { discoverRepository } from "../../src/git/repository";
import { readArena, openArenaForResume, validateArenaAttempt } from "../../src/arena/storage";
import { runSetup } from "../../src/hooks";
import type { CommandContext } from "../../src/services";
import type { ArenaResumeServices } from "../../src/arena/services";
import type { ArenaResumeOptions } from "../../src/arena/types";

// Shared fixtures for the tests/arena-resume-*.integration.test.ts files.
export const workerConfig = { ...arenaConfig, arena: { agents: { worker: {
  tool: "wrapper" as const, command: process.execPath, args: ["literal ; $(never)"] } } } };
const groups = [{ kind: "preset" as const, preset: "worker", count: 2 }];
export const withWorker = (run: (f: ArenaFixture) => Promise<void>) => withArena(run, workerConfig, groups);

export async function harness(f: ArenaFixture, overrides: Partial<ArenaResumeServices> = {}) {
  const { createArenaResumeHandler } = await import("../../src/commands/arena-resume");
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
export async function snapshot(f: ArenaFixture) {
  const a = f.manifest.attempts[0]!;
  return { refs: await git(f.primary, "show-ref"), worktrees: await git(f.primary, "worktree", "list", "--porcelain"),
    head: await git(a.path, "rev-parse", "HEAD"), files: await Promise.all(["tracked.txt", "untracked", ".env"].map(p => readFile(join(a.path, p), "utf8"))) };
}
export async function evolve(f: ArenaFixture) {
  const path = f.manifest.attempts[0]!.path;
  await writeFile(join(path, "tracked.txt"), "committed progress\n");
  await git(path, "add", "tracked.txt");
  await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "attempt progress");
  await writeFile(join(path, "tracked.txt"), "dirty progress\n");
  await writeFile(join(path, "untracked"), "untracked progress\n");
  await writeFile(join(path, ".env"), "ignored progress\n");
}
