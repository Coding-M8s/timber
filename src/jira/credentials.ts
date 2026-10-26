import { assertPrivateStorage, protectNewStorage, privateDirectory } from "../platform/private-storage";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { globalConfigPath } from "../config-paths";
import { configFileSchema } from "../config";
import type { JiraConfig } from "../types";
import { SetupCancelled } from "../setup/types";

export interface JiraCredentials { email: string; token: string }
const pairSchema = z.object({
  email: z.string().regex(/^[^\s:@]+@[^\s:@]+$/u),
  token: z.string().min(1).refine(value => value.trim().length > 0 && !/[\u0000-\u0020\u007f-\u009f]/u.test(value)),
});
const recordSchema = pairSchema.extend({ siteUrl: z.string(), cloudId: z.string().optional() }).strict();
const storeSchema = z.object({ version: z.literal(1), records: z.array(recordSchema) }).strict();
type CredentialRecord = z.infer<typeof recordSchema>;

export function validCredentials(pair: JiraCredentials): boolean { return pairSchema.safeParse(pair).success; }

function normalized(config: { siteUrl: string; cloudId?: string | undefined }): JiraConfig {
  const parsed = configFileSchema.shape.jira.safeParse({ site_url: config.siteUrl,
    ...(config.cloudId === undefined ? {} : { cloud_id: config.cloudId }) });
  if (!parsed.success || !parsed.data) throw new Error("Invalid Jira configuration; check site URL and cloud ID.");
  return { siteUrl: parsed.data.site_url,
    ...(parsed.data.cloud_id === undefined ? {} : { cloudId: parsed.data.cloud_id.toLowerCase() }) };
}

export function credentialIdentity(config: JiraConfig): string {
  const value = normalized(config);
  return `${value.siteUrl}|${value.cloudId ?? "unscoped"}`;
}

export interface CredentialStore {
  readonly path: string;
  readonly original: string | null;
  get(config: JiraConfig): JiraCredentials | null;
  set(config: JiraConfig, pair: JiraCredentials | null): void;
  changes(): readonly { config: JiraConfig; action: "save" | "remove" }[];
  serialize(): string;
}

const code = (error: unknown): unknown => typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
const storeError = () => new Error("Cannot read Jira credential store. Check its format, ownership and permissions; repair it privately or restore a backup, then rerun setup. Never include its contents in reports.");
async function checkOwner(path: string, info: Stats, mode?: number): Promise<void> {
  if (process.platform === "win32") { await assertPrivateStorage(path, info, info.isDirectory()); return; }
  if (info.uid !== process.getuid!() || (mode === undefined ? (info.mode & 0o022) !== 0 : (info.mode & 0o777) !== mode)) {
    throw new Error("Unsafe Jira credential store ownership or permissions. Use your own regular 0600 file and a private 0700 credentials directory, then rerun setup.");
  }
}

/** Resolve existing ancestors too: an XDG path inside a worktree/.git is never a secret store. */
async function assertOutsideGit(path: string): Promise<void> {
  let ancestor = dirname(path);
  while (true) {
    try { await lstat(ancestor); break; }
    catch (error) { if (code(error) !== "ENOENT") throw storeError(); }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw storeError();
    ancestor = parent;
  }
  try {
    const result = await execa("git", ["rev-parse", "--is-inside-work-tree", "--is-inside-git-dir"], {
      cwd: await realpath(ancestor), reject: false,
      env: { GIT_OPTIONAL_LOCKS: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined,
        GIT_CEILING_DIRECTORIES: undefined, GIT_DISCOVERY_ACROSS_FILESYSTEM: "1", LC_ALL: "C" },
    });
    if (result.stdout.split("\n").includes("true")) throw new Error("Jira credentials must be stored outside all Git worktrees and Git administrative directories. Change XDG_CONFIG_HOME to a private user configuration directory and rerun setup.");
    const notRepository = result.exitCode === 128
      && result.stderr.trim() === "fatal: not a git repository (or any of the parent directories): .git";
    if (result.exitCode !== 0 && !notRepository) {
      throw new Error("Jira credentials must be stored outside Git; Git could not verify this location. Check Git discovery/safety settings or choose another private XDG_CONFIG_HOME and rerun setup.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Jira credentials must")) throw error;
    throw storeError();
  }
}

async function safePath(path: string): Promise<void> {
  await assertOutsideGit(path);
  for (const [directory, privateMode] of [[dirname(dirname(path)), undefined], [dirname(path), 0o700]] as const) {
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Jira credential directory must be a regular directory, never a symlink.");
      await checkOwner(directory, info, privateMode);
    } catch (error) { if (code(error) !== "ENOENT") throw error; }
  }
}

