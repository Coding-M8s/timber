import { spawn } from "node:child_process";
import { failureWithRetry, retryNamingWorkflow, safeDisplay, shellQuoteForDisplay, workflowRetryFlag } from "./display";
import { NativeExecutableError, resolveNativeCommand } from "./platform/executable";
import { childExitCode } from "./platform/signals";
import type { CommandIO } from "./services";
import type { AgentCommand, AgentResult, ExecutableCommand, RepositoryConfig, Worktree } from "./types";

/** Resolve opt-in and terminal hosting capability before Git mutation. */
export function resolveAgentCommand(
  config: RepositoryConfig, enabled: boolean | undefined, canHostAgent: boolean,
): AgentCommand | null {
  if (!(enabled ?? config.agent?.enabled ?? false)) return null;
  if (config.agent === null) {
    throw new Error("Configure an agent before using --agent. Run timber setup in this repository or timber setup --global for machine defaults.");
  }
  if (!canHostAgent) {
    if (enabled === true) throw new Error("Use an interactive stdin/stdout terminal with CI disabled for --agent, or enable the Orca editor integration. Use --no-agent for unattended commands.");
    return null;
  }
  return config.agent;
}

function failure(worktree: Worktree, error: unknown): AgentResult {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  const reason = error instanceof NativeExecutableError ? error.message : code === "ENOENT" ? "The agent executable or worktree path was not found."
    : code === "EACCES" ? "Permission was denied while starting the agent."
    : code === "ENOTDIR" ? "An executable or worktree path component is not a directory."
    : "The agent command or worktree path could not be used.";
  const quoted = shellQuoteForDisplay(worktree.path);
  const retryCommand = `timber open --agent --no-editor -- ${quoted}`;
  return {
    kind: "failed",
    message: `Could not start the configured agent: ${reason} Workspace retained at ${safeDisplay(worktree.path)}. Fix the agent configuration or PATH, then retry with: ${retryCommand}`,
    retryCommand,
  };
}

/** Own and await one foreground child. Never detach, unref, or invoke a shell. */
export async function launchAgent(
  worktree: Worktree, command: ExecutableCommand | null, environment?: NodeJS.ProcessEnv,
): Promise<AgentResult> {
  if (command === null) return { kind: "skipped" };
  try {
    const child = spawn(await resolveNativeCommand(command.command), [...command.args], {
      cwd: worktree.path, shell: false, stdio: "inherit", detached: false,
      ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }),
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
          exitCode: childExitCode(code, signal),
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
export function reportAgentResult(
  result: AgentResult, worktree: Worktree, io: CommandIO, workflow?: string | null,
): number {
  if (result.kind === "skipped") return 0;
  if (result.kind === "failed") {
    const failure = retryNamingWorkflow(result, workflow);
    io.stderr(`error: ${failureWithRetry(failure.message, failure.retryCommand, worktree.path, `--agent --no-editor${workflowRetryFlag(workflow)}`)}\n`);
    return 1;
  }
  if (result.exitCode !== 0) {
    io.stderr(`error: Agent ${result.signal ? `interrupted by ${result.signal}` : `exited with status ${result.exitCode}`}. Workspace retained at ${safeDisplay(worktree.path)}.\n`);
  }
  return result.exitCode;
}
