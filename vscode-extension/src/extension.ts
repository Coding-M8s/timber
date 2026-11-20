// Thin glue: every decision lives in bridge.ts. No commands, views, settings or tasks.
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import * as vscode from "vscode";
import { ensureSpool, spoolDirectory } from "../../src/editor-terminals/vscode-protocol";
import { createBridge } from "./bridge";

const processIdTimeoutMs = 5000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const uid = process.getuid();
  const spool = spoolDirectory(uid);
  // Fail closed: a squatted or shared spool is never watched.
  try { await ensureSpool(spool, uid); } catch { return; }
  const bridge = createBridge({
    spool, uid,
    windowId: randomBytes(8).toString("hex"),
    extensionVersion: String(context.extension.packageJSON.version),
    vscodeVersion: vscode.version,
    isLocal: () => vscode.env.remoteName === undefined,
    isTrusted: () => vscode.workspace.isTrusted,
    folders: () => (vscode.workspace.workspaceFolders ?? [])
      .filter(folder => folder.uri.scheme === "file").map(folder => folder.uri.fsPath),
    async createTerminal({ name, cwd, shellPath, shellArgs }) {
      const terminal = vscode.window.createTerminal({ name, cwd, shellPath, shellArgs, isTransient: true });
      terminal.show(false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>(resolve => { timer = setTimeout(resolve, processIdTimeoutMs, undefined); });
      try { return { processId: await Promise.race([terminal.processId, timeout]) }; }
      finally { clearTimeout(timer); }
    },
  });
  const scan = () => { void bridge.scanPending(); };
  const watcher = watch(spool, scan);
  watcher.on("error", () => {});
  context.subscriptions.push({ dispose: () => watcher.close() }, vscode.workspace.onDidChangeWorkspaceFolders(scan),
    vscode.workspace.onDidGrantWorkspaceTrust(scan));
  scan();
}

export function deactivate(): void {}
