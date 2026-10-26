import { findExecutable, nativeCommand } from "../platform/executable";

/** Availability only: never execute a tool or its version flag during setup. */
export async function checkExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = await findExecutable(command, env);
  if (path === null) return false;
  try { nativeCommand(path); return true; } catch { return false; }
}
