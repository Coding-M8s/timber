import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, statfs, symlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { samePath } from "../platform/paths";
import type { ManifestEntry } from "./storage";

/**
 * Public messages never include file names, contents or link targets: snapshots
 * routinely contain ignored secrets and their names can be sensitive too.
 */
export class SnapshotError extends Error {}

interface Observed {
  type: "directory" | "file" | "symlink";
  mode: number;
  size: bigint;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  target?: string;
}

/** Case-insensitive filesystems (macOS, Windows) also resolve `.GIT` to Git's admin path. */
export function isGitName(name: string): boolean {
  return process.platform === "darwin" || process.platform === "win32" ? name.toLowerCase() === ".git" : name === ".git";
}

/** Ordered so every directory precedes its children. */
export type SnapshotListing = Map<string, Observed>;

const chunkBytes = 1024 * 1024;
const storageMarginBytes = 1024 * 1024;

function decodeName(raw: Buffer): string {
  const name = raw.toString("utf8");
  if (!Buffer.from(name, "utf8").equals(raw)) {
    throw new SnapshotError("The worktree contains a file name that is not valid UTF-8; backups do not support it, so no backup was created.");
  }
  return name;
}

function observe(info: BigIntStats, type: Observed["type"], target?: string): Observed {
  return {
    type, mode: Number(info.mode & 0o777n), size: info.size, dev: info.dev, ino: info.ino,
    mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs, ...(target === undefined ? {} : { target }),
  };
}

/**
 * Walk without following links. `.git` entries at any depth and nested
 * registered worktree roots are excluded; unsupported types refuse the walk.
 */
export async function walkWorktree(root: string, excludedRoots: readonly string[]): Promise<SnapshotListing> {
  const listing: SnapshotListing = new Map();
  async function visit(directory: string, prefix: string): Promise<void> {
    let names: Buffer[];
    try { names = await readdir(directory, { encoding: "buffer" }); }
    catch { throw new SnapshotError("Cannot read a directory in the worktree; check file access. No backup was created."); }
    const decoded = names.map(decodeName).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const name of decoded) {
      if (isGitName(name)) continue;
      const absolute = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      let info: BigIntStats;
      try { info = await lstat(absolute, { bigint: true }); }
      catch { throw new SnapshotError("Cannot inspect a worktree entry; it may have changed during backup. No backup was created."); }
      if (info.isDirectory()) {
        if (excludedRoots.some(excluded => samePath(excluded, absolute))) continue;
        listing.set(relative, observe(info, "directory"));
        await visit(absolute, relative);
      } else if (info.isFile()) {
        listing.set(relative, observe(info, "file"));
      } else if (info.isSymbolicLink()) {
        let target: string;
        try { target = decodeName(await readlink(absolute, { encoding: "buffer" })); }
        catch (error) {
          if (error instanceof SnapshotError) throw error;
          throw new SnapshotError("Cannot read a symlink in the worktree; it may have changed during backup. No backup was created.");
        }
        listing.set(relative, observe(info, "symlink", target));
      } else {
        throw new SnapshotError("The worktree contains a socket, FIFO, device or other unsupported file type; move it aside before retrying. No backup was created.");
      }
    }
  }
  await visit(root, "");
  return listing;
}

export function snapshotBytes(listing: SnapshotListing): number {
  let total = 0n;
  for (const entry of listing.values()) if (entry.type === "file") total += entry.size;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new SnapshotError("The worktree is too large to back up.");
  return Number(total);
}

function sameObservation(left: Observed, right: Observed): boolean {
  return left.type === right.type && left.mode === right.mode && left.size === right.size
    && left.dev === right.dev && left.ino === right.ino && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs && left.target === right.target;
}

/** Compare two walks of the same tree; any difference means a concurrent change. */
export function sameListing(before: SnapshotListing, after: SnapshotListing): boolean {
  if (before.size !== after.size) return false;
  for (const [path, entry] of before) {
    const other = after.get(path);
    if (!other || !sameObservation(entry, other)) return false;
  }
  return true;
}

export async function assertStorageSpace(directory: string, bytes: number): Promise<void> {
  let available: number;
  try {
    const info = await statfs(directory);
    available = Number(info.bavail) * Number(info.bsize);
  } catch { throw new SnapshotError("Cannot check free space for backup storage. No backup was created."); }
  if (available < bytes + storageMarginBytes) {
    throw new SnapshotError(`Insufficient storage for backup: about ${bytes} bytes needed, ${available} bytes available. No backup was created.`);
  }
}

/** FileHandle.write may write fewer bytes than requested; never accept a short write. */
async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    if (bytesWritten <= 0) throw new SnapshotError("Could not write backup data.");
    offset += bytesWritten;
  }
}

