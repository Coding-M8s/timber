import { assertPrivateStorage, protectNewStorage, privateDirectory } from "./private-storage";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { globalConfigPath } from "../config-paths";
import { gitLocation } from "./git-location";
import { SetupCancelled, SetupChangedError } from "../setup/types";

/** One private personal credential file holding a single saved value, such as a key or a login pair. */
export interface SingleCredentialStore<T> {
  readonly path: string;
  readonly original: string | null;
  get(): T | null;
  set(value: T | null): void;
  changes(): readonly { action: "save" | "remove" }[];
  serialize(): string;
}

/** What differs between stores: the file, the wording, and how the value is checked and written. */
export interface CredentialFileSpec<T> {
  /** File base name under credentials/, such as "linear" for linear.json. */
  name: string;
  /** Provider name used in every diagnostic, such as "Linear". */
  label: string;
  /** Parse the stored JSON value; throws when it is not a valid version 1 record. */
  parse(value: unknown): T;
  /** The version 1 record for a value, or for no value. */
  record(value: T | null): Record<string, unknown>;
  /** Throws a fixed message when a draft value is not valid. */
  check(value: T): void;
}

const code = (error: unknown): unknown => typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

export function credentialFile<T>(spec: CredentialFileSpec<T>) {
  const { label } = spec;
  const storeError = () => new Error(`Cannot read ${label} credential store. Check its format, ownership and permissions; repair it privately or restore a backup, then rerun setup. Never include its contents in reports.`);
  const own = new RegExp(`^(Unsafe ${label}|${label} credential|Cannot read ${label})`, "u");

  async function checkOwner(path: string, info: Stats, mode?: number): Promise<void> {
    if (process.platform === "win32") { await assertPrivateStorage(path, info, info.isDirectory()); return; }
    if (info.uid !== process.getuid!() || (mode === undefined ? (info.mode & 0o022) !== 0 : (info.mode & 0o777) !== mode)) {
      throw new Error(`Unsafe ${label} credential store ownership or permissions. Use your own regular 0600 file and a private 0700 credentials directory, then rerun setup.`);
    }
  }

  /** Resolve existing ancestors too: an XDG path inside a worktree/.git is never a secret store. */
  async function assertOutsideGit(path: string, signal?: AbortSignal): Promise<void> {
    let location;
    try { location = await gitLocation(path, signal); }
    catch { signal?.throwIfAborted(); throw storeError(); }
    if (location === "inside") throw new Error(`${label} credentials must be stored outside all Git worktrees and Git administrative directories. Change XDG_CONFIG_HOME to a private user configuration directory and rerun setup.`);
    if (location === "unverified") {
      throw new Error(`${label} credentials must be stored outside Git; Git could not verify this location. Check Git discovery/safety settings or choose another private XDG_CONFIG_HOME and rerun setup.`);
    }
  }

  async function safePath(path: string, signal?: AbortSignal): Promise<void> {
    await assertOutsideGit(path, signal);
    signal?.throwIfAborted();
    for (const [directory, privateMode] of [[dirname(dirname(path)), undefined], [dirname(path), 0o700]] as const) {
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} credential directory must be a regular directory, never a symlink.`);
        await checkOwner(directory, info, privateMode);
      } catch (error) { if (code(error) !== "ENOENT") throw error; }
    }
  }

  async function readSource(path: string, signal?: AbortSignal): Promise<string | null> {
    await safePath(path, signal);
    signal?.throwIfAborted();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`${label} credential store must be a regular file, never a symlink or hard link.`);
      await checkOwner(path, info, 0o600);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (opened.ino !== info.ino || opened.dev !== info.dev) throw storeError();
      return await handle.readFile({ encoding: "utf8", ...(signal ? { signal } : {}) });
    } catch (error) {
      if (code(error) === "ENOENT") return null;
      if (error instanceof Error && own.test(error.message)) throw error;
      throw storeError();
    } finally { await handle?.close(); }
  }

  const serialize = (value: T | null) => JSON.stringify({ version: 1, ...spec.record(value) }, null, 2) + "\n";

  async function read(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<SingleCredentialStore<T>> {
    const path = join(dirname(globalConfigPath(env)), `credentials/${spec.name}.json`);
    const original = await readSource(path, signal);
    signal?.throwIfAborted();
    let initial: T | null = null;
    if (original !== null) {
      try { initial = spec.parse(JSON.parse(original)); }
      catch { throw storeError(); }
    }
    let value = initial;
    return {
      path, original,
      get() { return value; },
      set(next) {
        if (next !== null) spec.check(next);
        value = next;
      },
      changes() {
        if (serialize(value) === serialize(initial)) return [];
        return [{ action: value === null ? "remove" : "save" }];
      },
      serialize() { return serialize(value); },
    };
  }

  async function temporary(path: string, source: string): Promise<string> {
    const pathName = join(dirname(path), `.${spec.name}-${randomUUID()}.tmp`);
    const handle = await open(pathName, "wx", 0o600);
    try { await protectNewStorage(pathName); if (process.platform !== "win32") await handle.chmod(0o600); await handle.writeFile(source); await handle.sync(); }
    catch { await unlink(pathName).catch(() => {}); throw storeError(); }
    finally { await handle.close(); }
    return pathName;
  }

  /** Credentials publish first; config's successful publication is the shared commit point. */
  async function save(store: SingleCredentialStore<T>, publishConfig: () => Promise<void>, signal?: AbortSignal,
    files: Partial<Pick<typeof import("node:fs/promises"), "link">> = {}): Promise<void> {
    const cancel = () => { if (signal?.aborted) throw new SetupCancelled(); };
    cancel();
    if (!store.changes().length) { await publishConfig(); return; }
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    const lockPath = join(dirname(store.path), `.${spec.name}.lock`);
    const temps = new Set<string>();
    let published = false;
    let deleted = false;
    const next = store.serialize();
    const emptied = store.get() === null;
    const publishLink = files.link ?? link;
    try {
      if (process.platform === "win32") {
        await mkdir(dirname(dirname(dirname(store.path))), { recursive: true });
        await privateDirectory(dirname(dirname(store.path)));
        await privateDirectory(dirname(store.path));
      }
      await safePath(store.path);
      await mkdir(dirname(store.path), { recursive: true, mode: 0o700 });
      await safePath(store.path);
      try { lock = await open(lockPath, "wx", 0o600); }
      catch { throw new Error(`${label} credential store is locked. Finish the other setup; after a crash, inspect private storage and remove the stale .${spec.name}.lock before rerunning setup.`); }
      cancel();
      if (await readSource(store.path) !== store.original) throw new SetupChangedError(`${label} credential store changed during setup. Existing credentials were preserved; rerun setup.`);
      if (emptied) {
        if (store.original === null) throw storeError();
        await unlink(store.path);
        deleted = true;
      } else {
        const staged = await temporary(store.path, next); temps.add(staged);
        cancel();
        if (await readSource(store.path) !== store.original) throw new SetupChangedError(`${label} credential store changed during setup. Existing credentials were preserved; rerun setup.`);
        if (store.original === null) {
          // Publish complete bytes without replacing a name claimed by another writer.
          await publishLink(staged, store.path);
          published = true;
          await unlink(staged);
          temps.delete(staged);
        } else {
          await rename(staged, store.path);
        }
      }
      published = true;
      cancel();
      await publishConfig();
    } catch (error) {
      if (published) {
        try {
          // Drop an owned staging link before guarded reads if its first unlink failed.
          if (!deleted && store.original === null) {
            for (const path of temps) { await unlink(path); temps.delete(path); }
          }
          if (deleted) {
            if (await readSource(store.path) !== null) throw storeError();
            const restore = await temporary(store.path, store.original!); temps.add(restore);
            await publishLink(restore, store.path);
            await unlink(restore);
            temps.delete(restore);
          } else {
            if (await readSource(store.path) !== next) throw storeError();
            if (store.original === null) await unlink(store.path);
            else {
              const restore = await temporary(store.path, store.original); temps.add(restore);
              if (await readSource(store.path) !== next) throw storeError();
              await rename(restore, store.path);
            }
          }
        } catch { throw new Error(`${label} credential rollback was incomplete. Concurrent changes were preserved. Inspect the private credential store and configuration, restore a private backup if needed, then rerun setup; never share store contents.`); }
      }
      if (error instanceof SetupCancelled) throw error;
      if (published && error instanceof Error) throw error;
      if (error instanceof Error && !code(error)) throw error;
      throw new Error(`Could not save ${label} credentials. Previous settings and credentials were preserved; check private-directory permissions and rerun setup.`);
    } finally {
      for (const path of temps) await unlink(path).catch(() => {});
      if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}); }
    }
  }

  return { read, save };
}
