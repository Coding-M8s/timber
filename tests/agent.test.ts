import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { worktreeFixture } from "./helpers/services";
import { launchAgent, resolveAgentCommand } from "../src/agent";
import type { RepositoryConfig } from "../src/types";

const stub = fileURLToPath(new URL("./fixtures/agent-stub.ts", import.meta.url));
const parent = fileURLToPath(new URL("./fixtures/agent-launch-parent.ts", import.meta.url));
const config = (enabled = false): RepositoryConfig => ({
  baseBranch: null, remote: null, worktreeDir: null, editor: null,
  agent: { command: "codex", args: ["--literal"], enabled },
});

async function temporary(run: (path: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), "timber agent "));
  try { await run(path); } finally { await rm(path, { recursive: true, force: true }); }
}

async function waitForJson(path: string): Promise<any> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch { await Bun.sleep(10); }
  }
  throw new Error("Timed out waiting for agent capture");
}

test("agent policy honors config, overrides, and terminal requirements", async () => {
  for (const enabled of [false, true]) for (const override of [undefined, false, true]) {
    for (const interactive of [false, true]) {
      const loaded = config(enabled);
      if (override === true && !interactive) {
        expect(() => resolveAgentCommand(loaded, override, interactive)).toThrow(/terminal/i);
      } else {
        const wanted = (override ?? enabled) && interactive ? loaded.agent : null;
        expect(resolveAgentCommand(loaded, override, interactive)).toEqual(wanted);
      }
    }
  }
  const absent = { ...config(), agent: null };
  expect(resolveAgentCommand(absent, undefined, true)).toBeNull();
  expect(resolveAgentCommand(absent, false, true)).toBeNull();
  expect(() => resolveAgentCommand(absent, true, true)).toThrow(/configure.*agent/i);
  expect(() => resolveAgentCommand(absent, true, true)).toThrow("timber setup --global");
});

test("agent runs literal args in selected cwd and waits for exit", async () => {
  await temporary(async path => {
    const capture = join(path, "capture.json");
    const literal = ["", "space value", "'quote'", "$(touch SHELL_MARKER)", ";", "$HOME"];
    let settled = false;
    const result = launchAgent(worktreeFixture({ path }), {
      command: process.execPath, args: [stub, "delay", capture, ...literal],
    }).then(value => { settled = true; return value; });
    const recorded = await waitForJson(capture);
    expect(recorded.cwd).toBe(path);
    expect(recorded.args).toEqual(literal);
    expect(settled).toBe(false);
    expect(await result).toEqual({ kind: "exited", exitCode: 0, signal: null });
    expect(await Bun.file(join(path, "SHELL_MARKER")).exists()).toBe(false);
    expect(await launchAgent(worktreeFixture(), null)).toEqual({ kind: "skipped" });
  });
});

test.each([0, 23])("agent propagates exit code %s", async exitCode => {
  await temporary(async path => {
    expect(await launchAgent(worktreeFixture({ path }), {
      command: process.execPath, args: [stub, "exit", join(path, "capture"), String(exitCode)],
    })).toEqual({ kind: "exited", exitCode, signal: null });
  });
});

test.each([["SIGINT", 130], ["SIGTERM", 143]] as const)(
  "agent normalizes child %s to %s", async (signal, exitCode) => {
      await temporary(async path => {
      expect(await launchAgent(worktreeFixture({ path }), {
        command: process.execPath, args: [stub, "signal", join(path, "capture"), signal],
      })).toEqual({ kind: "exited", exitCode, signal });
    });
  },
);

