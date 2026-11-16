import type { CommandHandlers, CommandServices } from "../services";
import { selectRegisteredWorktree } from "./select-worktree";

/** Select a registered worktree; the backup service owns fresh checks and storage. */
export function createBackupCreateHandler(
  services: Pick<CommandServices, "discoverRepository" | "loadConfig" | "resolveOpenTarget" | "createBackup">,
): NonNullable<CommandHandlers["backupCreate"]> {
  return async (input, context) => {
    if (!input.trim()) throw new Error("Provide an existing branch or absolute worktree path to back up.");
    const repository = await services.discoverRepository(context.cwd);
    const config = await services.loadConfig(repository);
    const selected = await selectRegisteredWorktree(services, repository, config, input, context,
      { command: "backup", past: "backed up", rerun: "timber backup create" });
    if (selected === null) { context.io.stdout("Cancelled.\n"); return 0; }
    return services.createBackup(repository, selected, context.io);
  };
}

/** Restore resolves the destination from the invoking directory, never from config. */
export function createBackupRestoreHandler(
  services: Pick<CommandServices, "discoverRepository" | "restoreBackup">,
): NonNullable<CommandHandlers["backupRestore"]> {
  return async (id, destination, context) => {
    const repository = await services.discoverRepository(context.cwd);
    return services.restoreBackup(repository, id, destination, context.cwd, context.io);
  };
}
