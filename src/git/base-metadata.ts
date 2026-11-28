import { samePath } from "../platform/paths";
import { unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { execa } from "execa";
import { shellQuoteForDisplay } from "../display";
import type { RepositoryContext, Worktree } from "../types";
import { WorktreeReadPhase, type WorktreeMetadataLocation } from "./worktree-read-phase";
import { preparePrivateDirectory, readPrivateRecord, replacePrivateFile } from "./private-record";
import { isFullCommitHash } from "./commit-base";
import { gitCommand } from "../platform/git-command";

export type BaseAssociationRead =
  | { kind: "assigned"; ref: string }
  | { kind: "commit"; commit: string }
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

type Identity = { version: 1; worktreePath: string; commonGitDir: string; worktreeGitDir: string };
type SavedRecord = Identity & ({ ref: string } | { commit: string });

const lowercaseHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** A branch record keeps `ref`; a commit record keeps a lowercase full `commit` hash instead. */
function validRecord(value: unknown): value is SavedRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  const target = keys === "commonGitDir,ref,version,worktreeGitDir,worktreePath"
    ? typeof record.ref === "string" && refPattern.test(record.ref)
    : keys === "commit,commonGitDir,version,worktreeGitDir,worktreePath"
      && typeof record.commit === "string" && lowercaseHash.test(record.commit);
  return target && record.version === 1
    && typeof record.worktreePath === "string" && typeof record.commonGitDir === "string"
    && typeof record.worktreeGitDir === "string"
    && isAbsolute(record.worktreePath) && isAbsolute(record.commonGitDir) && isAbsolute(record.worktreeGitDir);
}

async function readAt(place: Location): Promise<BaseAssociationRead> {
  const read = await readPrivateRecord(place.directory, place.file, maxRecordBytes);
  if (read.kind === "missing") return { kind: "unassigned" };
  if (read.kind === "invalid") return read;
  try {
    if (!validRecord(read.value)) return { kind: "invalid", reason: "malformed" };
    if ("ref" in read.value && !await validRef(place.worktreePath, read.value.ref)) return { kind: "invalid", reason: "malformed" };
  } catch { return { kind: "invalid", reason: "unreadable" }; }
  const record = read.value;
  if (!samePath(record.worktreePath, place.worktreePath) || !samePath(record.commonGitDir, place.commonGitDir)
    || !samePath(record.worktreeGitDir, place.worktreeGitDir)) return { kind: "invalid", reason: "stale" };
  return "commit" in record ? { kind: "commit", commit: record.commit } : { kind: "assigned", ref: record.ref };
}

async function validRef(cwd: string, ref: string): Promise<boolean> {
  if (!refPattern.test(ref)) return false;
  const checked = await execa(gitCommand(), ["check-ref-format", ref], {
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

/**
 * Publish only a canonical branch ref or a full commit hash and the worktree identity, never
 * executable or prompt content. Callers verify that a commit exists; this checks only its form.
 */
export async function writeBaseAssociation(
  repository: RepositoryContext, worktree: Worktree, ref: string,
): Promise<void> {
  const commit = isFullCommitHash(ref) ? ref.toLowerCase() : null;
  if (commit === null && !await validRef(worktree.path, ref)) throw new Error("Invalid base ref; no association saved.");
  let place: Location;
  try { place = await location(repository, worktree); }
  catch { throw new Error("Cannot verify this Git worktree; no base association saved."); }
  const previous = await readAt(place);
  if (previous.kind === "invalid" && previous.reason !== "stale") {
    throw new Error("Base metadata is malformed or unreadable; inspect the worktree's private Git metadata before assigning a base.");
  }
  const record = JSON.stringify({ version: 1, ...(commit === null ? { ref } : { commit }), worktreePath: place.worktreePath,
    commonGitDir: place.commonGitDir, worktreeGitDir: place.worktreeGitDir }) + "\n";
  if (Buffer.byteLength(record) > maxRecordBytes) {
    throw new Error("Base association is too large to save; use a shorter base ref or worktree path.");
  }
  await preparePrivateDirectory(place.directory, "base");
  try {
    await replacePrivateFile(place.directory, place.file, "base", record);
  } catch {
    throw new Error(`Could not save the base association; the worktree was retained. Fix Git directory permissions, then retry with: ${assignmentRetry(worktree.path, ref)}`);
  }
}

/** Remove only the saved base record; a stale record may be cleared, a damaged one must be repaired first. */
export async function clearBaseAssociation(repository: RepositoryContext, worktree: Worktree): Promise<void> {
  let place: Location;
  try { place = await location(repository, worktree); }
  catch { throw new Error("Cannot verify this Git worktree; the base association was not cleared."); }
  const previous = await readAt(place);
  if (previous.kind === "unassigned") return;
  if (previous.kind === "invalid" && previous.reason !== "stale") {
    throw new Error("Base metadata is malformed or unreadable; inspect the worktree's private Git metadata before clearing the base.");
  }
  try { await unlink(place.file); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw new Error("Could not clear the base association; fix Git directory permissions, then retry.");
  }
}
