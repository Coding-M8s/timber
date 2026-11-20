import { configFileSchema } from "../config";
import type { ConfigFile } from "../config";
import { defaultRetentionDays } from "../backup/retention";
import { maxRetentionDays } from "../backup/storage";
import type { CommandIO } from "../services";
import type { ChoiceOption } from "../selection";
import { SetupCancelled } from "./types";
import type { SetupPrompt, SetupTarget } from "./types";

type BackupKey = "backup_retention_days" | "backup_storage_warning";

export const defaultWarningText = "5GiB";

export const backupExplanation = [
  "Recovery backups can contain copies of ignored files, including secrets such as .env.",
  "Expired backups that are not protected by a rebase may be deleted automatically the next time timber backup create or timber backup cleanup runs.",
  "Nothing runs in the background, so backups stay on disk until Timber runs again or you delete them.",
  "Keep one with timber backup keep <id>.",
].join("\n");

function inherited<K extends BackupKey>(key: K, target: SetupTarget): ConfigFile[K] | undefined {
  return target.scope === "repository" ? target.scopes.global.values[key] : undefined;
}

function describe(key: BackupKey, value: number | string | false): string {
  if (key === "backup_retention_days") return value === false ? "kept until deleted" : `${value} day${value === 1 ? "" : "s"}`;
  return value === false ? "off" : String(value);
}

/** Hub status: effective value, marked as default or inherited. */
export function backupStatus(key: BackupKey, file: ConfigFile, target: SetupTarget): string {
  if (key in file) return describe(key, file[key]!);
  const machine = inherited(key, target);
  if (machine !== undefined) return `${describe(key, machine)} · from machine defaults`;
  return `${describe(key, key === "backup_retention_days" ? defaultRetentionDays : defaultWarningText)} (default)`;
}

async function choose(prompt: SetupPrompt, message: string, choices: readonly ChoiceOption[], defaultValue: string): Promise<string> {
  const result = await prompt.select(message, choices, defaultValue);
  if (result === null) throw new SetupCancelled();
  if (!choices.some(choice => choice.value === result)) throw new Error("Invalid setup choice; no settings saved.");
  return result;
}

/** Edit retention or the storage warning in the draft; invalid custom values retry inline. */
export async function editBackupSetting(key: BackupKey, file: ConfigFile, target: SetupTarget, prompt: SetupPrompt, io: CommandIO): Promise<void> {
  const retention = key === "backup_retention_days";
  const machine = inherited(key, target);
  const fallback = machine !== undefined ? `Use machine defaults (${describe(key, machine)})`
    : `Use the default (${describe(key, retention ? defaultRetentionDays : defaultWarningText)})`;
  const question = retention
    ? `How long should recovery backups be kept before they may be deleted automatically?\n${backupExplanation}`
    : "Warn before recovery backups in this repository grow past what size?\nTimber asks before creating a backup that would exceed it, and refuses without a terminal.";
  const choices: ChoiceOption[] = [
    ...(key in file ? [{ value: "keep", label: `Keep ${describe(key, file[key]!)}` }] : []),
    { value: "inherit", label: fallback },
    { value: "custom", label: retention ? "Custom number of days" : "Custom size" },
    { value: "off", label: retention ? "Keep backups until deleted" : "Turn the warning off" },
  ];
  const selected = await choose(prompt, question, choices, key in file ? "keep" : "inherit");
  if (selected === "keep") return;
  if (selected === "inherit") { delete file[key]; return; }
  if (selected === "off") { file[key] = false; return; }
  while (true) {
    const input = await prompt.text(retention ? "Days to keep each new backup" : "Warning size (for example 5GiB)",
      key in file && file[key] !== false ? String(file[key]) : "");
    if (input === null) throw new SetupCancelled();
    const value = retention ? (/^[0-9]+$/u.test(input.trim()) ? Number(input.trim()) : Number.NaN) : input.trim();
    const parsed = configFileSchema.shape[key].safeParse(value);
    if (parsed.success && parsed.data !== undefined && parsed.data !== false) {
      if (retention) file.backup_retention_days = parsed.data as number;
      else file.backup_storage_warning = parsed.data as string;
      return;
    }
    io.stderr(retention ? `Enter a whole number of days from 1 to ${maxRetentionDays}.\n`
      : "Enter a size such as 5GiB: a whole number followed by B, KiB, MiB, GiB or TiB, with no space.\n");
  }
}