async function readSource(path: string): Promise<string | null> {
  await safePath(path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Jira credential store must be a regular file, never a symlink or hard link.");
    await checkOwner(path, info, 0o600);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev) throw storeError();
    return await handle.readFile("utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    if (error instanceof Error && /^(Unsafe Jira|Jira credential|Cannot read Jira)/u.test(error.message)) throw error;
    throw storeError();
  } finally { await handle?.close(); }
}

export async function readCredentialStore(env: NodeJS.ProcessEnv = process.env): Promise<CredentialStore> {
  const path = join(dirname(globalConfigPath(env)), "credentials/jira.json");
  const original = await readSource(path);
  const records = new Map<string, CredentialRecord>();
  if (original !== null) {
    try {
      const parsed = storeSchema.parse(JSON.parse(original));
      for (const record of parsed.records) {
        const config = normalized(record);
        const key = credentialIdentity(config);
        if (records.has(key)) throw storeError();
        records.set(key, { ...config, email: record.email, token: record.token });
      }
    } catch { throw storeError(); }
  }
  const initial = new Map(records);
  return {
    path, original,
    get(config) { const record = records.get(credentialIdentity(config)); return record ? { email: record.email, token: record.token } : null; },
    set(config, pair) {
      const identity = credentialIdentity(config);
      if (pair === null) records.delete(identity);
      else {
        if (!validCredentials(pair)) throw new Error("Enter a valid Atlassian email and a nonblank API token without whitespace or control characters.");
        records.set(identity, { ...normalized(config), ...pair });
      }
    },
    changes() {
      return [...new Set([...initial.keys(), ...records.keys()])].flatMap(key => {
        const before = initial.get(key); const after = records.get(key);
        return JSON.stringify(before) === JSON.stringify(after) ? [] : [{
          config: normalized((after ?? before)!), action: after ? "save" as const : "remove" as const,
        }];
      });
    },
    serialize() { return JSON.stringify({ version: 1, records: [...records.values()] }, null, 2) + "\n"; },
  };
}

export async function loadSavedCredentials(config: JiraConfig, env: NodeJS.ProcessEnv = process.env): Promise<JiraCredentials | null> {
  return (await readCredentialStore(env)).get(config);
}

async function temporary(path: string, source: string): Promise<string> {
  const pathName = join(dirname(path), `.jira-${randomUUID()}.tmp`);
  const handle = await open(pathName, "wx", 0o600);
  try { await protectNewStorage(pathName); if (process.platform !== "win32") await handle.chmod(0o600); await handle.writeFile(source); await handle.sync(); }
  catch { await unlink(pathName).catch(() => {}); throw storeError(); }
  finally { await handle.close(); }
  return pathName;
}

function emptyRecords(source: string): boolean {
  const parsed = JSON.parse(source) as { records?: unknown };
  return Array.isArray(parsed.records) && parsed.records.length === 0;
}

/** Credentials publish first; config's successful publication is the shared commit point. */
export async function withCredentialSave(store: CredentialStore, publishConfig: () => Promise<void>, signal?: AbortSignal,
  files: Partial<Pick<typeof import("node:fs/promises"), "link">> = {}): Promise<void> {
  const cancel = () => { if (signal?.aborted) throw new SetupCancelled(); };
  cancel();
  if (!store.changes().length) { await publishConfig(); return; }
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  const lockPath = join(dirname(store.path), ".jira.lock");
  const temps = new Set<string>();
  let published = false;
  let deleted = false;
  const next = store.serialize();
  const emptied = emptyRecords(next);
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
    catch { throw new Error("Jira credential store is locked. Finish the other setup; after a crash, inspect private storage and remove the stale .jira.lock before rerunning setup."); }
    cancel();
    if (await readSource(store.path) !== store.original) throw new Error("Jira credential store changed during setup. Existing credentials were preserved; rerun setup.");
    if (emptied) {
      if (store.original === null) throw storeError();
      await unlink(store.path);
      deleted = true;
    } else {
      const staged = await temporary(store.path, next); temps.add(staged);
      cancel();
      if (await readSource(store.path) !== store.original) throw new Error("Jira credential store changed during setup. Existing credentials were preserved; rerun setup.");
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
      } catch { throw new Error("Jira credential rollback was incomplete. Concurrent changes were preserved. Inspect the private credential store and configuration, restore a private backup if needed, then rerun setup; never share store contents."); }
    }
    if (error instanceof SetupCancelled) throw error;
    if (published && error instanceof Error) throw error;
    if (error instanceof Error && !code(error)) throw error;
    throw new Error("Could not save Jira credentials. Previous settings and credentials were preserved; check private-directory permissions and rerun setup.");
  } finally {
    for (const path of temps) await unlink(path).catch(() => {});
    if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}); }
  }
}