function concurrentChange(): SnapshotError {
  return new SnapshotError("The worktree changed while it was being backed up; no backup was created. Stop editing the worktree and retry.");
}

function storageFailure(error: unknown): SnapshotError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return new SnapshotError("Backup storage ran out of space; no backup was created.");
  return new SnapshotError("Could not write backup storage; check Git directory permissions and free space. No backup was created.");
}

/** Copy file bytes into numbered private blobs, hashing exactly what was read. */
export async function copySnapshot(root: string, listing: SnapshotListing, storage: string): Promise<ManifestEntry[]> {
  const manifest: ManifestEntry[] = [];
  let counter = 0;
  for (const [path, entry] of listing) {
    if (entry.type === "directory") { manifest.push({ path, type: "directory", mode: entry.mode }); continue; }
    if (entry.type === "symlink") { manifest.push({ path, type: "symlink", target: entry.target! }); continue; }
    const blob = String(++counter).padStart(6, "0");
    let source;
    // Nonblocking so a regular file swapped for a FIFO cannot hang the open.
    try { source = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") throw new SnapshotError("A worktree file cannot be read; check file permissions. No backup was created.");
      throw concurrentChange();
    }
    try {
      const opened = await source.stat({ bigint: true });
      if (!opened.isFile() || !sameObservation(entry, observe(opened, "file"))) throw concurrentChange();
      let destination;
      try { destination = await open(join(storage, blob), "wx", 0o600); }
      catch (error) { throw storageFailure(error); }
      const hash = createHash("sha256");
      let copied = 0;
      try {
        const buffer = Buffer.allocUnsafe(chunkBytes);
        // Read at most one byte past the observed size so a growing file cannot exhaust storage.
        const limit = Number(entry.size) + 1;
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, Math.min(chunkBytes, limit - copied), null);
          if (bytesRead === 0) break;
          copied += bytesRead;
          if (copied > Number(entry.size)) throw concurrentChange();
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          try { await writeAll(destination, chunk); }
          catch (error) { throw error instanceof SnapshotError ? error : storageFailure(error); }
        }
        try { await destination.sync(); }
        catch (error) { throw storageFailure(error); }
      } finally { await destination.close().catch(() => {}); }
      if (BigInt(copied) !== entry.size || !sameObservation(entry, observe(await source.stat({ bigint: true }), "file"))) {
        throw concurrentChange();
      }
      manifest.push({ path, type: "file", mode: entry.mode, size: copied, sha256: hash.digest("hex"), blob });
    } finally { await source.close().catch(() => {}); }
  }
  return manifest;
}

async function digestBlob(path: string): Promise<{ size: number; sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    let size = 0;
    const buffer = Buffer.allocUnsafe(chunkBytes);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { size, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

/** Every blob must be a private regular file whose bytes match the manifest. */
export async function verifyBlobs(storage: string, manifest: readonly ManifestEntry[]): Promise<void> {
  for (const entry of manifest) {
    if (entry.type !== "file") continue;
    const path = join(storage, entry.blob);
    try {
      const info = await lstat(path);
      if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("unsafe");
      const actual = await digestBlob(path);
      if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new Error("mismatch");
    } catch {
      throw new SnapshotError("Backup snapshot is incomplete or does not match its manifest; it cannot be used.");
    }
  }
}

/**
 * Recreate entries under a fresh destination. Directories come first, files are
 * created exclusively, and symlinks are created last so no write follows a link.
 */
export async function restoreSnapshot(destination: string, storage: string, manifest: readonly ManifestEntry[]): Promise<void> {
  for (const entry of manifest) {
    if (entry.type === "directory") await mkdir(join(destination, entry.path), { mode: 0o700 });
  }
  for (const entry of manifest) {
    if (entry.type !== "file") continue;
    const source = await open(join(storage, entry.blob), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const target = await open(join(destination, entry.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(chunkBytes);
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, chunkBytes, null);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(0, bytesRead));
          await writeAll(target, buffer.subarray(0, bytesRead));
        }
        if (hash.digest("hex") !== entry.sha256) throw new SnapshotError("Backup snapshot changed during restore.");
        await target.chmod(entry.mode);
        await target.sync();
      } finally { await target.close(); }
    } finally { await source.close(); }
  }
  for (const entry of manifest) {
    if (entry.type === "symlink") await symlink(entry.target, join(destination, entry.path));
  }
  const directories = manifest.filter(entry => entry.type === "directory").reverse();
  for (const entry of directories) await chmod(join(destination, entry.path), entry.mode);
}
