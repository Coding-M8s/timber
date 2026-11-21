import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { safeDisplay } from "../display";
import { resolveNativeCommand } from "../platform/executable";
import type { EditorConfig, Worktree } from "../types";
import { supportsEditorTerminals } from "./process-identity";
import { UncertainHandoff } from "./request";
import {
  compareVersions, ensureSpool, EXTENSION_ID, isPrivate, MIN_EXTENSION_VERSION, parseAck, publishSpoolFile,
  spoolDirectory, spoolErrorCodes, spoolNames, VSCODE_PROTOCOL,
} from "./vscode-protocol";
import type { SpoolAck, SpoolErrorCode, SpoolRequest } from "./vscode-protocol";

export type VscodeRun = (args: readonly string[], timeoutMs: number) => Promise<{ exitCode: number | undefined; stdout: string }>;
interface Options {
  run?: VscodeRun;
  open?: (path: string) => Promise<void>;
  spool?: string;
  readinessMs?: number;
  createMs?: number;
  pollMs?: number;
}

const install = `Install the Timber VS Code extension (${EXTENSION_ID}) ${MIN_EXTENSION_VERSION} or newer with code --install-extension <file>.vsix, then retry.`;
/** Names the folder that holds the worktree: trusting it once covers every worktree created there. */
function restricted(worktreePath: string): string {
  return `VS Code opened the worktree in Restricted Mode, so it cannot start Timber terminals. Trust the folder that holds your worktrees, ${safeDisplay(dirname(worktreePath))}, once in VS Code: click Manage in the Restricted Mode banner, then Add Folder under Trusted Folders & Workspaces. New worktrees there then open trusted. Then retry.`;
}
const uncertain = "VS Code terminal handoff is uncertain. Inspect terminals in the worktree window before retrying; terminal creation was not replayed.";
const errorMessages: Record<SpoolErrorCode, string> = {
  protocol: `The Timber VS Code extension does not speak this Timber's request protocol; update Timber and the extension together. ${install}`,
  invalid: "The Timber VS Code extension rejected the terminal request as invalid; no terminal was created.",
  "create-failed": "VS Code could not start the Timber terminal process.",
  untrusted: "VS Code is in Restricted Mode for this worktree, so it cannot start Timber terminals.",
};

function tooOld(version: string): Error {
  return new Error(`The Timber VS Code extension ${version} is older than the required ${MIN_EXTENSION_VERSION}. ${install}`);
}

