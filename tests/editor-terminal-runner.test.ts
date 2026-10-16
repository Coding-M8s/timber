import { expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { createTerminalRequest, RunnerStartupFailure } from "../src/editor-terminals/request";
import * as protocol from "../src/editor-terminals/protocol";

const self = { executable: process.execPath, entry: resolve("src/index.ts") };

test("runner executes literal agent argv/context in exact cwd and acknowledges spawn before exit", async () => {
  const cwd = await mkdtemp('/tmp/timber-runner spaces $()-');
  const capture = join(cwd, "capture.json");
  const fixture = join(cwd, "fixture.ts");
  await writeFile(fixture, 'await Bun.write(process.argv[2]!, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(3),repo:process.env.TIMBER_REPO,branch:process.env.TIMBER_BRANCH,workflow:process.env.TIMBER_WORKFLOW,task:process.env.TIMBER_TASK_ID,orca:process.env.ORCA_WORKTREE_ID})); await Bun.sleep(500);');
  const literal = ["a b", "$(touch INJECTED)", "'\";x", "line\nbreak"];
  const request = await createTerminalRequest({ kind: "agent", cwd, repositoryRoot: cwd,
    branch: "TIM-27-$(touch INJECTED)", workflow: "review", command: process.execPath,
    args: [fixture, capture, ...literal] }, self);
  const child = execa("/bin/sh", ["-c", request.bootstrap], { env: { ORCA_WORKTREE_ID: "target-identity", TIMBER_TASK_ID: "stale" }, reject: false });
  let exited = false;
  void child.then(() => { exited = true; });
  try {
    await request.waitStarted(3000);
    expect(exited).toBe(false);
    for (let i = 0; i < 100; i++) { try { await readFile(capture); break; } catch { await Bun.sleep(10); } }
    expect(JSON.parse(await readFile(capture, "utf8"))).toEqual({ cwd, args: literal, repo: cwd,
      branch: "TIM-27-$(touch INJECTED)", workflow: "review", task: "TIM-27", orca: "target-identity" });
    expect(await Bun.file(join(cwd, "INJECTED")).exists()).toBe(false);
    await request.cleanup(); // Agent does not need request data after spawn acknowledgement.
    expect((await child).exitCode).toBe(0);
  } finally { await request.cleanup(); await rm(cwd, { recursive: true, force: true }); }
});

test("runner setup stays sequential, clears stale context, and returns the failed step", async () => {
  const cwd = await mkdtemp("/tmp/timber-runner-setup-");
  const request = await createTerminalRequest({ kind: "setup", cwd, repositoryRoot: cwd, branch: null,
    hooks: ['printf "one:%s:%s\\n" "$TIMBER_WORKFLOW" "$TIMBER_TASK_ID" >> steps', 'sleep 0.05; printf "two\\n" >> steps'],
    workflowHooks: ['printf "workflow\\n" >> steps; exit 7', 'touch NEVER'] }, self);
  const child = execa("/bin/sh", ["-c", request.bootstrap], {
    env: { TIMBER_WORKFLOW: "stale", TIMBER_TASK_ID: "stale" }, reject: false });
  try {
    await request.waitStarted(3000);
    const result = await request.waitSetup();
    expect(result).toMatchObject({ kind: "setup-failed", step: 3, phase: "workflow", reason: "exit code 7" });
    expect(await readFile(join(cwd, "steps"), "utf8")).toBe("one::\ntwo\nworkflow\n");
    expect(await Bun.file(join(cwd, "NEVER")).exists()).toBe(false);
    expect((await child).exitCode).toBe(1);
  } finally { await request.cleanup(); await rm(cwd, { recursive: true, force: true }); }
});

test("agent startup failure hides raw command and arguments", async () => {
  const request = await createTerminalRequest({ kind: "agent", cwd: "/tmp", repositoryRoot: "/tmp", branch: null,
    command: "/missing/secret-sentinel", args: ["secret-sentinel"] }, self);
  const child = execa("/bin/sh", ["-c", request.bootstrap], { reject: false });
  try {
    await expect(request.waitStarted(3000)).rejects.toThrow(/start/);
    const result = await child;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("secret-sentinel");
  } finally { await request.cleanup(); }
});

test.each(["startup-failed", "spawned"])("startup observation rechecks final status when the runner exits during inspection: %s", async final => {
  const request = await createTerminalRequest({ kind: "agent", cwd: "/tmp", repositoryRoot: "/tmp", branch: null,
    command: "/bin/true", args: [] }, self);
  const identity = (await protocol.processIdentity())!;
  await rename(join(request.directory, "request.json"), join(request.directory, "claimed.json"));
  await protocol.publish(request.directory, "started.json", { kind: "starting", identity });
  // Keep real atomic status files. Simulate the runner publishing its final
  // acknowledgement/result and exiting between the status read and liveness read.
  const inspection = spyOn(protocol, "processIdentity").mockImplementation(async () => {
    if (final === "startup-failed") await protocol.publish(request.directory, "result.json", { kind: final });
    else await protocol.publish(request.directory, "started.json", { kind: final, identity });
    return null;
  });
  try {
    if (final === "startup-failed") await expect(request.waitStarted(1000)).rejects.toBeInstanceOf(RunnerStartupFailure);
    else await request.waitStarted(1000);
  } finally { inspection.mockRestore(); await request.cleanup(); }
});

test("unconsumed timeout fences a delayed runner instead of executing it later", async () => {
  const request = await createTerminalRequest({ kind: "agent", cwd: "/tmp", repositoryRoot: "/tmp", branch: null,
    command: "/bin/true", args: [] }, self);
  try {
    await expect(request.waitStarted(30)).rejects.toThrow(/before.*start|not.*start/i);
    expect((await execa("/bin/sh", ["-c", request.bootstrap], { reject: false })).exitCode).toBe(1);
  } finally { await request.cleanup(); }
});

test("runner refuses readable-by-others request data", async () => {
  const request = await createTerminalRequest({ kind: "agent", cwd: "/tmp", repositoryRoot: "/tmp", branch: null,
    command: "/bin/true", args: [] }, self);
  try {
    await chmod(join(request.directory, "request.json"), 0o644);
    const result = await execa("/bin/sh", ["-c", request.bootstrap], { reject: false });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("private");
  } finally { await request.cleanup(); }
});

test("terminal Ctrl-C leaves the runner awaiting an agent that treats interrupt as cancel", async () => {
  const cwd = await mkdtemp("/tmp/timber-runner-interrupt-");
  const capture = join(cwd, "capture");
  const request = await createTerminalRequest({ kind: "agent", cwd, repositoryRoot: cwd, branch: null,
    command: process.execPath, args: [resolve("tests/fixtures/agent-stub.ts"), "catch-interrupt", capture] }, self);
  const payload = join(cwd, "pty.json");
  await writeFile(payload, JSON.stringify({ cwd, command: ["/bin/sh", "-c", `exec ${request.bootstrap}`], interrupt: true }));
  try {
    const result = await execa("python3", [resolve("tests/helpers/pty-runner.py"), payload]);
    const report = JSON.parse(result.stdout);
    expect(report.exitCode).toBe(0);
    expect(report.output).toContain("AGENT_INTERRUPT:1");
    expect(report.output).not.toContain("AGENT_INTERRUPT:2");
  } finally { await request.cleanup(); await rm(cwd, { recursive: true, force: true }); }
});

test("consumed request with delayed acknowledgement is uncertain and cannot be fenced for replay", async () => {
  const request = await createTerminalRequest({ kind: "agent", cwd: "/tmp", repositoryRoot: "/tmp", branch: null,
    command: "/bin/true", args: [] }, self);
  try {
    await rename(join(request.directory, "request.json"), join(request.directory, "claimed.json"));
    await expect(request.waitStarted(30)).rejects.toThrow(/uncertain.*inspect/);
    expect(await request.fence()).toBe(false);
    expect(await Bun.file(join(request.directory, "claimed.json")).exists()).toBe(true);
  } finally { await request.cleanup(); }
});

test("claim and cancellation race never executes an agent after successful fencing", async () => {
  const cwd = await mkdtemp("/tmp/timber-runner-race-");
  try {
    for (const delay of [0, 30, 80, 150]) {
      const marker = `started-${delay}`;
      const request = await createTerminalRequest({ kind: "agent", cwd, repositoryRoot: cwd, branch: null,
        command: "/bin/sh", args: ["-c", `printf once > ${marker}`] }, self);
      const child = execa("/bin/sh", ["-c", request.bootstrap], { reject: false });
      try {
        await Bun.sleep(delay);
        const cancelled = await request.fence();
        await child;
        expect(await Bun.file(join(cwd, marker)).exists()).toBe(!cancelled);
        if (!cancelled) await request.waitStarted(1000);
      } finally { await request.cleanup(); }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
