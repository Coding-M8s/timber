import type { RepositoryConfig } from "../types";
import type { BackupRecord } from "./storage";

export const defaultRetentionDays = 7;
export const defaultWarningBytes = 5 * 1024 ** 3;
const dayMs = 24 * 60 * 60 * 1000;
const units: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };

/** `backup_storage_warning` text such as `5GiB`; null unless a positive safe number of bytes. */
export function parseStorageSize(text: string): number | null {
  const match = /^([1-9][0-9]*)(B|KiB|MiB|GiB|TiB)$/u.exec(text);
  if (!match) return null;
  const bytes = Number(match[1]) * units[match[2]!]!;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/** Effective settings for new backups; null turns retention or the warning off. */
export interface BackupSettings {
  retentionDays: number | null;
  warningBytes: number | null;
}

export function backupSettings(config: Pick<RepositoryConfig, "backupRetentionDays" | "backupStorageWarningBytes">): BackupSettings {
  return {
    retentionDays: config.backupRetentionDays === undefined ? defaultRetentionDays : config.backupRetentionDays,
    warningBytes: config.backupStorageWarningBytes === undefined ? defaultWarningBytes : config.backupStorageWarningBytes,
  };
}

export interface Retention {
  state: "kept" | "until-deleted" | "expiring" | "expired";
  /** Captured policy; null when kept until deleted. */
  retentionDays: number | null;
  /** ISO 8601 UTC; non-null whenever retentionDays is. */
  expiresAt: string | null;
}

/** Null for version 1 records, which have no policy and never expire. */
export function retentionOf(record: BackupRecord, now: Date): Retention | null {
  if (record.version === 1) return null;
  const expires = record.retentionDays === null ? null : Date.parse(record.createdAt) + record.retentionDays * dayMs;
  const expiresAt = expires === null ? null : new Date(expires).toISOString();
  const state = record.keep ? "kept" : expires === null ? "until-deleted" : now.getTime() >= expires ? "expired" : "expiring";
  return { state, retentionDays: record.retentionDays, expiresAt };
}

/** Eligible for automatic cleanup when also usable and unprotected. */
export function isExpired(record: BackupRecord, now: Date): boolean {
  return retentionOf(record, now)?.state === "expired";
}

export function describeRetention(record: BackupRecord, now: Date, isProtected: boolean): string {
  const retention = retentionOf(record, now);
  if (retention === null) return "none, no retention policy; kept until deleted";
  switch (retention.state) {
    case "kept": return retention.retentionDays === null ? "kept indefinitely"
      : `kept indefinitely (timber backup unkeep ${record.id} restores its ${retention.retentionDays}-day retention)`;
    case "until-deleted": return "kept until deleted (no expiry when created)";
    case "expiring": return `expires ${retention.expiresAt} (${retention.retentionDays} day${retention.retentionDays === 1 ? "" : "s"})`;
    case "expired": return isProtected ? `expired ${retention.expiresAt}; kept while protected`
      : `expired ${retention.expiresAt}; deleted by the next timber backup create or timber backup cleanup`;
  }
}