/** Every request is written once; a timeout fences it with the same rename the extension uses to claim it. */
export async function createVscodeSession(editor: EditorConfig, worktree: Worktree, options: Options = {}) {
  if (!supportsEditorTerminals(process.platform, process.arch)) {
    throw new Error("VS Code terminal integration requires Linux x86_64 or experimental macOS arm64/x86_64.");
  }
  if (editor.args.some(arg => /^--(?:remote|folder-uri|file-uri)(?:=|$)/u.test(arg))) {
    throw new Error("VS Code terminal integration requires a local window; remove --remote, --folder-uri and --file-uri from editor args.");
  }
  const run: VscodeRun = options.run ?? (async (args, timeoutMs) => {
    const result = await execa(editor.command, [...editor.args, ...args], {
      cwd: worktree.path, timeout: timeoutMs, reject: false, stdin: "ignore", maxBuffer: 2 * 1024 * 1024,
    });
    return { exitCode: result.exitCode, stdout: typeof result.stdout === "string" ? result.stdout : "" };
  });
  let listed: Awaited<ReturnType<VscodeRun>>;
  try { listed = await run(["--list-extensions", "--show-versions"], 10_000); }
  catch { throw new Error("Could not run VS Code to check its extensions. Check the editor executable and PATH; workspace retained."); }
  if (listed.exitCode !== 0) throw new Error("VS Code could not list its extensions. Check the editor executable and args; workspace retained.");
  const installed = listed.stdout.split(/\r?\n/u).map(line => line.trim())
    .find(line => line.toLowerCase().startsWith(`${EXTENSION_ID}@`));
  if (installed === undefined) throw new Error(`The Timber VS Code extension is not installed. ${install}`);
  const listedVersion = installed.slice(EXTENSION_ID.length + 1);
  if ((compareVersions(listedVersion, MIN_EXTENSION_VERSION) ?? -1) < 0) throw tooOld(listedVersion);

  const uid = process.getuid!();
  const spool = options.spool ?? spoolDirectory(uid);
  await ensureSpool(spool, uid);
  const pollMs = options.pollMs ?? 50;

  async function readOutcome(id: string): Promise<{ ack: SpoolAck } | { error: SpoolErrorCode } | null> {
    const names = spoolNames(id);
    for (const [kind, name] of [["ack", names.ack], ["error", names.error]] as const) {
      const path = join(spool, name);
      if (!await isPrivate(path, false, uid)) continue;
      let text: string;
      try { text = await readFile(path, "utf8"); } catch { continue; }
      if (kind === "ack") {
        const ack = parseAck(text);
        if (ack) return { ack };
      } else {
        try {
          const code: unknown = JSON.parse(text).code;
          const known = spoolErrorCodes.find(value => value === code);
          if (known) return { error: known };
        } catch {}
      }
      // A malformed outcome proves the request was claimed but says nothing else.
      throw new UncertainHandoff(uncertain);
    }
    return null;
  }
  async function fence(id: string): Promise<boolean> {
    const names = spoolNames(id);
    try { await rename(join(spool, names.request), join(spool, names.cancelled)); return true; }
    catch { return false; }
  }
  /** Claim markers go before outcomes: an extension that answers late sees the claim gone and removes its own outcome. */
  async function cleanup(id: string): Promise<void> {
    const names = spoolNames(id);
    const remove = (name: string) => rm(join(spool, name), { force: true }).catch(() => {});
    await Promise.all([names.request, names.claimed, names.cancelled].map(remove));
    await Promise.all([names.ack, names.error].map(remove));
  }
  /** Resolves with the outcome, null once the request was fenced unclaimed, or "claimed" without an outcome. */
  async function exchange(request: SpoolRequest, timeoutMs: number) {
    const id = randomBytes(8).toString("hex");
    try {
      await publishSpoolFile(spool, spoolNames(id).request, request);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const outcome = await readOutcome(id);
        if (outcome) return outcome;
        if (Date.now() >= deadline) break;
        await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
      }
      if (await fence(id)) return null;
      // Claimed during the last poll: one more read prefers definitive evidence.
      return await readOutcome(id) ?? "claimed" as const;
    } finally {
      // Fence first, so a request this process stops watching can never be claimed later.
      await fence(id);
      await cleanup(id);
    }
  }

  const readinessMs = options.readinessMs ?? 30_000;
  const open = options.open ?? (async (path: string) => {
    const child = spawn(await resolveNativeCommand(editor.command), [...editor.args, path], {
      cwd: path, shell: false, stdio: "ignore", detached: true,
    });
    await once(child, "spawn");
    child.unref();
  });
  try { await open(worktree.path); }
  catch { throw new Error("Could not start VS Code for the worktree window. Check the editor executable, args and PATH."); }
  let window: string;
  {
    const outcome = await exchange({ protocol: VSCODE_PROTOCOL, kind: "hello", cwd: worktree.path,
      expires: Date.now() + readinessMs }, readinessMs);
    if (outcome === null || outcome === "claimed") {
      throw new Error("The Timber VS Code extension did not answer from the worktree window in time; no terminals started. Check that the extension is installed and enabled in a local window.");
    }
    if ("error" in outcome) throw new Error(outcome.error === "untrusted" ? restricted(worktree.path) : errorMessages[outcome.error]);
    if (outcome.ack.protocol !== VSCODE_PROTOCOL) throw new Error(errorMessages.protocol);
    if ((compareVersions(outcome.ack.extensionVersion, MIN_EXTENSION_VERSION) ?? -1) < 0) throw tooOld(outcome.ack.extensionVersion);
    // Older extensions omit trust; treat that as trusted for compatibility.
    if (outcome.ack.trusted === false) throw new Error(restricted(worktree.path));
    window = outcome.ack.window;
  }
  const createMs = options.createMs ?? 10_000;
  return {
    window,
    async create(title: string, _bootstrap?: string, argv?: readonly string[]): Promise<string> {
      if (argv === undefined || argv.length === 0) throw new Error("VS Code terminals run only Timber editor requests; no terminal was created.");
      const outcome = await exchange({ protocol: VSCODE_PROTOCOL, kind: "terminal", cwd: worktree.path,
        expires: Date.now() + createMs, window, title, shellPath: argv[0]!, shellArgs: argv.slice(1) }, createMs);
      if (outcome === null) throw new Error("VS Code did not accept the terminal request in time; no terminal was created. Keep the worktree window open with the Timber extension enabled.");
      if (outcome === "claimed") throw new UncertainHandoff(uncertain);
      if ("error" in outcome) throw new Error(outcome.error === "untrusted" ? restricted(worktree.path) : errorMessages[outcome.error]);
      if (outcome.ack.window !== window || outcome.ack.processId === undefined) throw new UncertainHandoff(uncertain);
      return `"${title}" (pid ${outcome.ack.processId})`;
    },
    /** VS Code has already focused the worktree window; there is nothing more to select. */
    async select(): Promise<void> {},
  };
}
