import { readFile } from "node:fs/promises";
import { launchEditor } from "../../src/editor";
import type { EditorResult, RepositoryConfig, Worktree } from "../../src/types";

interface ParentPayload {
  worktree: Worktree;
  config: RepositoryConfig;
  disabled: boolean;
  expectedKind: EditorResult["kind"];
  holdMs?: number;
  reportParentPid?: boolean;
  waitForEditorExit?: { path: string; content: string; timeoutMs: number };
  exitDrainMs?: number;
}

process.on("unhandledRejection", () => {
  process.stderr.write("Unexpected unhandled rejection from editor launch.\n");
  process.exitCode = 1;
});

const payloadPath = process.argv[2];
if (!payloadPath) throw new Error("missing parent fixture payload path");

const payload = JSON.parse(await readFile(payloadPath, "utf8")) as ParentPayload;
const editor = payload.config.editor;
const config = payload.reportParentPid && editor !== null
  ? {
      ...payload.config,
      editor: { ...editor, args: [...editor.args, `--parent-pid=${process.pid}`] },
    }
  : payload.config;

const result = await launchEditor(payload.worktree, config, payload.disabled);
process.stdout.write(JSON.stringify(result));
process.exitCode = result.kind === payload.expectedKind ? 0 : 1;

if (payload.waitForEditorExit) {
  const { path, content, timeoutMs } = payload.waitForEditorExit;
  const deadline = Date.now() + timeoutMs;
  let editorExited = false;
  while (Date.now() < deadline) {
    try {
      if (await readFile(path, "utf8") === content) {
        editorExited = true;
        break;
      }
    } catch {
      // Wait for the editor's completion signal.
    }
    await Bun.sleep(10);
  }
  if (!editorExited) {
    process.stderr.write("Timed out waiting for editor completion signal.\n");
    process.exitCode = 1;
  } else if (payload.exitDrainMs) {
    await Bun.sleep(payload.exitDrainMs);
  }
}

if (payload.holdMs) await Bun.sleep(payload.holdMs);
