import { expect, test } from "bun:test";
import { execa } from "execa";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, placeholderHandlers } from "../src/cli";
import { candidates } from "./helpers/completion";
import { withArena, arenaConfig } from "./helpers/arena";
import { git, withRepository } from "./helpers/git";
import { readArena } from "../src/arena/storage";
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const runner = fileURLToPath(new URL("./helpers/pty-runner.py", import.meta.url));
const stub = fileURLToPath(new URL("./fixtures/arena-agent-stub.ts", import.meta.url));

test("resume CLI normalizes explicit options, propagates numeric exit and rejects conflicting editor flags", async () => {
  let received: unknown; let error = "";
  const context = { cwd: "/repo", io: { stdout(_s: string) {}, stderr(s: string) { error += s; } } };
  const handlers = { ...placeholderHandlers, arenaResume: async (...args: unknown[]) => { received = args; return 143; } };
  expect(await runCli(["arena", "resume", "demo", "--attempt", "worker-1", "--setup", "--no-agent", "--no-editor"], { context, handlers })).toBe(143);
  expect(received).toEqual(["demo", { attempt: "worker-1", setup: true, agent: false, editor: false }, context]);
  received = undefined;
  expect(await runCli(["arena", "resume", "demo", "--editor", "--no-editor"], { context, handlers })).toBe(1);
  expect(received).toBeUndefined(); expect(error).toContain("Conflicting");
  expect(await runCli(["arena", "resume", "demo"], { context })).toBe(1);
  expect(error).toContain("handler is unavailable");
});

test("resume help/completion advertise exact selection and explicit setup without reading configuration", async () => {
  expect(await candidates("timber arena ")).toEqual(["help", "new", "pick", "resume"]);
  expect(await candidates("timber arena resume demo --att")).toEqual(["--attempt"]);
  expect(await candidates("timber arena resume demo --no-")).toEqual(["--no-agent", "--no-editor"]);
  const result = await execa(process.execPath, [entry, "arena", "resume", "--help"]);
  expect(result.stdout).toContain("--setup"); expect(result.stdout).toContain("conversation");
});

test("real unattended/manual resume and picker cancellation preserve records, refs, task and content", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[0]!;
    await writeFile(join(a.path, "tracked.txt"), "changed"); await writeFile(join(a.path, "untracked"), "untracked"); await writeFile(join(a.path, ".env"), "ignored");
    const before = await readFile(f.manifestPath), task = await readFile(f.taskPath), refs = await git(f.primary, "show-ref"), trees = await git(f.primary, "worktree", "list", "--porcelain");
    for (const args of [["--attempt", "manual-1", "--no-agent", "--no-editor"], []]) {
      const result = await execa(process.execPath, [entry, "arena", "resume", "demo", ...args], { cwd: a.path, env: { CI: "1" }, reject: false });
      expect(result.exitCode).toBe(args.length ? 0 : 1);
      if (!args.length) expect(result.stderr).toContain("--attempt");
      expect(result.stdout + result.stderr).not.toContain("PRIVATE_TASK_SENTINEL");
    }
    const payload = join(f.directory, "cancel.json");
    await writeFile(payload, JSON.stringify({ cwd: f.primary, command: [process.execPath, entry, "arena", "resume", "demo", "--no-agent", "--no-editor"], input: "q\n", sendAt: "Choose 1-", env: { CI: "false" } }));
    const cancelled = JSON.parse((await execa("python3", ["-B", runner, payload], { timeout: 8000 })).stdout);
    expect(cancelled.exitCode).toBe(0); expect(cancelled.output).toContain("Cancelled.");
    expect(await readFile(f.manifestPath)).toEqual(before); expect(await readFile(f.taskPath)).toEqual(task);
    expect(await git(f.primary, "show-ref")).toBe(refs); expect(await git(f.primary, "worktree", "list", "--porcelain")).toBe(trees);
    expect(await readFile(join(a.path, "tracked.txt"), "utf8")).toBe("changed"); expect(await readFile(join(a.path, "untracked"), "utf8")).toBe("untracked"); expect(await readFile(join(a.path, ".env"), "utf8")).toBe("ignored");
  });
});