test("startup failures preserve workspace, hide arguments, and provide a quoted retry", async () => {
  await temporary(async directory => {
    const path = join(directory, "tree 'quoted'");
    await mkdir(path);
    await writeFile(join(path, ".env"), "test-only-value");
    const denied = join(directory, "denied");
    await writeFile(denied, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    for (const [command, args, cwd] of [
      [join(directory, "missing"), ["secret-test-sentinel"], path],
      [denied, [], path],
      [process.execPath, ["invalid\0secret-test-sentinel"], path],
      [process.execPath, [], join(path, "missing")],
    ] as const) {
      const result = await launchAgent(worktreeFixture({ path: cwd }), { command, args });
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") throw new Error("Expected startup failure");
      expect(result.message).toMatch(/workspace|worktree/i);
      expect(result.message).not.toContain("secret-test-sentinel");
      expect(result.retryCommand).toContain("timber open --agent --no-editor -- ");
      if (cwd === path) expect(result.retryCommand).toContain("'\\''");
    }
    expect(await readFile(join(path, ".env"), "utf8")).toBe("test-only-value");
  });
});

test.each([["SIGINT", 130], ["SIGTERM", 143]] as const)(
  "wrapper forwards %s and waits until owned child exits", async (signal, exitCode) => {
    await temporary(async path => {
      const capture = join(path, "capture");
      const report = join(path, "report");
      const payload = join(path, "payload");
      await writeFile(payload, JSON.stringify({
        cwd: path, command: { command: process.execPath, args: [stub, "hold", capture] },
      }));
      const wrapper = execa(process.execPath, [parent, payload, report], { reject: false, timeout: 5000 });
      try {
        const recorded = await waitForJson(capture);
        wrapper.kill(signal);
        const result = await wrapper;
        expect(result.exitCode).toBe(exitCode);
        expect(() => process.kill(recorded.pid, 0)).toThrow();
        const summary = await waitForJson(report);
        expect(summary.before).toEqual(summary.after);
        expect(summary.results[0].exitCode).toBe(exitCode);
      } finally { wrapper.kill("SIGKILL"); }
    });
  },
);

test("repeated success and spawn failure restore parent signal listeners", async () => {
  await temporary(async path => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    for (let i = 0; i < 3; i++) {
      await launchAgent(worktreeFixture({ path }), {
        command: process.execPath, args: [stub, "exit", join(path, "capture"), "0"],
      });
      await launchAgent(worktreeFixture({ path }), { command: join(path, "absent"), args: [] });
    }
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
});

const ptyRunner = fileURLToPath(new URL("./helpers/pty-runner.py", import.meta.url));

test.each([false, true])("foreground terminal inheritance and Ctrl-C=%s", async interrupt => {
  await temporary(async path => {
    const capture = join(path, "capture"), report = join(path, "report");
    const payload = join(path, "payload"), ptyPayload = join(path, "pty.json");
    await writeFile(payload, JSON.stringify({
      cwd: path, command: { command: process.execPath, args: [stub, interrupt ? "hold" : "stdin", capture] },
    }));
    await writeFile(ptyPayload, JSON.stringify({
      cwd: path, command: [process.execPath, parent, payload, report],
      ...(interrupt ? { interrupt: true } : { input: "hello agent\n" }),
    }));
    const run = await execa("python3", ["-B", ptyRunner, ptyPayload], { timeout: 8000 });
    const result = JSON.parse(run.stdout);
    expect(result.exitCode).toBe(interrupt ? 130 : 0);
    const recorded = await waitForJson(capture);
    expect(recorded.stdinTTY).toBe(true);
    expect(recorded.stdoutTTY).toBe(true);
    expect(() => process.kill(recorded.pid, 0)).toThrow();
    if (!interrupt) expect(result.output).toContain("AGENT_INPUT:hello agent");
    const summary = await waitForJson(report);
    expect(summary.before).toEqual(summary.after);
  });
});

test("one terminal Ctrl-C reaches a handling agent once and preserves its eventual exit status", async () => {
  await temporary(async path => {
    const capture = join(path, "capture"), report = join(path, "report");
    const payload = join(path, "payload"), ptyPayload = join(path, "pty.json");
    await writeFile(payload, JSON.stringify({
      cwd: path, command: { command: process.execPath, args: [stub, "catch-interrupt", capture] },
    }));
    await writeFile(ptyPayload, JSON.stringify({
      cwd: path, command: [process.execPath, parent, payload, report], interrupt: true,
    }));
    const run = await execa("python3", ["-B", ptyRunner, ptyPayload], { timeout: 8000 });
    const result = JSON.parse(run.stdout);
    expect(result.output.match(/AGENT_INTERRUPT:/g)).toHaveLength(1);
    expect(result.exitCode).toBe(0);
    const summary = await waitForJson(report);
    expect(summary.results).toEqual([{ kind: "exited", exitCode: 0, signal: null }]);
    expect(summary.before).toEqual(summary.after);
  });
});

test("PTY runner drains buffered diagnostics after observing child exit", async () => {
  await temporary(async path => {
    const payload = join(path, "pty.json");
    await writeFile(payload, JSON.stringify({
      cwd: path,
      command: ["python3", "-c", "import os, sys; os.write(1, b'initial output\\nfinal diagnostic\\n'); sys.exit(23)"],
    }));
    // Force a short read and reap the real child before its remaining output is read.
    const schedule = `
import os, runpy, sys
read, waitpid = os.read, os.waitpid
os.read = lambda fd, size: read(fd, min(size, 7))
os.waitpid = lambda pid, options: waitpid(pid, 0)
sys.argv = [sys.argv[1], sys.argv[2]]
runpy.run_path(sys.argv[0], run_name="__main__")
`;
    const run = await execa("python3", ["-B", "-c", schedule, ptyRunner, payload], { timeout: 8000 });
    const result = JSON.parse(run.stdout);
    expect(result.exitCode).toBe(23);
    expect(result.output).toContain("initial output");
    expect(result.output).toContain("final diagnostic");
  });
});
