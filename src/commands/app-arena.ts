import { readAppArenaLaunch, readAppArenaList, readAppArenaTools, type AppArenaServices } from "../app-arena/read";
import { loadRepositoryConfig } from "../config";
import { discoverRepository } from "../git/repository";
import { checkExecutable } from "../setup/executable";
import type { CommandContext } from "../services";

export type { AppArenaServices } from "../app-arena/read";

export const defaultAppArenaServices = (env: NodeJS.ProcessEnv = process.env): AppArenaServices => ({
  discoverRepository: cwd => discoverRepository(cwd),
  loadConfig: repository => loadRepositoryConfig(repository, env),
  checkExecutable,
});

/**
 * Experimental read-only arena transport for app consumers. Prints one JSON
 * object to stdout; exits 1 when the record reports a failure.
 */
export async function runAppArena(
  action: string, name: string | undefined, options: { attempt?: string }, context: CommandContext,
  services: AppArenaServices = defaultAppArenaServices(),
): Promise<number> {
  if (action === "tools") {
    if (name !== undefined || options.attempt !== undefined) throw new Error("__app-arena tools takes no arguments.");
    context.io.stdout(JSON.stringify(readAppArenaTools()) + "\n");
    return 0;
  }
  if (action === "list") {
    const record = await readAppArenaList(context.cwd, services);
    context.io.stdout(JSON.stringify(record) + "\n");
    return record.diagnostic === null && record.arenas.every(entry => entry.outcome === "read") ? 0 : 1;
  }
  if (action === "launch") {
    const record = await readAppArenaLaunch(context.cwd, name ?? "", options.attempt, services);
    context.io.stdout(JSON.stringify(record) + "\n");
    return record.outcome === "failed" ? 1 : 0;
  }
  throw new Error("Unknown __app-arena action. Use tools, list or launch.");
}