for (const [mode, code] of [["success", 0], ["nonzero", 17], ["interrupt", 130], ["hold", 130], ["parent-terminate", 143]] as const)
test(`real resumed wrapper ${mode} uses foreground task/argv/cwd and retains files`, async () => {
  const preset = { tool: "wrapper" as const, command: process.execPath, args: [stub, "literal ; $(never)", mode] };
  const config = { ...arenaConfig, arena: { agents: { worker: preset } } };
  await withArena(async f => {
    const a = f.manifest.attempts[0]!;
    await writeFile(join(f.primary, ".timber.toml"), `[arena.agents.worker]\ntool="wrapper"\ncommand=${JSON.stringify(preset.command)}\nargs=${JSON.stringify(preset.args)}\n`);
    await writeFile(join(a.path, "tracked.txt"), "modified"); await writeFile(join(a.path, "untracked"), "untracked"); await writeFile(join(a.path, ".env"), "ignored");
    const refs = await git(f.primary, "show-ref"), trees = await git(f.primary, "worktree", "list", "--porcelain");
    const payload = join(f.directory, "resume.json"), capture = join(f.directory, "capture.jsonl");
    await writeFile(payload, JSON.stringify({ cwd: a.path, command: [process.execPath, entry, "arena", "resume", "demo", "--attempt", "worker-1", "--no-editor"],
      ...(mode === "hold" ? { interrupt: true } : {}), env: { CI: "false", ARENA_CAPTURE: capture, TIMBER_WORKFLOW: "inherited", TIMBER_TASK_ID: "inherited" } }));
    const result = JSON.parse((await execa("python3", ["-B", runner, payload], { timeout: 8000 })).stdout);
    expect(result.exitCode).toBe(code);
    const rows = (await readFile(capture, "utf8")).trim().split("\n").map(s => JSON.parse(s));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task: "PRIVATE_TASK_SENTINEL\n' $(touch NEVER)\n", taskFile: f.taskPath,
      cwd: a.path, worktree: a.path, args: ["literal ; $(never)", mode], stdinTTY: true, stdoutTTY: true, workflow: null, taskId: null });
    expect(() => process.kill(rows[0].pid, 0)).toThrow();
    expect(result.output).not.toContain("PRIVATE_TASK_SENTINEL");
    expect(await git(f.primary, "show-ref")).toBe(refs); expect(await git(f.primary, "worktree", "list", "--porcelain")).toBe(trees);
    for (const [file, expected] of [["tracked.txt", "modified"], ["untracked", "untracked"], [".env", "ignored"]] as const) expect(await readFile(join(a.path, file), "utf8")).toBe(expected);
    const saved = (await readArena(f.repository, "demo")).manifest;
    expect(saved.attempts[0]!.exitCode).toBe(code); expect(saved.attempts[1]).toEqual(f.manifest.attempts[1]);
    expect(existsSync(f.lockPath)).toBe(false);
  }, config, [{ kind: "preset", preset: "worker", count: 2 }]);
});

test("resumed Claude receives exact model/effort and synchronized child environment without discovery", async () => {
  await withArena(async f => {
    const bin = join(f.directory, "bin"); await mkdir(bin);
    const executable = join(bin, "claude");
    await writeFile(executable, `#!${process.execPath}\n` + await readFile(stub, "utf8")); await chmod(executable, 0o755);
    const capture = join(f.directory, "capture.jsonl"), payload = join(f.directory, "claude.json");
    await writeFile(payload, JSON.stringify({ cwd: f.primary, command: [process.execPath, entry, "arena", "resume", "demo", "--attempt", "claude-1", "--no-editor"],
      env: { CI: "false", PATH: `${bin}:${process.env.PATH}`, ARENA_CAPTURE: capture, CLAUDE_CODE_EFFORT_LEVEL: "low" } }));
    const result = JSON.parse((await execa("python3", ["-B", runner, payload], { timeout: 8000 })).stdout);
    expect(result.exitCode).toBe(0);
    const row = JSON.parse((await readFile(capture, "utf8")).trim());
    expect(row.args.slice(0, 5)).toEqual(["--model", "sonnet", "--effort", "high", "--"]);
    expect(row.effort).toBe("high"); expect(row.taskFile).toBe(f.taskPath); expect(row.stdinTTY).toBe(true);
  }, arenaConfig, [{ kind: "harness", harness: "claude", model: "sonnet", effort: "high", count: 2 }]);
});

test("executing arena-new setup recovery hint retains no-agent/no-editor and preserves existing work", async () => {
  await withRepository(async (primary, directory) => {
    const configPath = join(primary, ".timber.toml");
    const configuration = (hook: string) => `[editor]\nenabled=true\ncommand=${JSON.stringify(join(directory, "missing-editor"))}\n[hooks]\npost_create=${JSON.stringify([hook])}\n[arena.agents.worker]\ntool="wrapper"\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([stub, "success"])}\n`;
    await writeFile(configPath, configuration("exit 9"));
    const failed = await execa(process.execPath, [entry, "arena", "new", "demo", "--base", "trunk", "--preset", "worker", "--runs", "2", "--prompt", "PRIVATE_TASK_SENTINEL", "--no-agent", "--no-editor"], { cwd: primary, env: { CI: "1" }, reject: false });
    expect(failed.exitCode).toBe(1);
    const retry = failed.stderr.match(/^\s*(timber arena resume [^\n]+)/m)?.[1];
    expect(retry).toBeDefined();
    const { discoverRepository } = await import("../src/git/repository");
    const repo = await discoverRepository(primary), saved = await readArena(repo, "demo"), a = saved.manifest.attempts[0]!;
    await writeFile(join(a.path, "tracked.txt"), "retained changes");
    await writeFile(join(a.path, "untracked"), "retained untracked"); await writeFile(join(a.path, ".env"), "retained ignored");
    const refs = await git(primary, "show-ref"), trees = await git(primary, "worktree", "list", "--porcelain"), task = await readFile(saved.taskPath);
    await writeFile(configPath, configuration("printf prepared > setup-retried"));
    const retried = await execa(process.execPath, [entry, ...retry!.split(" ").slice(1)], { cwd: primary, env: { CI: "1" }, reject: false });
    expect(retried.exitCode).toBe(0);
    expect(await readFile(join(a.path, "setup-retried"), "utf8")).toBe("prepared");
    expect(await readFile(join(a.path, "tracked.txt"), "utf8")).toBe("retained changes");
    expect(await readFile(join(a.path, "untracked"), "utf8")).toBe("retained untracked"); expect(await readFile(join(a.path, ".env"), "utf8")).toBe("retained ignored");
    expect(await git(primary, "show-ref")).toBe(refs); expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
    expect(await readFile(saved.taskPath)).toEqual(task); expect(retried.stdout + retried.stderr).not.toContain("PRIVATE_TASK_SENTINEL");
    expect((await readArena(repo, "demo")).manifest.attempts[1]).toEqual(saved.manifest.attempts[1]);
  });
});
