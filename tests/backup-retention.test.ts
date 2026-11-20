import { expect, test } from "bun:test";
import { parseConfigSource, resolveConfig, type ConfigScopes } from "../src/config";
import {
  backupSettings, defaultRetentionDays, defaultWarningBytes, describeRetention, parseStorageSize, retentionOf,
} from "../src/backup/retention";
import { validateRecord, type BackupRecord, type BackupRecordV2 } from "../src/backup/storage";

const day = 24 * 60 * 60 * 1000;
const created = "2026-11-10T12:00:00.000Z";

function record(overrides: Partial<BackupRecordV2> = {}): BackupRecordV2 {
  return {
    version: 2, id: "20261110T120000Z-0123abcd", createdAt: created, commonGitDir: "/repo/.git",
    worktreePath: "/repo", worktreeGitDir: "/repo/.git", branch: "main", commit: "a".repeat(40),
    ref: "refs/timber/backups/20261110T120000Z-0123abcd", entries: 0, bytes: 0, manifestSha256: "0".repeat(64),
    origin: "manual", retentionDays: 7, keep: false, ...overrides,
  } as BackupRecordV2;
}

function scopes(global: string, local: string | null = null): ConfigScopes {
  return {
    global: { path: "/g.toml", source: global, values: parseConfigSource(global, "/g.toml") },
    local: local === null ? null : { path: "/r/.timber.toml", source: local, values: parseConfigSource(local, "/r/.timber.toml") },
  };
}

test("backup settings default to 7 days and a 5 GiB warning", () => {
  expect(backupSettings(resolveConfig(scopes(""), "/r"))).toEqual({ retentionDays: 7, warningBytes: 5 * 1024 ** 3 });
  expect(defaultRetentionDays).toBe(7);
  expect(defaultWarningBytes).toBe(5 * 1024 ** 3);
});

test("repository backup keys override global ones key by key, and false turns each off", () => {
  const both = scopes('backup_retention_days = 30\nbackup_storage_warning = "2GiB"\n', "backup_retention_days = false\n");
  expect(backupSettings(resolveConfig(both, "/r"))).toEqual({ retentionDays: null, warningBytes: 2 * 1024 ** 3 });
  const off = scopes("backup_storage_warning = false\n", "backup_retention_days = 3\n");
  expect(backupSettings(resolveConfig(off, "/r"))).toEqual({ retentionDays: 3, warningBytes: null });
});

