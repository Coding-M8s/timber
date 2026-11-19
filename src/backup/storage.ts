import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { validateWindowsComponent } from "../platform/paths";
import { isGitName } from "./snapshot";
import { assertPrivateStorage, privateDirectory, protectNewStorage } from "../platform/private-storage";

export type ManifestEntry =
  | { path: string; type: "directory"; mode: number }
  | { path: string; type: "file"; mode: number; size: number; sha256: string; blob: string }
  | { path: string; type: "symlink"; target: string };

export interface BackupRecord {
  version: 1;
  id: string;
  createdAt: string;
  commonGitDir: string;
  worktreePath: string;
  worktreeGitDir: string;
  /** Null means the source worktree had a detached HEAD. */
  branch: string | null;
  commit: string;
  ref: string;
  entries: number;
  bytes: number;
  manifestSha256: string;
}

export const backupIdPattern = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/u;
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const sha256 = /^[0-9a-f]{64}$/u;
const blobPattern = /^\d{6,}$/u;

export class BackupRecordError extends Error {}

export function newBackupId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

export function backupRef(id: string): string {
  return `refs/timber/backups/${id}`;
}

export function recoveryBranch(id: string): string {
  return `recovery/${id}`;
}

/** Shared by every worktree; outside all worktree roots so removal cannot reach it. */
export function backupsRoot(commonGitDir: string): string {
  return join(commonGitDir, "timber", "backups");
}

export async function ensureBackupsRoot(commonGitDir: string): Promise<string> {
  try {
    await privateDirectory(join(commonGitDir, "timber"));
    await privateDirectory(backupsRoot(commonGitDir));
  } catch {
    throw new BackupRecordError("Cannot prepare private backup storage in the Git directory; check its permissions. No backup was created.");
  }
  return backupsRoot(commonGitDir);
}

export async function createPrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await protectNewStorage(path);
  await assertPrivateStorage(path, await lstat(path), true);
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally { await handle.close(); }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function digest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Exact bytes of a private regular file; record digests are taken over these, not decoded text. */
export async function readPrivateBytes(path: string): Promise<Buffer> {
  const info = await lstat(path);
  await assertPrivateStorage(path, info, false);
  return readFile(path);
}

async function readPrivate(path: string): Promise<string> {
  return (await readPrivateBytes(path)).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function mode(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0o777;
}

export function validateRecord(value: unknown, id: string): BackupRecord {
  const keys = ["version", "id", "createdAt", "commonGitDir", "worktreePath", "worktreeGitDir", "branch", "commit", "ref",
    "entries", "bytes", "manifestSha256"];
  if (!isRecord(value) || !exactKeys(value, keys) || value.version !== 1 || value.id !== id
    || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))
    || typeof value.commonGitDir !== "string" || !isAbsolute(value.commonGitDir)
    || typeof value.worktreePath !== "string" || !isAbsolute(value.worktreePath)
    || typeof value.worktreeGitDir !== "string" || !isAbsolute(value.worktreeGitDir)
    || !(value.branch === null || (typeof value.branch === "string" && value.branch.length > 0))
    || typeof value.commit !== "string" || !oid.test(value.commit) || value.ref !== backupRef(id)
    || !count(value.entries) || !count(value.bytes)
    || typeof value.manifestSha256 !== "string" || !sha256.test(value.manifestSha256)) {
    throw new BackupRecordError("Backup record is malformed or unsupported; it cannot be used.");
  }
  return value as unknown as BackupRecord;
}

function validSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === ".." || isGitName(segment)) return false;
  if (process.platform !== "win32") return true;
  // Windows treats backslashes and drive prefixes as path syntax and folds `.git.`/`.GIT` to `.git`.
  try { validateWindowsComponent(segment); } catch { return false; }
  return segment.toLowerCase() !== ".git";
}

function validPath(path: unknown): path is string {
  if (typeof path !== "string" || !path || path.includes("\0") || path.startsWith("/")) return false;
  return path.split("/").every(validSegment);
}

