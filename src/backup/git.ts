import { execa } from "execa";

export const backupGitEnvironment = {
  GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "false", SSH_ASKPASS: "false", GCM_INTERACTIVE: "Never",
  GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_OPTIONAL_LOCKS: "0",
};
export const disabledHooks = process.platform === "win32" ? "NUL" : "/dev/null";

/** Hooks are repository code; backup commands never run them. */
export async function backupGit(cwd: string, args: readonly string[]) {
  try {
    return await execa("git", ["-c", `core.hooksPath=${disabledHooks}`, ...args], { cwd, stdin: "ignore", reject: false, env: backupGitEnvironment });
  } catch {
    throw new Error("Could not start Git for backup; check the Git installation and repository access.");
  }
}
