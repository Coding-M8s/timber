import { execa } from "execa";
import { z } from "zod";
import type { EditorConfig, Worktree } from "../types";

export type OrcaCall = (args: readonly string[], timeoutMs: number) => Promise<unknown>;
/** Terminal creation succeeded; selection failure must never trigger another create. */
export class OrcaSelectionFailure extends Error {
  constructor(public readonly handle: string) {
    super(`Could not select Orca terminal ${handle}. Inspect that existing terminal before retrying; it was retained and was not recreated.`);
  }
}
interface Options {
  call?: OrcaCall;
  env?: NodeJS.ProcessEnv;
  readinessMs?: number;
  pollMs?: number;
}
const envelope = z.object({ ok: z.boolean(), result: z.unknown().optional(),
  error: z.object({ code: z.string() }).optional() });
const localStatus = z.object({ target: z.object({ kind: z.literal("local") }),
  app: z.object({ running: z.literal(true) }),
  runtime: z.object({ state: z.literal("ready"), reachable: z.literal(true) }) });
const worktreeResult = z.object({ worktree: z.object({ id: z.string().min(1), path: z.string(), hostId: z.literal("local") }) });
const terminalResult = z.object({ terminal: z.object({ handle: z.string().regex(/^term_[\w-]+$/u),
  worktreeId: z.string(), executionHostId: z.literal("local"), surface: z.literal("visible") }) });

function failure(code: string): Error {
  return new Error(/permission|denied|unauthorized/u.test(code)
    ? "Orca refused permission. Allow CLI terminal control in the local app, then retry."
    : "Orca command failed. Check the running local app, CLI version and permissions; workspace retained.");
}

/** Only read-only discovery is retried. Terminal mutations are attempted exactly once. */
export async function createOrcaSession(editor: EditorConfig, worktree: Worktree, options: Options = {}) {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Orca terminal integration currently requires Linux x86_64.");
  const env = options.env ?? process.env;
  if (env.ORCA_ENVIRONMENT || env.ORCA_PAIRING_CODE
    || editor.args.some(arg => /^--(?:environment|pairing-code)(?:=|$)/u.test(arg))) {
    throw new Error("Orca terminal integration requires the local app; remove remote routing from editor args and environment.");
  }
  const call: OrcaCall = options.call ?? (async (args, timeoutMs) => {
    try {
      const result = await execa(editor.command, [...editor.args, ...args], {
        cwd: worktree.path, timeout: timeoutMs, reject: false, maxBuffer: 2 * 1024 * 1024,
        stdin: "ignore",
      });
      return JSON.parse(result.stdout);
    } catch { throw new Error("Could not contact Orca. Check its executable, running local app and CLI permissions; workspace retained."); }
  });
  async function read(args: readonly string[], timeout: number) {
    try { return envelope.parse(await call(args, Math.max(1, timeout))); }
    catch { throw new Error("Could not read Orca's response. Check its CLI, running local app and permissions; workspace retained."); }
  }
  const deadline = Date.now() + (options.readinessMs ?? 15_000);
  const status = await read(["status", "--json"], 10_000);
  if (!status.ok) throw failure(status.error?.code ?? "unknown");
  if (!localStatus.safeParse(status.result).success) {
    throw new Error("Orca's local window/runtime is not ready. Open the existing app and register this repository before retrying.");
  }
  let id: string;
  // Each probe keeps a full per-call budget; the readiness deadline is checked only between probes so a
  // probe cut short by a shrinking timeout can never masquerade as a CLI failure.
  for (;;) {
    const response = await read(["worktree", "show", "--worktree", `path:${worktree.path}`, "--json"], 10_000);
    if (response.ok) {
      const target = worktreeResult.safeParse(response.result);
      if (!target.success || target.data.worktree.path !== worktree.path
        || !target.data.worktree.id.endsWith(`::${worktree.path}`)) {
        throw new Error("Orca worktree identity does not match the exact local target; no terminals started.");
      }
      id = target.data.worktree.id;
      break;
    }
    if (response.error?.code !== "selector_not_found") throw failure(response.error?.code ?? "unknown");
    await Bun.sleep(Math.min(options.pollMs ?? 200, Math.max(1, deadline - Date.now())));
    if (Date.now() >= deadline) {
      throw new Error("Orca worktree indexing readiness timed out. Register the repository and show external worktrees in the existing window, then retry; workspace retained.");
    }
  }
  /** Orca 1.4.224 defers `create --focus` until the window shows the worktree, which never happens for a fresh
   * external checkout; a background create attaches its PTY immediately and a later switch only reveals it. */
  async function reveal(handle: string): Promise<void> {
    try {
      const response = envelope.parse(await call(["terminal", "switch", "--terminal", handle, "--json"], 5000));
      if (!response.ok) throw new Error("Selection refused");
    } catch { throw new OrcaSelectionFailure(handle); }
  }
  return {
    worktreeId: id,
    async create(title: string, bootstrap?: string): Promise<string> {
      let response: z.infer<typeof envelope>;
      try {
        response = envelope.parse(await call(["terminal", "create", "--worktree", `id:${id}`, "--title", title,
          ...(bootstrap === undefined ? [] : ["--command", bootstrap]), "--json"], 10_000));
      } catch {
        throw new Error("Orca terminal handoff is uncertain. Inspect terminals in the selected worktree before retrying; terminal creation was not replayed.");
      }
      if (!response.ok) throw failure(response.error?.code ?? "unknown");
      let handle: string;
      try {
        const result = terminalResult.parse(response.result).terminal;
        if (result.worktreeId !== id) throw new Error("Wrong terminal owner");
        handle = result.handle;
      } catch {
        throw new Error("Orca terminal handoff is uncertain. Inspect terminals in the selected worktree before retrying; terminal creation was not replayed.");
      }
      await reveal(handle);
      return handle;
    },
    async select(): Promise<void> {
      const response = await read(["terminal", "list", "--worktree", `id:${id}`, "--json"], 5000);
      if (!response.ok) throw failure(response.error?.code ?? "unknown");
      const listed = z.object({ terminals: z.array(z.object({ handle: z.string(), worktreeId: z.string(),
        executionHostId: z.string(), connected: z.boolean() })) }).safeParse(response.result);
      if (!listed.success) throw new Error("Could not verify Orca terminal inventory; workspace retained.");
      const terminal = listed.data.terminals.find(t => t.worktreeId === id && t.executionHostId === "local" && t.connected);
      if (!terminal) { await this.create("Timber workspace"); return; }
      await reveal(terminal.handle);
    },
  };
}
