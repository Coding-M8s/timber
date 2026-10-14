import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** Availability only: never execute a tool or its version flag during setup. */
export async function checkExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const paths = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(command)]
    : (env.PATH ?? "").split(delimiter).map(directory => join(directory || ".", command));
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return true;
    } catch { /* Try the next PATH entry. */ }
  }
  return false;
}
