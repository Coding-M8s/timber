import { execa } from "execa";
import { retryForDisplay } from "./display";
import type { CommandIO } from "./services";
import type { RepositoryConfig, RepositoryContext, Worktree } from "./types";

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
  return "the setup shell could not run";
}

/** Linux setup uses fixed /bin/sh and unchanged trusted source; context is environment data only. */
export async function runSetup(
  repository: RepositoryContext,
  worktree: Worktree,
  config: RepositoryConfig,
  io: CommandIO,
): Promise<void> {
  const hooks = config.hooks?.postCreate ?? [];
  const taskId = worktree.branch?.match(/^([A-Z][A-Z0-9]*-\d+)(?=$|[-_./])/)?.[1];
  const env = {
    TIMBER_REPO: repository.primaryWorktreeRoot,
    TIMBER_WORKTREE: worktree.path,
    TIMBER_BRANCH: worktree.branch ?? "",
    // Undefined removes inherited values: caller context must not leak into the selected workspace.
    TIMBER_TASK_ID: taskId,
  };

  for (const [index, source] of hooks.entries()) {
    try {
      const child = execa("/bin/sh", ["-c", source], {
        cwd: worktree.path,
        env,
        stdin: "ignore",
        buffer: false,
      });
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => io.stdout(chunk));
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => io.stderr(chunk));
      await child;
    } catch (error) {
      // Execa's message includes shell source/output, so report only structured failure metadata.
      throw new Error(
        `Setup post_create step ${index + 1} failed (${failureReason(error)}). ` +
        `The branch/worktree and setup files are retained at ${displayPath(worktree.path)}. ` +
        `Fix the hook or its prerequisites, then retry all setup steps with: ${retryCommand(worktree.path)}`,
      );
    }
  }
}
