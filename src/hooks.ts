import { execa } from "execa";
import { hookShell } from "./platform/hook-shell";
import { retryForDisplay, shellQuoteForDisplay } from "./display";
import type { CommandIO } from "./services";
import type { CleanupOptions, RepositoryConfig, RepositoryContext, Worktree } from "./types";

/** Ordinary paths use POSIX quoting; control characters use a printable Bash command. */
function retryCommand(path: string): string {
  return retryForDisplay(path, `timber open --setup -- '${path.replaceAll("'", "'\\''")}'`, "--setup");
}

function displayPath(path: string): string {
  return JSON.stringify(path).replace(/[\u007f-\u009f\u2028\u2029]/gu,
    character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}

function failureReason(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("exitCode" in error && typeof error.exitCode === "number") return `exit code ${error.exitCode}`;
    if ("signal" in error && typeof error.signal === "string" && /^SIG[A-Z0-9]+$/.test(error.signal)) {
      return `signal ${error.signal}`;
    }
  }
  return "the hook shell could not run";
}

export class SetupFailure extends Error {
  constructor(public readonly step: number, public readonly phase: string, public readonly reason: string, path: string) {
    super(`${phase === "ordinary" ? "Setup" : "Setup workflow"} post_create step ${step} failed (${reason}). ` +
      `The branch/worktree and setup files are retained at ${displayPath(path)}. ` +
      `Fix the hook or its prerequisites, then retry all setup steps with: ${retryCommand(path)}`);
  }
}

export interface SetupTask {
  cwd: string;
  repositoryRoot: string;
  branch: string | null;
  workflow?: string | undefined;
  hooks: readonly string[];
  workflowHooks: readonly string[];
}

export function taskEnvironment(task: Pick<SetupTask, "cwd" | "repositoryRoot" | "branch" | "workflow">) {
  return { TIMBER_REPO: task.repositoryRoot, TIMBER_WORKTREE: task.cwd,
    TIMBER_BRANCH: task.branch ?? "",
    TIMBER_TASK_ID: task.branch?.match(/^([A-Z][A-Z0-9]*-\d+)(?=$|[-_./])/)?.[1],
    TIMBER_WORKFLOW: task.workflow };
}

async function runHook(source: string, cwd: string, env: ReturnType<typeof taskEnvironment>, io: CommandIO): Promise<void> {
  const child = execa(await hookShell(), ["-c", source], { cwd, env, stdin: "ignore", buffer: false });
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => io.stdout(chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => io.stderr(chunk));
  await child;
}

/** Cleanup owns safety checks before and after these trusted steps. */
export async function runPreDelete(
  repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig,
  options: CleanupOptions, io: CommandIO,
): Promise<void> {
  const env = taskEnvironment({ cwd: worktree.path, repositoryRoot: repository.primaryWorktreeRoot,
    branch: worktree.branch });
  for (const [index, source] of (config.hooks?.preDelete ?? []).entries()) {
    try {
      await runHook(source, worktree.path, env, io);
    } catch (error) {
      const flags = [options.keepBranch ? "--keep-branch" : "", !options.discardIgnored ? "--keep-ignored" : "",
        options.base === undefined ? "" : `--base ${shellQuoteForDisplay(options.base)}`]
        .filter(Boolean).join(" ");
      const ordinary = `timber done ${flags ? flags + " " : ""}-- '${worktree.path.replaceAll("'", "'\\''")}'`;
      const retry = retryForDisplay(worktree.path, ordinary, flags, "done");
      throw new Error(`Pre-deletion pre_delete step ${index + 1} failed (${failureReason(error)}). ` +
        `Timber did not remove the worktree or delete its branch at ${displayPath(worktree.path)}. ` +
        `Hook side effects are retained. Fix the hook or its prerequisites, then retry all pre-deletion steps with: ${retry}`);
    }
  }
}

/** POSIX hook source is unchanged on every platform; context is environment data only. */
export async function runSetup(
  repository: RepositoryContext,
  worktree: Worktree,
  config: RepositoryConfig,
  io: CommandIO,
  workflowName?: string,
  workflowScripts: readonly string[] = [],
): Promise<void> {
  return runSetupTask({ cwd: worktree.path, repositoryRoot: repository.primaryWorktreeRoot,
    branch: worktree.branch, ...(workflowName === undefined ? {} : { workflow: workflowName }),
    hooks: config.hooks?.postCreate ?? [], workflowHooks: workflowScripts }, io);
}

export async function runSetupTask(task: SetupTask, io: CommandIO): Promise<void> {
  const hooks = [
    ...task.hooks.map(source => ({ source, phase: "ordinary" })),
    ...task.workflowHooks.map(source => ({ source, phase: "workflow" })),
  ];
  const env = taskEnvironment(task);

  for (const [index, step] of hooks.entries()) {
    try {
      await runHook(step.source, task.cwd, env, io);
    } catch (error) {
      // Execa's message includes shell source/output, so report only structured failure metadata.
      throw new SetupFailure(index + 1, step.phase, failureReason(error), task.cwd);
    }
  }
}
