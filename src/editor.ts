import { once } from "node:events";
import { spawn } from "node:child_process";
import { NativeExecutableError, resolveNativeCommand } from "./platform/executable";
import { shellQuoteForDisplay } from "./display";
import type { EditorResult, RepositoryConfig, Worktree } from "./types";

const startupFailureReasons = new Map([
  ["ENOENT", "The editor executable or worktree path was not found."],
  ["EACCES", "Permission was denied while starting the editor."],
  ["ENOTDIR", "A component of the editor or worktree path is not a directory."],
  ["EINVAL", "The editor command or worktree path is invalid."],
]);

function startupFailureReason(error: unknown): string {
  if (error instanceof NativeExecutableError) return error.message;
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") {
    return "The editor process could not be started.";
  }

  return startupFailureReasons.get(error.code) ?? "The editor process could not be started.";
}

export async function launchEditor(
  worktree: Worktree,
  config: RepositoryConfig,
  disabled: boolean,
): Promise<EditorResult> {
  const editor = config.editor;
  if (disabled || editor === null || !editor.enabled) return { kind: "skipped" };

  const retryCommand = `timber open --editor -- ${shellQuoteForDisplay(worktree.path)}`;

  try {
    const child = spawn(await resolveNativeCommand(editor.command), [...editor.args, worktree.path], {
      cwd: worktree.path,
      shell: false,
      stdio: "ignore",
      detached: true,
    });

    await once(child, "spawn");
    child.unref();
    return { kind: "launched" };
  } catch (error) {
    const message = [
      `Could not start the configured editor: ${startupFailureReason(error)}`,
      "Timber did not remove or modify the workspace.",
      `Check whether the worktree still exists at ${worktree.path}, fix the editor configuration or PATH, then retry with: ${retryCommand}`,
    ].join(" ");
    return { kind: "failed", message, retryCommand };
  }
}
