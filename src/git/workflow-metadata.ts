import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { retryForDisplay } from "../display";
import type { RepositoryContext, Worktree } from "../types";
import { assertWorktreeIdentity } from "./worktrees";

export type WorkflowAssociationRead =
  | { kind: "assigned"; name: string }
  | { kind: "unassigned" }
  | { kind: "invalid"; reason: "malformed" | "stale" | "unreadable" };

interface Location {
  file: string;
  directory: string;
  worktreePath: string;
  commonGitDir: string;
  worktreeGitDir: string;
}

const namePattern = /^[a-z][a-z0-9_-]*$/u;
const maxRecordBytes = 4096;

async function location(repository: RepositoryContext, worktree: Worktree): Promise<Location> {
  await assertWorktreeIdentity(repository, worktree);
  const result = await execa("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: worktree.path, reject: false, env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.exitCode !== 0) throw new Error("Cannot identify the worktree's private Git directory.");
  const worktreeGitDir = await realpath(result.stdout);
  const directory = join(worktreeGitDir, "timber");
  return {
    file: join(directory, "workflow.json"), directory,
    worktreePath: resolve(worktree.path),
    commonGitDir: await realpath(repository.commonGitDir), worktreeGitDir,
  };
}

function validRecord(value: unknown): value is Record<string, unknown> & {
  version: 1; name: string; worktreePath: string; commonGitDir: string; worktreeGitDir: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") ===
      "commonGitDir,name,version,worktreeGitDir,worktreePath"
    && record.version === 1 && typeof record.name === "string" && namePattern.test(record.name)
    && typeof record.worktreePath === "string" && typeof record.commonGitDir === "string"
    && typeof record.worktreeGitDir === "string";
}

async function readAt(place: Location): Promise<WorkflowAssociationRead> {
  try {
    const directory = await lstat(place.directory);
    if (!directory.isDirectory()) return { kind: "invalid", reason: "malformed" };
    const stat = await lstat(place.file);
    if (!stat.isFile() || stat.size > maxRecordBytes) return { kind: "invalid", reason: "malformed" };
    const parsed: unknown = JSON.parse(await readFile(place.file, "utf8"));
    if (!validRecord(parsed)) return { kind: "invalid", reason: "malformed" };
    if (parsed.worktreePath !== place.worktreePath || parsed.commonGitDir !== place.commonGitDir
      || parsed.worktreeGitDir !== place.worktreeGitDir) return { kind: "invalid", reason: "stale" };
    return { kind: "assigned", name: parsed.name };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { kind: "unassigned" };
    }
    if (error instanceof SyntaxError) return { kind: "invalid", reason: "malformed" };
    return { kind: "invalid", reason: "unreadable" };
  }
}

function assignmentRetry(path: string, name: string): string {
  const quoted = "'" + path.replaceAll("'", "'\\''") + "'";
  return retryForDisplay(path, `timber open --workflow ${name} -- ${quoted}`, `--workflow ${name}`);
}

/** Read only after checking Git's reciprocal worktree identity. */
export async function readWorkflowAssociation(
  repository: RepositoryContext, worktree: Worktree,
): Promise<WorkflowAssociationRead> {
  try { return await readAt(await location(repository, worktree)); }
  catch { return { kind: "invalid", reason: "stale" }; }
}

/** Publish only a name and worktree identity, never executable or prompt content. */
export async function writeWorkflowAssociation(
  repository: RepositoryContext, worktree: Worktree, name: string,
): Promise<void> {
  if (!namePattern.test(name)) throw new Error("Invalid workflow name; no association saved.");
  let place: Location;
  try { place = await location(repository, worktree); }
  catch { throw new Error("Cannot verify this Git worktree; no workflow association saved."); }
  const previous = await readAt(place);
  if (previous.kind === "invalid" && previous.reason !== "stale") {
    throw new Error("Workflow metadata is malformed or unreadable; inspect the worktree's private Git metadata before assigning a workflow.");
  }
  const record = JSON.stringify({ version: 1, name, worktreePath: place.worktreePath,
    commonGitDir: place.commonGitDir, worktreeGitDir: place.worktreeGitDir }) + "\n";
  if (Buffer.byteLength(record) > maxRecordBytes) {
    throw new Error("Workflow association is too large to save; use a shorter workflow name or worktree path.");
  }
  try {
    await mkdir(place.directory, { mode: 0o700 });
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
      throw new Error("Cannot create private workflow metadata; worktree retained. Check Git directory permissions.");
    }
  }
  const directoryInfo = await lstat(place.directory);
  if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) {
    throw new Error("Workflow metadata directory is unsafe; no association saved.");
  }
  const temporary = join(place.directory, `.workflow-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(record);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, place.file);
  } catch {
    throw new Error(`Could not save the workflow association; the worktree was retained. Fix Git directory permissions, then retry with: ${assignmentRetry(worktree.path, name)}`);
  } finally { await unlink(temporary).catch(() => {}); }
}
