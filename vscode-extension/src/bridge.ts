// The extension's logic, kept free of the vscode module so it can be tested with plain Bun.
import { readdir, readFile, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  isPrivate, parseRequest, publishSpoolFile, requestIdPattern, spoolNames, VSCODE_PROTOCOL,
} from "../../src/editor-terminals/vscode-protocol";
import type { SpoolAck, SpoolErrorCode } from "../../src/editor-terminals/vscode-protocol";

export interface TerminalOptions { name: string; cwd: string; shellPath: string; shellArgs: string[] }
export interface BridgeHost {
  spool: string;
  uid: number;
  /** Random per activation, so Timber can pin terminals to the window that answered its hello. */
  windowId: string;
  extensionVersion: string;
  vscodeVersion: string;
  isLocal(): boolean;
  /** Local file-system paths of this window's workspace folders. */
  folders(): readonly string[];
  createTerminal(options: TerminalOptions): Promise<{ processId: number | undefined }>;
  now?(): number;
}

async function canonical(path: string): Promise<string | null> {
  try { return await realpath(path); } catch { return null; }
}

/** Claims only requests for this exact local window; everything else is left for another window or Timber's fence. */
export function createBridge(host: BridgeHost) {
  const inFlight = new Set<string>();
  const now = () => host.now?.() ?? Date.now();

  async function handle(id: string, folders: ReadonlySet<string>): Promise<void> {
    const names = spoolNames(id);
    const path = join(host.spool, names.request);
    if (!await isPrivate(path, false, host.uid)) return;
    let text: string;
    try { text = await readFile(path, "utf8"); } catch { return; }
    const parsed = parseRequest(text);
    const cwd = parsed.ok ? parsed.request.cwd : parsed.cwd;
    if (cwd === null) return;
    const target = await canonical(cwd);
    if (target === null || !folders.has(target)) return;
    if (parsed.ok) {
      if (parsed.request.expires <= now()) return;
      if (parsed.request.kind === "terminal" && parsed.request.window !== host.windowId) return;
    }
    // Timber fences with the same rename, so exactly one of claim and cancellation succeeds.
    try { await rename(path, join(host.spool, names.claimed)); } catch { return; }
    const fail = (code: SpoolErrorCode) => publishSpoolFile(host.spool, names.error, { protocol: VSCODE_PROTOCOL, code });
    if (!parsed.ok) { await fail(parsed.code); return; }
    const ack: SpoolAck = { protocol: VSCODE_PROTOCOL, extensionVersion: host.extensionVersion,
      vscodeVersion: host.vscodeVersion, window: host.windowId };
    const request = parsed.request;
    if (request.kind === "hello") { await publishSpoolFile(host.spool, names.ack, ack); return; }
    let processId: number | undefined;
    try {
      ({ processId } = await host.createTerminal({ name: request.title, cwd: request.cwd,
        shellPath: request.shellPath, shellArgs: [...request.shellArgs] }));
    } catch { processId = undefined; }
    if (processId === undefined) { await fail("create-failed"); return; }
    await publishSpoolFile(host.spool, names.ack, { ...ack, processId });
  }

  return {
    async scanPending(): Promise<void> {
      if (!host.isLocal() || !await isPrivate(host.spool, true, host.uid)) return;
      const folders = new Set<string>();
      for (const folder of host.folders()) {
        const resolved = await canonical(folder);
        if (resolved !== null) folders.add(resolved);
      }
      if (folders.size === 0) return;
      let entries: string[];
      try { entries = await readdir(host.spool); } catch { return; }
      const pending: Promise<void>[] = [];
      for (const entry of entries) {
        const id = entry.endsWith(".json") ? entry.slice(0, -".json".length) : "";
        if (!requestIdPattern.test(id) || inFlight.has(id)) continue;
        inFlight.add(id);
        pending.push(handle(id, folders).catch(() => {}).finally(() => { inFlight.delete(id); }));
      }
      await Promise.all(pending);
    },
  };
}
