import { samePath } from "../platform/paths";
import { assertPrivateStorage, protectNewStorage } from "../platform/private-storage";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { execa } from "execa";
import { shellQuoteForDisplay } from "../display";
import type { RepositoryContext, Worktree } from "../types";
import { WorktreeReadPhase, type WorktreeMetadataLocation } from "./worktree-read-phase";

export type BaseAssociationRead =
  | { kind: "assigned"; ref: string }
  | { kind: "unassigned" }
  | { kind: "invalid"; reason: "malformed" | "stale" | "unreadable" };

interface Location extends WorktreeMetadataLocation { file: string }

const refPattern = /^refs\/(?:heads|remotes)\/.+/u;
const maxRecordBytes = 4096;

async function location(
  repository: RepositoryContext, worktree: Worktree, phase = new WorktreeReadPhase(repository),
): Promise<Location> {
  const place = await phase.metadataLocation(worktree);
  return { ...place, file: join(place.directory, "base.json") };
}

function validRecord(value: unknown): value is Record<string, unknown> & {
  version: 1; ref: string; worktreePath: string; commonGitDir: string; worktreeGitDir: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") ===
      "commonGitDir,ref,version,worktreeGitDir,worktreePath"
    && record.version === 1 && typeof record.ref === "string" && refPattern.test(record.ref)
    && typeof record.worktreePath === "string" && typeof record.commonGitDir === "string"
    && typeof record.worktreeGitDir === "string"
    && isAbsolute(record.worktreePath) && isAbsolute(record.commonGitDir) && isAbsolute(record.worktreeGitDir);
}

async function readAt(place: Location): Promise<BaseAssociationRead> {
  try {
    const directory = await lstat(place.directory);
    if (!directory.isDirectory()) return { kind: "invalid", reason: "malformed" };
    const stat = await lstat(place.file);
    if (!stat.isFile() || stat.size > maxRecordBytes) return { kind: "invalid", reason: "malformed" };
    if (process.platform === "win32") {
      await assertPrivateStorage(place.directory, directory, true);
      await assertPrivateStorage(place.file, stat, false);
    }
    const parsed: unknown = JSON.parse(await readFile(place.file, "utf8"));
    if (!validRecord(parsed) || !await validRef(place.worktreePath, parsed.ref)) return { kind: "invalid", reason: "malformed" };
    if (!samePath(parsed.worktreePath, place.worktreePath) || !samePath(parsed.commonGitDir, place.commonGitDir)
      || !samePath(parsed.worktreeGitDir, place.worktreeGitDir)) return { kind: "invalid", reason: "stale" };
    return { kind: "assigned", ref: parsed.ref };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { kind: "unassigned" };
    }
    if (error instanceof SyntaxError) return { kind: "invalid", reason: "malformed" };
    return { kind: "invalid", reason: "unreadable" };
  }
}

async function validRef(cwd: string, ref: string): Promise<boolean> {
  if (!refPattern.test(ref)) return false;
  const checked = await execa("git", ["check-ref-format", ref], {
    cwd, reject: false, stdin: "ignore", env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  return checked.exitCode === 0;
}

function assignmentRetry(path: string, ref: string): string {
  return `timber rebase --base ${shellQuoteForDisplay(ref)} -- ${shellQuoteForDisplay(path)}`;
}

/** Read only after checking Git's reciprocal worktree identity. */
export async function readBaseAssociation(
  repository: RepositoryContext, worktree: Worktree, phase?: WorktreeReadPhase,
): Promise<BaseAssociationRead> {
  try { return await readAt(await location(repository, worktree, phase)); }
  catch { return { kind: "invalid", reason: "stale" }; }
}

/** Publish only a canonical branch ref and worktree identity, never executable or prompt content. */
export async function writeBaseAssociation(
  repository: RepositoryContext, worktree: Worktree, ref: string,
): Promise<void> {
  if (!await validRef(worktree.path, ref)) throw new Error("Invalid base ref; no association saved.");
  let place: Location;
  try { place = await location(repository, worktree); }
  catch { throw new Error("Cannot verify this Git worktree; no base association saved."); }
  const previous = await readAt(place);
  if (previous.kind === "invalid" && previous.reason !== "stale") {
    throw new Error("Base metadata is malformed or unreadable; inspect the worktree's private Git metadata before assigning a base.");
  }
  const record = JSON.stringify({ version: 1, ref, worktreePath: place.worktreePath,
    commonGitDir: place.commonGitDir, worktreeGitDir: place.worktreeGitDir }) + "\n";
  if (Buffer.byteLength(record) > maxRecordBytes) {
    throw new Error("Base association is too large to save; use a shorter base ref or worktree path.");
  }
  try {
    await mkdir(place.directory, { mode: 0o700 });
    await protectNewStorage(place.directory);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
      throw new Error("Cannot create private base metadata; worktree retained. Check Git directory permissions.");
    }
  }
  const directoryInfo = await lstat(place.directory);
  if (!directoryInfo.isDirectory() || (process.platform !== "win32" && (directoryInfo.mode & 0o077) !== 0)) {
    throw new Error("Base metadata directory is unsafe; no association saved.");
  }
  await assertPrivateStorage(place.directory, directoryInfo, true);
  const temporary = join(place.directory, `.base-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await protectNewStorage(temporary);
      await file.writeFile(record);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, place.file);
  } catch {
    throw new Error(`Could not save the base association; the worktree was retained. Fix Git directory permissions, then retry with: ${assignmentRetry(worktree.path, ref)}`);
  } finally { await unlink(temporary).catch(() => {}); }
}
