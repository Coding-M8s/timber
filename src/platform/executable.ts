import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve, win32 } from "node:path";

export function executableCandidates(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const windows = platform === "win32";
  const paths = windows ? win32 : { isAbsolute, join, resolve };
  const explicit = command.includes("/") || (windows && command.includes("\\"));
  const bases = explicit
    ? [paths.isAbsolute(command) ? command : paths.resolve(command)]
    : (env.PATH ?? env.Path ?? "").split(windows ? ";" : delimiter)
      .filter(directory => !windows || directory.length > 0)
      .map(directory => paths.join(directory.replace(/^"(.*)"$/u, "$1") || ".", command));
  const extensions = windows && !win32.extname(command)
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(extension => /^\.[a-z0-9]+$/iu.test(extension)) : [];
  return bases.flatMap(base => [base, ...extensions.map(extension => base + extension)]);
}

export class NativeExecutableError extends Error {}

export function nativeCommand(command: string, platform = process.platform): string {
  if (platform === "win32" && (command.includes("/") || command.includes("\\") || /^[a-z]:/iu.test(command))) {
    const root = win32.parse(command).root;
    if (!win32.isAbsolute(command) || root === "\\" || root === "/") {
      throw new NativeExecutableError("Use a fully qualified native executable path or a program name on PATH; drive-relative Windows commands are unsafe across worktrees.");
    }
  }
  if (platform === "win32" && /\.(?:cmd|bat|ps1)$/iu.test(command)) {
    throw new NativeExecutableError("Choose a native executable (.exe) on Windows. For PowerShell scripts configure powershell.exe with literal -File arguments.");
  }
  return command;
}

export async function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  for (const path of executableCandidates(command, env)) {
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch { /* Availability checks never execute a candidate. */ }
  }
  return null;
}

/** Windows cannot spawn command scripts without cmd.exe source parsing. */
export async function resolveNativeCommand(command: string): Promise<string> {
  if (process.platform !== "win32") return command;
  nativeCommand(command);
  const found = await findExecutable(command);
  if (found === null) throw Object.assign(new Error("Native executable was not found on PATH."), { code: "ENOENT" });
  return nativeCommand(found);
}
