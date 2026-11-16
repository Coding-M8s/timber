import { samePath } from "../platform/paths";
import { privateDirectory } from "../platform/private-storage";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { loadConfigScopes, parseConfigSource } from "../config";
import { discoverRepository } from "../git/repository";
import type { RepositoryContext } from "../types";
import { SetupCancelled, SetupChangedError, SetupVisibilityError } from "./types";
import type { FileSnapshot, SetupTarget } from "./types";

const pattern = "/.timber.toml";

async function git(repository: RepositoryContext, args: readonly string[], allowNotFound = false): Promise<string> {
  const result = await execa("git", [...args], {
    cwd: repository.primaryWorktreeRoot, env: { GIT_OPTIONAL_LOCKS: "0" }, reject: false,
  });
  if (result.exitCode !== 0 && !(allowNotFound && result.exitCode === 1)) {
    throw new Error("Cannot read setup metadata from Git; no settings saved.");
  }
  return result.stdout;
}

async function trackedConfig(repository: RepositoryContext): Promise<boolean> {
  return (await git(repository, ["ls-files", "-z", "--", ".timber.toml"])).length > 0;
}

export async function snapshotFile(path: string): Promise<FileSnapshot> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink setup destination ${path}. Edit its target directly or use a regular config file.`);
    if (!info.isFile()) throw new Error(`Setup destination is not a regular file: ${path}`);
    return { path, source: await readFile(path), mode: info.mode & 0o777 };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { path, source: null, mode: 0o600 };
    throw error;
  }
}

export async function inspectSetupTarget(global: boolean, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<SetupTarget> {
  let repository: RepositoryContext | null = null;
  if (!global) {
    try { repository = await discoverRepository(cwd); }
    catch { throw new Error("Run timber setup inside a Git repository, or timber setup --global to configure machine defaults."); }
  }
  const scopes = await loadConfigScopes(repository?.primaryWorktreeRoot, env);
  const file = global ? scopes.global : scopes.local!;
  await snapshotFile(file.path); // Refuse links/directories before asking for changes.
  let exclude: FileSnapshot | null = null;
  if (repository) {
    const path = await git(repository, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
    exclude = await snapshotFile(path);
  }
  const branches = repository
    ? (await git(repository, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split("\n").filter(Boolean)
    : [];
  return {
    scope: global ? "global" : "repository", path: file.path, file, scopes, repository,
    branches, tracked: repository ? await trackedConfig(repository) : false, exclude,
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null || right === null ? left === right : left.equals(right);
}

async function assertUnchanged(snapshot: FileSnapshot): Promise<void> {
  const current = await snapshotFile(snapshot.path);
  if (!sameBytes(current.source, snapshot.source) || current.mode !== snapshot.mode) {
    throw new SetupChangedError(`Setup destination changed while answering questions: ${snapshot.path}. Rerun setup; existing work was preserved.`);
  }
}

function exclusionBytes(source: Buffer | null): Buffer {
  if (source?.toString("utf8").split(/\r?\n/u).includes(pattern)) return source;
  return Buffer.concat([source ?? Buffer.alloc(0),
    Buffer.from(`${source?.length && source[source.length - 1] !== 10 ? "\n" : ""}${pattern}\n`)]);
}

async function prepare(path: string, source: Buffer, mode: number): Promise<string> {
  const temporary = join(dirname(path), `.timber-setup-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", mode);
  try {
    if (process.platform !== "win32") await file.chmod(mode);
    await file.writeFile(source);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await file.close();
  return temporary;
}

export type PublicationFiles = Partial<Pick<typeof import("node:fs/promises"), "link" | "rename">>;

