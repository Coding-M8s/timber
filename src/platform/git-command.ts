import { accessSync, constants, statSync } from "node:fs";
import { executableCandidates } from "./executable";

const resolved = new Map<string, string>();

function findGitExe(env: NodeJS.ProcessEnv): string | null {
  // Only a native git.exe: Windows cannot spawn git.cmd or an extensionless script directly.
  for (const path of executableCandidates("git.exe", env, "win32")) {
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

/**
 * The program to spawn for Git. On Windows, the full path of the first git.exe on PATH,
 * looked up once per PATH value, so each call skips the per-spawn PATH search. Elsewhere,
 * and when no git.exe is found, plain "git", so a missing Git fails exactly as before.
 */
export function gitCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== "win32") return "git";
  const key = env.PATH ?? "";
  let command = resolved.get(key);
  if (command === undefined) {
    command = findGitExe(env) ?? "git";
    resolved.set(key, command);
  }
  return command;
}
