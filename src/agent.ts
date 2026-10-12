import { spawn } from "node:child_process";
import { constants } from "node:os";
import { retryForDisplay, safeDiagnostic, safeDisplay } from "./display";
import type { CommandIO } from "./services";
import type { AgentResult, ExecutableCommand, RepositoryConfig, Worktree } from "./types";

/** Resolve opt-in before Git mutation; unattended config never starts a session. */
export function resolveAgentCommand(
  config: RepositoryConfig, enabled: boolean | undefined, interactive: boolean,
): ExecutableCommand | null {
  if (!(enabled ?? config.agent?.enabled ?? false)) return null;
  if (config.agent === null) {
    throw new Error("Configure [agent] command and args in the primary repository's .timber.toml before using --agent.");
  }
  if (!interactive) {
    if (enabled === true) throw new Error("--agent requires an interactive stdin/stdout terminal with CI disabled. Use --no-agent for unattended commands.");
    return null;
  }
  return config.agent;
}

function failure(worktree: Worktree, error: unknown): AgentResult {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  const reason = code === "ENOENT" ? "The agent executable or worktree path was not found."
    : code === "EACCES" ? "Permission was denied while starting the agent."
    : code === "ENOTDIR" ? "An executable or worktree path component is not a directory."
    : "The agent command or worktree path could not be used.";
  const quoted = "'" + worktree.path.replaceAll("'", "'\\''") + "'";
  const retryCommand = retryForDisplay(worktree.path, `timber open --agent --no-editor -- ${quoted}`, "--agent --no-editor");
  return {
    kind: "failed",
    message: `Could not start the configured agent: ${reason} Workspace retained at ${safeDisplay(worktree.path)}. Fix the agent configuration or PATH, then retry with: ${retryCommand}`,
    retryCommand,
  };
}

/** Own and await one foreground child. Never detach, unref, or invoke a shell. */
export async function launchAgent(
  worktree: Worktree, command: ExecutableCommand | null,
): Promise<AgentResult> {
  if (command === null) return { kind: "skipped" };
  try {
    const child = spawn(command.command, [...command.args], {
      cwd: worktree.path, shell: false, stdio: "inherit", detached: false,
    });
    return await new Promise<AgentResult>(resolve => {
      // Terminal Ctrl-C already signals our foreground child. Forwarding it
      // again can turn an agent's cancel action into an unintended second interrupt.
      const forwardInterrupt = () => {
        if (!process.stdin.isTTY) forward("SIGINT");
      };
      const forwardTermination = () => forward("SIGTERM");
      function forward(signal: NodeJS.Signals) {
        child.kill(signal);
      }
      function cleanup() {
        process.removeListener("SIGINT", forwardInterrupt);
        process.removeListener("SIGTERM", forwardTermination);
      }
      child.once("error", error => {
        cleanup();
        resolve(failure(worktree, error));
      });
      child.once("close", (code, childSignal) => {
        cleanup();
        const signal = childSignal;
        resolve({
          kind: "exited",
          exitCode: signal === null ? code ?? 1 : 128 + constants.signals[signal],
          signal,
        });
      });
      process.on("SIGINT", forwardInterrupt);
      process.on("SIGTERM", forwardTermination);
    });
  } catch (error) {
    return failure(worktree, error);
  }
}

/** Report only Timber diagnostics; agent stdout/stderr stay attached to the terminal. */
export function reportAgentResult(result: AgentResult, worktree: Worktree, io: CommandIO): number {
  if (result.kind === "skipped") return 0;
  if (result.kind === "failed") {
    const retry = retryForDisplay(worktree.path, result.retryCommand, "--agent --no-editor");
    const included = result.message.includes(result.retryCommand);
    const message = included ? result.message.replace(result.retryCommand, () => retry) : result.message;
    io.stderr(`error: ${safeDiagnostic(message)}${included ? "" : ` Retry with: ${retry}`}\n`);
    return 1;
  }
  if (result.exitCode !== 0) {
    io.stderr(`error: Agent ${result.signal ? `interrupted by ${result.signal}` : `exited with status ${result.exitCode}`}. Workspace retained at ${safeDisplay(worktree.path)}.\n`);
  }
  return result.exitCode;
}
