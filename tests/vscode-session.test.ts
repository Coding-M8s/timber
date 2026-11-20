import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createVscodeSession } from "../src/editor-terminals/vscode";
import { publishSpoolFile, spoolNames } from "../src/editor-terminals/vscode-protocol";
import type { SpoolRequest } from "../src/editor-terminals/vscode-protocol";
import { worktreeFixture } from "./helpers/services";

const editor = { command: "code", args: ["--new-window"], enabled: true, integration: "vscode" as const };
const window = "0123456789abcdef";
const argv = ["/tmp/timber-launch-abc123/runtime", "__editor-task", "/tmp/timber-launch-abc123"];
let spool: string;
beforeEach(async () => { spool = await mkdtemp("/tmp/timber-vscode-test-"); });
afterEach(async () => { await rm(spool, { recursive: true, force: true }); });

const listing = (stdout = "ms-python.python@2024.1.0\ncoding-m8s.timber-terminals@0.1.0\n") =>
  async () => ({ exitCode: 0, stdout });

type Behavior = (request: SpoolRequest, id: string) => Promise<void>;
/** A stand-in extension window that answers each new request once. */
function extension(behave: Behavior) {
  let stopped = false;
  const handled = new Set<string>();
  const requests: SpoolRequest[] = [];
  const loop = (async () => {
    while (!stopped) {
      for (const entry of await readdir(spool)) {
        const id = /^([0-9a-f]{16})\.json$/u.exec(entry)?.[1];
        if (!id || handled.has(id)) continue;
        handled.add(id);
        let request: SpoolRequest;
        try { request = JSON.parse(await readFile(join(spool, entry), "utf8")) as SpoolRequest; } catch { continue; }
        requests.push(request);
        await behave(request, id);
      }
      await Bun.sleep(5);
    }
  })();
  return { requests, stop: async () => { stopped = true; await loop; } };
}
const claim = (id: string) => rename(join(spool, spoolNames(id).request), join(spool, spoolNames(id).claimed));
const ack = (id: string, extra: Record<string, unknown> = {}) => publishSpoolFile(spool, spoolNames(id).ack,
  { protocol: 1, extensionVersion: "0.1.0", vscodeVersion: "1.146.0", window, ...extra });
const answerHello: Behavior = async (request, id) => { if (request.kind === "hello") { await claim(id); await ack(id); } };

function options(extra: Partial<Parameters<typeof createVscodeSession>[2]> = {}) {
  const opened: string[] = [];
  return { opened, value: { spool, run: listing(), open: async (path: string) => { opened.push(path); },
    readinessMs: 2000, createMs: 2000, pollMs: 5, ...extra } };
}

test.each([
  ["not installed", "ms-python.python@2024.1.0\n", /extension is not installed.*code --install-extension/],
  ["too old", "coding-m8s.timber-terminals@0.0.9\n", /0\.0\.9 is older than the required 0\.1\.0/],
])("preflight refuses an extension that is %s before opening any window", async (_name, stdout, message) => {
  const o = options({ run: listing(stdout) });
  await expect(createVscodeSession(editor, worktreeFixture(), o.value)).rejects.toThrow(message);
  expect(o.opened).toEqual([]);
});

test.each(["--remote=ssh-remote+host", "--folder-uri", "--file-uri=vscode-remote://x"])(
  "remote routing in editor args is refused before running VS Code: %s", async arg => {
    let ran = false;
    const o = options({ run: async () => { ran = true; return { exitCode: 0, stdout: "" }; } });
    await expect(createVscodeSession({ ...editor, args: [arg] }, worktreeFixture(), o.value)).rejects.toThrow(/local window/);
    expect(ran).toBe(false);
  });

test("a non-private spool is refused before any window opens", async () => {
  await chmod(spool, 0o755);
  const o = options();
  await expect(createVscodeSession(editor, worktreeFixture(), o.value)).rejects.toThrow(/not a private directory/);
  expect(o.opened).toEqual([]);
});

test("an unanswered hello is fenced, cleaned up and reported as not started", async () => {
  const o = options({ readinessMs: 80 });
  await expect(createVscodeSession(editor, worktreeFixture(), o.value)).rejects.toThrow(/did not answer.*no terminals started/);
  expect(o.opened).toEqual(["/repo"]);
  expect(await readdir(spool)).toEqual([]);
});

test("an acknowledged extension below the version floor is refused", async () => {
  const fake = extension(async (_request, id) => { await claim(id); await ack(id, { extensionVersion: "0.0.1" }); });
  try {
    await expect(createVscodeSession(editor, worktreeFixture(), options().value)).rejects.toThrow(/0\.0\.1 is older/);
  } finally { await fake.stop(); }
});