test("invalid backup values are rejected naming the key but never the value", () => {
  for (const source of [
    "backup_retention_days = 0", "backup_retention_days = -1", "backup_retention_days = 1.5",
    "backup_retention_days = 36501", "backup_retention_days = true", 'backup_retention_days = "7"',
  ]) expect(() => parseConfigSource(source, "/c.toml")).toThrow("backup_retention_days is invalid");
  for (const source of [
    'backup_storage_warning = "0GiB"', 'backup_storage_warning = "5 GiB"', 'backup_storage_warning = "5GB"',
    'backup_storage_warning = "1.5GiB"', "backup_storage_warning = true", "backup_storage_warning = 5",
    'backup_storage_warning = "99999999999TiB"', 'backup_storage_warning = "05GiB"',
  ]) {
    let message = "";
    try { parseConfigSource(source, "/c.toml"); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("backup_storage_warning is invalid");
    expect(message).not.toContain("GiB");
  }
  expect(parseConfigSource("backup_retention_days = 36500", "/c.toml").backup_retention_days).toBe(36500);
});

test("storage sizes use binary units and stay within safe integers", () => {
  expect(parseStorageSize("1B")).toBe(1);
  expect(parseStorageSize("3KiB")).toBe(3072);
  expect(parseStorageSize("5GiB")).toBe(5 * 1024 ** 3);
  expect(parseStorageSize("2TiB")).toBe(2 * 1024 ** 4);
  expect(parseStorageSize("8192TiB")).toBeNull();
  expect(parseStorageSize("0B")).toBeNull();
  expect(parseStorageSize("1 MiB")).toBeNull();
});

test("version 2 records validate their retention fields exactly", () => {
  expect((validateRecord(record(), record().id) as BackupRecordV2).retentionDays).toBe(7);
  expect((validateRecord(record({ retentionDays: null, keep: true }), record().id) as BackupRecordV2).keep).toBe(true);
  for (const bad of [
    { retentionDays: 0 }, { retentionDays: 36501 }, { retentionDays: 1.5 }, { keep: "yes" }, { origin: "rebase" },
  ]) expect(() => validateRecord(record(bad as Partial<BackupRecordV2>), record().id)).toThrow();
  const { keep: _keep, ...missing } = record();
  expect(() => validateRecord(missing, record().id)).toThrow();
  // Version 1 records must not carry version 2 fields.
  expect(() => validateRecord({ ...record(), version: 1 }, record().id)).toThrow();
  expect(() => validateRecord({ ...record(), version: 3 }, record().id)).toThrow();
});

test("expiry boundary: expiring until the exact instant, expired from it on", () => {
  const expiresAt = new Date(Date.parse(created) + 7 * day);
  expect(retentionOf(record(), new Date(expiresAt.getTime() - 1))).toEqual(
    { state: "expiring", retentionDays: 7, expiresAt: expiresAt.toISOString() });
  expect(retentionOf(record(), expiresAt)?.state).toBe("expired");
  expect(retentionOf(record(), new Date(expiresAt.getTime() + 365 * day))?.state).toBe("expired");
  // A clock before creation never expires a backup.
  expect(retentionOf(record(), new Date(0))?.state).toBe("expiring");
});

test("kept, until-deleted and version 1 backups never expire", () => {
  const far = new Date(Date.parse(created) + 100_000 * day);
  expect(retentionOf(record({ keep: true }), far)).toEqual(
    { state: "kept", retentionDays: 7, expiresAt: new Date(Date.parse(created) + 7 * day).toISOString() });
  expect(retentionOf(record({ retentionDays: null }), far)).toEqual({ state: "until-deleted", retentionDays: null, expiresAt: null });
  expect(retentionOf(record({ retentionDays: null, keep: true }), far)).toEqual({ state: "kept", retentionDays: null, expiresAt: null });
  const { origin: _o, retentionDays: _r, keep: _k, ...v1 } = record();
  expect(retentionOf({ ...v1, version: 1 } as BackupRecord, far)).toBeNull();
});

test("retention descriptions name the state, time and the command that changes it", () => {
  const now = new Date(Date.parse(created) + day);
  expect(describeRetention(record(), now, false)).toBe("expires 2026-11-17T12:00:00.000Z (7 days)");
  expect(describeRetention(record({ retentionDays: 1 }), now, false))
    .toBe("expired 2026-11-11T12:00:00.000Z; deleted by the next timber backup create or timber backup cleanup");
  expect(describeRetention(record({ retentionDays: 1 }), now, true)).toBe("expired 2026-11-11T12:00:00.000Z; kept while protected");
  expect(describeRetention(record({ keep: true }), now, false))
    .toBe(`kept indefinitely (timber backup unkeep ${record().id} restores its 7-day retention)`);
  expect(describeRetention(record({ keep: true, retentionDays: null }), now, false)).toBe("kept indefinitely");
  expect(describeRetention(record({ retentionDays: null }), now, false)).toBe("kept until deleted (no expiry when created)");
  const { origin: _o, retentionDays: _r, keep: _k, ...v1 } = record();
  expect(describeRetention({ ...v1, version: 1 } as BackupRecord, now, false)).toBe("none, no retention policy; kept until deleted");
});

test("setup-rendered config round-trips both backup keys, including false, beside tables", async () => {
  const { renderConfig } = await import("../src/setup/render");
  for (const values of [
    { backup_retention_days: 14, backup_storage_warning: "2GiB", editor: { command: "code", args: [], enabled: false } },
    { backup_retention_days: false as const, backup_storage_warning: false as const, editor: { command: "zed", args: ["--new"], enabled: true } },
  ]) {
    const source = renderConfig(values);
    expect(source).toContain("# backup_retention_days = 7");
    const parsed = parseConfigSource(source, "/c.toml");
    expect(parsed).toEqual(values);
    expect(backupSettings(resolveConfig({ global: { path: "/c.toml", source, values: parsed }, local: null }, "/r")))
      .toEqual(values.backup_retention_days === false ? { retentionDays: null, warningBytes: null } : { retentionDays: 14, warningBytes: 2 * 1024 ** 3 });
  }
});
