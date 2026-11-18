import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { assertPrivateStorage, protectNewStorage } from "../platform/private-storage";

/** One small JSON record in a worktree's private Git metadata directory. */
export type PrivateRecordRead =
  | { kind: "missing" }
  | { kind: "found"; value: unknown }
  | { kind: "invalid"; reason: "malformed" | "unreadable" };

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Read without creating, following or repairing anything. */
export async function readPrivateRecord(directory: string, file: string, maxBytes: number): Promise<PrivateRecordRead> {
  try {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory()) return { kind: "invalid", reason: "malformed" };
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > maxBytes) return { kind: "invalid", reason: "malformed" };
    if (process.platform === "win32") {
      await assertPrivateStorage(directory, directoryInfo, true);
      await assertPrivateStorage(file, stat, false);
    }
    return { kind: "found", value: JSON.parse(await readFile(file, "utf8")) };
  } catch (error) {
    if (missing(error)) return { kind: "missing" };
    if (error instanceof SyntaxError) return { kind: "invalid", reason: "malformed" };
    return { kind: "invalid", reason: "unreadable" };
  }
}

/** Create the private directory if needed and refuse one that other users can reach. */
export async function preparePrivateDirectory(directory: string, label: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
    await protectNewStorage(directory);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
      throw new Error(`Cannot create private ${label} metadata; worktree retained. Check Git directory permissions.`);
    }
  }
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || (process.platform !== "win32" && (directoryInfo.mode & 0o077) !== 0)) {
    throw new Error(`${label[0]!.toUpperCase()}${label.slice(1)} metadata directory is unsafe; no association saved.`);
  }
  await assertPrivateStorage(directory, directoryInfo, true);
}

/** Atomically replace `file` with `content`; throws without a user-facing message. */
export async function replacePrivateFile(directory: string, file: string, prefix: string, content: string): Promise<void> {
  const temporary = join(directory, `.${prefix}-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await protectNewStorage(temporary);
      await handle.writeFile(content);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