/** Validated publication; locks coordinate Timber writers, not unrelated editors. */
export async function saveSetupConfig(target: SetupTarget, source: string, trackedApproved: boolean,
  signal?: AbortSignal, files: PublicationFiles = {}): Promise<void> {
  parseConfigSource(source, target.path);
  if (target.tracked && !trackedApproved) throw new Error("This config is tracked. Explicitly choose editing it, global setup, or cancellation.");
  const checkCancellation = () => { if (signal?.aborted) throw new SetupCancelled(); };
  checkCancellation();
  const locks: { path: string; handle: Awaited<ReturnType<typeof open>> }[] = [];
  const temporaries = new Set<string>();
  const publishRename = files.rename ?? rename;
  const publishLink = files.link ?? link;
  let excludeWritten: Buffer | null = null;
  let published = false;
  try {
    if (process.platform === "win32" && target.scope === "global") {
      await mkdir(dirname(dirname(target.path)), { recursive: true });
      await privateDirectory(dirname(target.path));
    }
    await mkdir(dirname(target.path), { recursive: true, mode: 0o700 });
    const lockPaths = [target.repository ? join(target.repository.commonGitDir, "timber-setup.lock") : `${target.path}.lock`,
      ...(target.exclude ? [`${target.exclude.path}.timber-setup.lock`] : [])];
    for (const path of lockPaths) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try { locks.push({ path, handle: await open(path, "wx", 0o600) }); }
      catch { throw new Error(`Setup is locked at ${path}. Finish the other setup; if it crashed, remove its stale lock and rerun.`); }
    }
    checkCancellation();
    const original = await snapshotFile(target.path);
    if (!sameBytes(original.source, target.file.source === null ? null : Buffer.from(target.file.source))) {
      throw new SetupChangedError(`Config changed while answering questions: ${target.path}. Rerun setup; existing work was preserved.`);
    }
    if (target.repository) {
      const common = await git(target.repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (!samePath(common, target.repository.commonGitDir) || await trackedConfig(target.repository) !== target.tracked) {
        throw new SetupChangedError("Repository or tracked configuration changed during setup. Rerun setup; no settings saved.");
      }
    }
    if (target.exclude) await assertUnchanged(target.exclude);
    const configTemporary = await prepare(target.path, Buffer.from(source), original.mode);
    temporaries.add(configTemporary);
    if (target.exclude) {
      const next = exclusionBytes(target.exclude.source);
      if (!sameBytes(next, target.exclude.source)) {
        const temporary = await prepare(target.exclude.path, next, target.exclude.mode);
        temporaries.add(temporary);
        checkCancellation();
        await assertUnchanged(target.exclude);
        if (target.exclude.source === null) await publishLink(temporary, target.exclude.path);
        else await publishRename(temporary, target.exclude.path);
        excludeWritten = next;
      }
      if (!target.tracked) {
        const ignored = await execa("git", ["check-ignore", "--quiet", "--no-index", "--", ".timber.toml"], {
          cwd: target.repository!.primaryWorktreeRoot, reject: false, env: { GIT_OPTIONAL_LOCKS: "0" },
        });
        if (ignored.exitCode !== 0) throw new SetupVisibilityError("Repository ignore rules cannot hide .timber.toml. Use timber setup --global or cancel; shared ignore rules were preserved.");
      }
    }
    checkCancellation();
    await assertUnchanged(original);
    if (target.repository && await trackedConfig(target.repository) !== target.tracked) {
      throw new SetupChangedError("Tracked configuration changed during setup. Rerun setup; no settings saved.");
    }
    checkCancellation();
    if (original.source === null) await publishLink(configTemporary, target.path);
    else await publishRename(configTemporary, target.path);
    published = true; // Commit point: a later signal cannot turn this into cancellation.
  } catch (error) {
    let rollbackFailed = false;
    if (!published && excludeWritten !== null && target.exclude) {
      try {
        const current = await snapshotFile(target.exclude.path);
        if (!sameBytes(current.source, excludeWritten) || current.mode !== target.exclude.mode) rollbackFailed = true;
        else if (target.exclude.source === null) await unlink(target.exclude.path);
        else {
          const restore = await prepare(target.exclude.path, target.exclude.source, target.exclude.mode);
          temporaries.add(restore);
          await assertUnchanged(current);
          await rename(restore, target.exclude.path);
        }
      } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw new Error(`Could not save config at ${target.path}; exclusion rollback was incomplete. Concurrent edits were preserved. Inspect the Git-local exclusion file and rerun setup.`);
    if (!published && signal?.aborted) throw new SetupCancelled();
    if (error instanceof SetupCancelled || error instanceof SetupVisibilityError) throw error;
    const known = error instanceof Error && /^(Config changed|Setup destination changed|Repository or tracked|Tracked configuration changed|Setup is locked|Refusing symlink|Setup destination is not)/u.test(error.message);
    if (known) throw error;
    throw new Error(`Could not save config at ${target.path} (${errorCode(error) ?? "write failed"}). Original settings were preserved; check directory permissions and rerun setup.`);
  } finally {
    for (const path of temporaries) await unlink(path).catch(() => {});
    for (const lock of locks.reverse()) {
      await lock.handle.close().catch(() => {});
      await unlink(lock.path).catch(() => {});
    }
  }
}
