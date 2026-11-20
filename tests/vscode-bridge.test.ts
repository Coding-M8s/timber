import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createBridge } from "../vscode-extension/src/bridge";
import type { BridgeHost, TerminalOptions } from "../vscode-extension/src/bridge";
import { publishSpoolFile, spoolNames } from "../src/editor-terminals/vscode-protocol";

const window = "0123456789abcdef";
const id = "00112233445566ff";
const shellPath = "/tmp/timber-launch-abc123/runtime";
const shellArgs = ["--no-env-file", "/tmp/timber-launch-abc123/entry.ts", "__editor-task", "/tmp/timber-launch-abc123"];
let root: string;
let spool: string;
let worktree: string;
beforeEach(async () => {
  root = await mkdtemp("/tmp/timber-bridge-test-");
  spool = join(root, "spool");
  worktree = join(root, "worktree");
  await mkdir(spool, { mode: 0o700 });
  await mkdir(worktree);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function host(overrides: Partial<BridgeHost> = {}) {
  const terminals: TerminalOptions[] = [];
  const value: BridgeHost = { spool, uid: process.getuid!(), windowId: window, extensionVersion: "0.1.0",
    vscodeVersion: "1.146.0", isLocal: () => true, folders: () => [worktree],
    createTerminal: async options => { terminals.push(options); return { processId: 4242 }; }, ...overrides };
  return { terminals, value };
}
const terminal = (extra: Record<string, unknown> = {}) => ({ protocol: 1, kind: "terminal", cwd: worktree,
  expires: Date.now() + 10_000, window, title: "Timber setup", shellPath, shellArgs, ...extra });
const write = (value: unknown, name = spoolNames(id).request) => publishSpoolFile(spool, name, value);
const files = async () => (await readdir(spool)).sort();
const json = async (name: string) => JSON.parse(await readFile(join(spool, name), "utf8"));

test("a hello from the exact worktree is claimed and acknowledged with this window's identity", async () => {
  const h = host();
  await write({ protocol: 1, kind: "hello", cwd: worktree, expires: Date.now() + 10_000 });
  await createBridge(h.value).scanPending();
  expect(await files()).toEqual([spoolNames(id).ack, spoolNames(id).claimed]);
  expect(await json(spoolNames(id).ack)).toEqual({ protocol: 1, extensionVersion: "0.1.0", vscodeVersion: "1.146.0", window });
  expect(h.terminals).toEqual([]);
});

test("a terminal request starts exactly the literal runner argv in the worktree", async () => {
  const h = host();
  await write(terminal());
  await createBridge(h.value).scanPending();
  expect(h.terminals).toEqual([{ name: "Timber setup", cwd: worktree, shellPath, shellArgs }]);
  expect(await json(spoolNames(id).ack)).toMatchObject({ window, processId: 4242 });
});

test("a workspace folder that resolves to the worktree through a symlink matches", async () => {
  const link = join(root, "link");
  await symlink(worktree, link);
  const h = host({ folders: () => [link] });
  await write(terminal());
  await createBridge(h.value).scanPending();
  expect(h.terminals).toHaveLength(1);
});

test.each([
  ["another folder", {}, { folders: () => ["/"] }],
  ["another window", { window: "fedcba9876543210" }, {}],
  ["an expired request", { expires: Date.now() - 1 }, {}],
  ["a remote window", {}, { isLocal: () => false }],
])("%s leaves the request unclaimed", async (_name, request, overrides) => {
  const h = host(overrides);
  await write(terminal(request));
  await createBridge(h.value).scanPending();
  expect(await files()).toEqual([spoolNames(id).request]);
  expect(h.terminals).toEqual([]);
});

test("a request file readable by others is refused", async () => {
  const h = host();
  await write(terminal());
  await chmod(join(spool, spoolNames(id).request), 0o644);
  await createBridge(h.value).scanPending();
  expect(await files()).toEqual([spoolNames(id).request]);
  expect(h.terminals).toEqual([]);
});

test("a spool readable by others is never scanned", async () => {
  const h = host();
  await write(terminal());
  await chmod(spool, 0o755);
  await createBridge(h.value).scanPending();
  expect(await files()).toEqual([spoolNames(id).request]);
  expect(h.terminals).toEqual([]);
});

test.each([
  ["a shell path outside a launch directory", { shellPath: "/bin/sh" }, "invalid"],
  ["shell args that differ from the runner", { shellArgs: ["-c", "echo hi"] }, "invalid"],
  ["shell args for another launch directory", { shellArgs: ["__editor-task", "/tmp/timber-launch-other"] }, "invalid"],
  ["an unknown key", { env: { PATH: "/tmp" } }, "invalid"],
  ["an unknown protocol", { protocol: 2 }, "protocol"],
])("%s is claimed and rejected without a terminal", async (_name, request, code) => {
  const h = host();
  await write(terminal(request));
  await createBridge(h.value).scanPending();
  expect(h.terminals).toEqual([]);
  expect(await files()).toEqual([spoolNames(id).claimed, spoolNames(id).error]);
  expect(await json(spoolNames(id).error)).toEqual({ protocol: 1, code });
});

test("a terminal without a process id is reported as a failed creation", async () => {
  const h = host({ createTerminal: async () => ({ processId: undefined }) });
  await write(terminal());
  await createBridge(h.value).scanPending();
  expect(await json(spoolNames(id).error)).toEqual({ protocol: 1, code: "create-failed" });
  expect(await files()).not.toContain(spoolNames(id).ack);
});

test("two windows racing for one request create exactly one terminal", async () => {
  const first = host();
  const second = host({ createTerminal: first.value.createTerminal });
  await write(terminal());
  await Promise.all([createBridge(first.value).scanPending(), createBridge(second.value).scanPending(),
    createBridge(first.value).scanPending()]);
  expect(first.terminals).toHaveLength(1);
  expect(await files()).toEqual([spoolNames(id).ack, spoolNames(id).claimed]);
});

test("a request fenced by Timber is never claimed", async () => {
  const h = host();
  await write(terminal(), spoolNames(id).cancelled);
  await createBridge(h.value).scanPending();
  expect(h.terminals).toEqual([]);
  expect(await files()).toEqual([spoolNames(id).cancelled]);
});
