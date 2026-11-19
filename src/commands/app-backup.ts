import { createBackupDeleteReport, deleteConfirmedBackup } from "../backup/lifecycle";
import { discoverRepository } from "../git/repository";
import { runMachineCommand } from "../machine";
import type { CommandContext } from "../services";

interface AppBackupOptions { id?: string; recordSha256?: string; resultFile?: string }

/**
 * Experimental backup transport for app consumers. The app shows the backup and asks for
 * confirmation; Timber deletes only the backup whose record bytes match what was confirmed.
 * No prompt and no terminal requirement, and never more than one backup per run.
 */
export async function runAppBackup(action: string, options: AppBackupOptions, context: CommandContext): Promise<number> {
  if (action !== "delete") throw new Error("Unknown __app-backup action. Use delete.");
  const { id, recordSha256, resultFile } = options;
  if (id === undefined || recordSha256 === undefined || resultFile === undefined) {
    throw new Error("Delete requires --id, --record-sha256 and --result-file. Nothing was deleted.");
  }
  return runMachineCommand("backup-delete", context, async ({ machine }) => {
    const report = createBackupDeleteReport();
    machine?.backupDelete(report);
    const repository = await discoverRepository(context.cwd);
    await machine?.repository(repository);
    return deleteConfirmedBackup(repository, id, recordSha256, context.io, report);
  }, resultFile);
}