test("terminal requests carry literal argv pinned to the answering window and return the process handle", async () => {
  const fake = extension(async (request, id) => {
    await claim(id);
    await ack(id, request.kind === "terminal" ? { processId: 4242 } : {});
  });
  try {
    const session = await createVscodeSession(editor, worktreeFixture(), options().value);
    expect(session.window).toBe(window);
    expect(await session.create("Timber setup", argv.join(" "), argv)).toBe('"Timber setup" (pid 4242)');
    await session.select();
    expect(fake.requests[0]).toMatchObject({ protocol: 1, kind: "hello", cwd: "/repo" });
    expect(fake.requests[1]).toMatchObject({ protocol: 1, kind: "terminal", cwd: "/repo", window, title: "Timber setup",
      shellPath: argv[0], shellArgs: argv.slice(1) });
    expect(await readdir(spool)).toEqual([]);
  } finally { await fake.stop(); }
});

test.each([
  ["create-failed", /could not start the Timber terminal process/],
  ["invalid", /rejected the terminal request as invalid/],
  ["protocol", /request protocol/],
  ["untrusted", /Restricted Mode.*Trust the folder/],
])("an extension %s error is reported definitively", async (code, message) => {
  const fake = extension(async (request, id) => {
    await claim(id);
    if (request.kind === "hello") await ack(id);
    else await publishSpoolFile(spool, spoolNames(id).error, { protocol: 1, code });
  });
  try {
    const session = await createVscodeSession(editor, worktreeFixture(), options().value);
    await expect(session.create("Timber agent", undefined, argv)).rejects.toThrow(message);
    expect(await readdir(spool)).toEqual([]);
  } finally { await fake.stop(); }
});

test("an unclaimed terminal request is fenced and reported as never created", async () => {
  const fake = extension(answerHello);
  try {
    const session = await createVscodeSession(editor, worktreeFixture(), options({ createMs: 80 }).value);
    await expect(session.create("Timber agent", undefined, argv)).rejects.toThrow(/did not accept the terminal request.*no terminal was created/);
    expect(await readdir(spool)).toEqual([]);
  } finally { await fake.stop(); }
});

test("a claimed terminal request without an acknowledgement is uncertain and never replayed", async () => {
  const fake = extension(async (request, id) => { await claim(id); if (request.kind === "hello") await ack(id); });
  try {
    const session = await createVscodeSession(editor, worktreeFixture(), options({ createMs: 80 }).value);
    await expect(session.create("Timber agent", undefined, argv)).rejects.toThrow(/handoff is uncertain.*not replayed/);
    expect(fake.requests.filter(request => request.kind === "terminal")).toHaveLength(1);
  } finally { await fake.stop(); }
});

test("an acknowledgement from another window is uncertain", async () => {
  const fake = extension(async (request, id) => {
    await claim(id);
    await ack(id, request.kind === "terminal" ? { window: "fedcba9876543210", processId: 1 } : {});
  });
  try {
    const session = await createVscodeSession(editor, worktreeFixture(), options().value);
    await expect(session.create("Timber agent", undefined, argv)).rejects.toThrow(/uncertain/);
  } finally { await fake.stop(); }
});

test("creation without runner argv is refused without writing a request", async () => {
  const fake = extension(answerHello);
  try {
    const session = await createVscodeSession(editor, worktreeFixture(), options().value);
    await expect(session.create("Timber workspace")).rejects.toThrow(/no terminal was created/);
    expect(fake.requests).toHaveLength(1);
  } finally { await fake.stop(); }
});

test("a hello from a Restricted Mode window fails readiness before any terminal request", async () => {
  const fake = extension(async (_request, id) => { await claim(id); await ack(id, { trusted: false }); });
  try {
    await expect(createVscodeSession(editor, worktreeFixture(), options().value))
      .rejects.toThrow(/Restricted Mode, so it cannot start Timber terminals\. Trust the folder/);
    expect(fake.requests.map(request => request.kind)).toEqual(["hello"]);
    expect(await readdir(spool)).toEqual([]);
  } finally { await fake.stop(); }
});

test.each([true, undefined])("a hello with trusted=%s is accepted, so older extensions stay compatible", async trusted => {
  const fake = extension(async (_request, id) => { await claim(id); await ack(id, trusted === undefined ? {} : { trusted }); });
  try {
    expect((await createVscodeSession(editor, worktreeFixture(), options().value)).window).toBe(window);
  } finally { await fake.stop(); }
});

test("a malformed trust value is not accepted as an acknowledgement", async () => {
  const fake = extension(async (_request, id) => { await claim(id); await ack(id, { trusted: "no" }); });
  try {
    await expect(createVscodeSession(editor, worktreeFixture(), options({ readinessMs: 200 }).value)).rejects.toThrow(/uncertain/);
  } finally { await fake.stop(); }
});
