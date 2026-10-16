import { expect, test } from "bun:test";
import { createOrcaSession } from "../src/editor-terminals/orca";
import { worktreeFixture } from "./helpers/services";

const editor = { command: "orca-ide", args: [], enabled: true, integration: "orca" as const };
const tree = worktreeFixture({ path: "/tmp/exact target $(literal)" });
const status = { ok: true, result: { target: { kind: "local" }, app: { running: true }, runtime: { state: "ready", reachable: true }, graph: { state: "ready" } } };
const found = { ok: true, result: { worktree: { id: `repo::${tree.path}`, path: tree.path, hostId: "local" } } };

test("Orca readiness retries missing index entries and pins exact worktree for terminal operations", async () => {
  const calls: readonly string[][] = [];
  let shows = 0;
  const session = await createOrcaSession(editor, tree, { env: {}, readinessMs: 200, pollMs: 1,
    call: async args => {
      (calls as string[][]).push([...args]);
      if (args[0] === "status") return status;
      if (args[0] === "worktree") return ++shows < 3 ? { ok: false, error: { code: "selector_not_found" } } : found;
      return { ok: true, result: { terminal: { handle: "term_abc", worktreeId: `repo::${tree.path}`,
        executionHostId: "local", surface: "visible" } } };
    } });
  expect(await session.create("Timber setup", "/tmp/generated/runtime __editor-task /tmp/generated")).toBe("term_abc");
  expect(shows).toBe(3);
  expect(calls.filter(a => a[0] === "worktree").every(a => a.includes(`path:${tree.path}`))).toBe(true);
  const create = calls.findIndex(a => a[1] === "create");
  // Orca 1.4.224 never attaches a PTY to `terminal create --focus` in a worktree the window has not shown yet;
  // creating in the background and switching afterwards reveals it without blocking the runner.
  expect(calls[create]).toEqual(["terminal", "create", "--worktree", `id:repo::${tree.path}`, "--title", "Timber setup",
    "--command", "/tmp/generated/runtime __editor-task /tmp/generated", "--json"]);
  expect(calls[create + 1]).toEqual(["terminal", "switch", "--terminal", "term_abc", "--json"]);
  expect(calls.some(a => a[0] === "open")).toBe(false);
});

test("a failed reveal after successful creation keeps the started terminal", async () => {
  let switches = 0;
  const session = await createOrcaSession(editor, tree, { env: {}, call: async args => {
    if (args[0] === "status") return status;
    if (args[0] === "worktree") return found;
    if (args[1] === "switch") { switches++; return { ok: false, error: { code: "terminal_handle_stale" } }; }
    return { ok: true, result: { terminal: { handle: "term_abc", worktreeId: `repo::${tree.path}`,
      executionHostId: "local", surface: "visible" } } };
  } });
  expect(await session.create("Timber agent", "/tmp/generated/runtime")).toBe("term_abc");
  expect(switches).toBe(1);
});

test("indexing has a bounded timeout; permission errors are not retried", async () => {
  let mutations = 0;
  for (const code of ["selector_not_found", "permission_denied"]) {
    let shows = 0;
    await expect(createOrcaSession(editor, tree, { env: {}, readinessMs: 15, pollMs: 1,
      call: async args => {
        if (args[0] === "status") return status;
        if (args[0] === "terminal") mutations++;
        shows++;
        return { ok: false, error: { code } };
      } })).rejects.toThrow(code === "selector_not_found" ? /index|ready|readiness/i : /permission/i);
    expect(shows).toBeGreaterThan(0);
    if (code === "permission_denied") expect(shows).toBe(1);
  }
  expect(mutations).toBe(0);
});

test("remote routing and mismatched worktrees are refused before terminal mutation", async () => {
  for (const env of [{ ORCA_ENVIRONMENT: "remote" }, { ORCA_PAIRING_CODE: "secret" }]) {
    await expect(createOrcaSession(editor, tree, { env, call: async () => { throw new Error("must not call"); } }))
      .rejects.toThrow(/local|remote/);
  }
  await expect(createOrcaSession({ ...editor, args: ["--environment=remote"] }, tree, { env: {} }))
    .rejects.toThrow(/local|remote/);
  await expect(createOrcaSession(editor, tree, { env: {}, call: async args => args[0] === "status" ? status
    : { ok: true, result: { worktree: { id: "repo::/wrong", path: "/wrong", hostId: "local" } } } }))
    .rejects.toThrow(/identity|target|worktree/);
});

test("ambiguous terminal creation is never retried", async () => {
  let creates = 0;
  const session = await createOrcaSession(editor, tree, { env: {}, call: async args => {
    if (args[0] === "status") return status;
    if (args[0] === "worktree") return found;
    creates++;
    throw new Error("transport failed secret-sentinel");
  } });
  const error = await session.create("Timber agent", "/tmp/generated/runtime").catch(e => e);
  expect(error.message).toMatch(/uncertain|inspect/);
  expect(error.message).not.toContain("secret-sentinel");
  expect(creates).toBe(1);
});

test("readiness deadline reports indexing guidance even when each probe takes real time", async () => {
  let probes = 0;
  const error = await createOrcaSession(editor, tree, { env: {}, readinessMs: 150, pollMs: 20,
    call: async (args, timeoutMs) => {
      if (args[0] === "status") return status;
      probes++;
      await Bun.sleep(Math.min(60, timeoutMs)); // A real CLI honors the timeout it was given.
      if (timeoutMs < 60) throw new Error("timed out");
      return { ok: false, error: { code: "selector_not_found" } };
    } }).catch(e => e);
  expect(error.message).toMatch(/readiness timed out/);
  expect(probes).toBeGreaterThan(1);
});
