import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const runner = fileURLToPath(new URL("./helpers/pty-runner.py", import.meta.url));

async function withPayload(run: (directory: string, payload: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "timber pty "));
  try {
    await run(directory, join(directory, "payload.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("PTY answers split and repeated terminal identity queries before sending input", async () => {
  await withPayload(async (directory, payload) => {
    const source = [
      "import os, tty, time",
      "tty.setraw(0)",
      "for query in [b'\\x1b[0c', b'\\x1b[c']:",
      "    os.write(1, query[:2])",
      "    time.sleep(0.03)",
      "    os.write(1, query[2:])",
      "    response = b''",
      "    while not response.endswith(b'c'): response += os.read(0, 1)",
      "    assert response == b'\\x1b[?1;2c', repr(response)",
      "os.write(1, b'AGENT_READY')",
      "assert os.read(0, 4) == b'ping'",
      "os.write(1, b'INPUT_OK')",
    ].join("\n");
    await writeFile(payload, JSON.stringify({ command: ["python3", "-c", source], cwd: directory, input: "ping", timeout: 1 }));
    const result = await execa("python3", [runner, payload], { reject: false, timeout: 2_000 });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 0, output: expect.stringContaining("INPUT_OK") });
  });
}, 3_000);

test("PTY timeout reports captured output and kills descendants after leader exits", async () => {
  await withPayload(async (directory, payload) => {
    const childPid = join(directory, "child.pid");
    const source = [
      "import os, time, signal",
      "signal.signal(signal.SIGHUP, signal.SIG_IGN)",
      "child = os.fork()",
      "if child == 0:",
      "    time.sleep(30)",
      "    os._exit(0)",
      `open(${JSON.stringify(childPid)}, 'w').write(str(child))`,
      "print('WAITING_FOR_EOF', flush=True)",
    ].join("\n");
    await writeFile(payload, JSON.stringify({ command: ["python3", "-c", source], cwd: directory, timeout: 0.3 }));
    const result = await execa("python3", [runner, payload], { reject: false, timeout: 2_000 });
    try {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("WAITING_FOR_EOF");
      expect(result.stderr).toContain("0.3 seconds");
      const pid = (await readFile(childPid, "utf8")).trim();
      // A killed orphan may remain a zombie briefly until the system reaps it.
      const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      expect(state === "" || state.split(" ")[2] === "Z", state).toBe(true);
    } finally {
      const pid = Number(await readFile(childPid, "utf8").catch(() => "0"));
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  });
}, 3_000);

test("PTY cancellation kills its owned child", async () => {
  await withPayload(async (directory, payload) => {
    const childPid = join(directory, "child.pid");
    const source = [
      "import os, time, signal",
      "signal.signal(signal.SIGHUP, signal.SIG_IGN)",
      `open(${JSON.stringify(childPid)}, 'w').write(str(os.getpid()))`,
      "time.sleep(30)",
    ].join("\n");
    await writeFile(payload, JSON.stringify({ command: ["python3", "-c", source], cwd: directory }));
    const child = execa("python3", [runner, payload], { reject: false, timeout: 2_000 });
    // Attach immediately so a startup/timeout failure cannot escape the test.
    const result = child.then(value => value);
    let pid = 0;
    try {
      const deadline = Date.now() + 1_000;
      while (!pid && Date.now() < deadline) {
        pid = Number(await readFile(childPid, "utf8").catch(() => "0"));
        if (!pid) await Bun.sleep(10);
      }
      expect(pid).toBeGreaterThan(0);
      child.kill("SIGTERM");
      expect((await result).exitCode).toBe(143);
      expect(await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")).toBe("");
    } finally {
      child.kill("SIGTERM");
      await result;
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  });
});