/** Paths are unique, relative, Git-admin free, and every parent is a declared directory first. */
export function validateManifest(value: unknown): ManifestEntry[] {
  const invalid = () => new BackupRecordError("Backup manifest is malformed or unsafe; it cannot be used.");
  if (!Array.isArray(value)) throw invalid();
  const seen = new Set<string>();
  const directories = new Set<string>();
  const blobs = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || !validPath(entry.path) || seen.has(entry.path)) throw invalid();
    const slash = entry.path.lastIndexOf("/");
    if (slash !== -1 && !directories.has(entry.path.slice(0, slash))) throw invalid();
    if (entry.type === "directory") {
      if (!exactKeys(entry, ["path", "type", "mode"]) || !mode(entry.mode)) throw invalid();
      directories.add(entry.path);
    } else if (entry.type === "file") {
      if (!exactKeys(entry, ["path", "type", "mode", "size", "sha256", "blob"]) || !mode(entry.mode) || !count(entry.size)
        || typeof entry.sha256 !== "string" || !sha256.test(entry.sha256)
        || typeof entry.blob !== "string" || !blobPattern.test(entry.blob) || blobs.has(entry.blob)) throw invalid();
      blobs.add(entry.blob);
    } else if (entry.type === "symlink") {
      if (!exactKeys(entry, ["path", "type", "target"]) || typeof entry.target !== "string"
        || !entry.target || entry.target.includes("\0")) throw invalid();
    } else {
      throw invalid();
    }
    seen.add(entry.path);
  }
  return value as ManifestEntry[];
}

export interface PublishedBackup {
  directory: string;
  record: BackupRecord;
  manifest: ManifestEntry[];
  /** Digest of the exact record bytes; deletion compares it to prove the same backup. */
  recordSha256: string;
  /** Directory identity at read time; a replaced directory or link has a different identity. */
  device: number;
  inode: number;
}

/** Read a published backup without trusting its location, permissions or contents. */
export async function readPublishedBackup(commonGitDir: string, id: string): Promise<PublishedBackup> {
  if (!backupIdPattern.test(id)) throw new BackupRecordError("Invalid backup ID; use the ID printed by timber backup create.");
  try {
    await assertPrivateStorage(join(commonGitDir, "timber"), await lstat(join(commonGitDir, "timber")), true);
    await assertPrivateStorage(backupsRoot(commonGitDir), await lstat(backupsRoot(commonGitDir)), true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BackupRecordError("No backup with that ID exists in this repository.");
    throw new BackupRecordError("Backup storage is not a private directory; inspect it before retrying.");
  }
  return readBackupAt(join(backupsRoot(commonGitDir), id), id);
}

/** Read one backup directory, published or being deleted, after its parents were checked. */
export async function readBackupAt(directory: string, id: string): Promise<PublishedBackup> {
  let info;
  try {
    info = await lstat(directory);
    await assertPrivateStorage(directory, info, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BackupRecordError("No backup with that ID exists in this repository.");
    throw new BackupRecordError("Backup storage is not a private directory; inspect it before retrying.");
  }
  let recordBytes: Buffer, recordText: string, manifestText: string;
  try {
    recordBytes = await readPrivateBytes(join(directory, "record.json"));
    recordText = recordBytes.toString("utf8");
    manifestText = await readPrivate(join(directory, "manifest.json"));
  } catch { throw new BackupRecordError("Backup record or manifest is missing, unreadable or not private; it cannot be used."); }
  let record: BackupRecord, manifest: ManifestEntry[];
  try {
    record = validateRecord(JSON.parse(recordText), id);
    if (digest(manifestText) !== record.manifestSha256) throw new BackupRecordError("Backup manifest does not match its record; it cannot be used.");
    manifest = validateManifest(JSON.parse(manifestText));
  } catch (error) {
    if (error instanceof BackupRecordError) throw error;
    throw new BackupRecordError("Backup record or manifest is malformed; it cannot be used.");
  }
  const bytes = manifest.reduce((total, entry) => total + (entry.type === "file" ? entry.size : 0), 0);
  if (manifest.length !== record.entries || bytes !== record.bytes) {
    throw new BackupRecordError("Backup manifest totals do not match its record; it cannot be used.");
  }
  return { directory, record, manifest, recordSha256: digest(recordBytes), device: info.dev, inode: info.ino };
}
