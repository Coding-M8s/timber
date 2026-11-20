import { backupSettings } from "../backup/retention";
import { createBackupRestoreReport } from "../backup/service";
import type { CommandHandlers, CommandServices } from "../services";
import { selectRegisteredWorktree } from "./select-worktree";

/** Select a registered worktree; the backup service owns fresh checks and storage. */
export function createBackupCreateHandler(
  services: Pick<CommandServices, "discoverRepository" | "loadConfig" | "resolveOpenTarget" | "createBackup">,
): NonNullable<CommandHandlers["backupCreate"]> {
  return async (input, context, options = { keep: false }) => {
    if (!input.trim()) throw new Error("Provide an existing branch or absolute worktree path to back up.");
    const repository = await services.discoverRepository(context.cwd);
    const config = await services.loadConfig(repository);
    const selected = await selectRegisteredWorktree(services, repository, config, input, context,
      { command: "backup", past: "backed up", rerun: "timber backup create" });
    if (selected === null) { context.io.stdout("Cancelled.\n"); return 0; }
    return services.createBackup(repository, selected, context.io,
      { keep: options.keep, settings: backupSettings(config), ask: context.ask });
  };
}

/** Policy-driven deletion of expired backups; needs no terminal and reads no configuration. */
export function createBackupCleanupHandler(
  services: Pick<CommandServices, "discoverRepository" | "cleanupBackups">,
): NonNullable<CommandHandlers["backupCleanup"]> {
  return async context => services.cleanupBackups(await services.discoverRepository(context.cwd), context.io);
}

/** `backup keep|unkeep <id>`: changes only the record's keep flag. */
export function createBackupKeepHandler(
  services: Pick<CommandServices, "discoverRepository" | "setBackupKeep">,
): NonNullable<CommandHandlers["backupKeep"]> {
  return async (id, keep, context) => services.setBackupKeep(await services.discoverRepository(context.cwd), id, keep, context.io);
}

/** Restore resolves the destination from the invoking directory, never from config. */
export function createBackupRestoreHandler(
  services: Pick<CommandServices, "discoverRepository" | "restoreBackup">,
): NonNullable<CommandHandlers["backupRestore"]> {
  return async (id, destination, context) => {
    // Result-file mode reports through the record; a stop before Git creates anything is a refusal.
    const report = context.machine ? createBackupRestoreReport() : undefined;
    if (report) context.machine?.backupRestore(report);
    const repository = await services.discoverRepository(context.cwd);
    await context.machine?.repository(repository);
    return services.restoreBackup(repository, id, destination, context.cwd, context.io, report);
  };
}

/** Read-only; reports problems without treating them as deletion authorization. */
export function createBackupListHandler(
  services: Pick<CommandServices, "discoverRepository" | "listBackups" | "readBackupList">,
): NonNullable<CommandHandlers["backupList"]> {
  return async (context, options = {}) => {
    if (options.json) {
      // One JSON record on stdout, including discovery and storage failures; nothing on stderr.
      const record = await services.readBackupList(context.cwd, cwd => services.discoverRepository(cwd));
      context.io.stdout(JSON.stringify(record) + "\n");
      return record.exitCode;
    }
    return services.listBackups(await services.discoverRepository(context.cwd), context.io);
  };
}

/** Deletion needs the interactive text prompt; without a terminal it refuses before reading storage. */
export function createBackupDoneHandler(
  services: Pick<CommandServices, "discoverRepository" | "reviewBackupDeletion">,
): NonNullable<CommandHandlers["backupDone"]> {
  return async (options, context) => {
    if (!context.ask) {
      throw new Error("Deleting backups requires an interactive terminal; nothing was deleted. Review them with timber backup list.");
    }
    const repository = await services.discoverRepository(context.cwd);
    return services.reviewBackupDeletion(repository, options, context.io, context.ask);
  };
}
