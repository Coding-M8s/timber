import { assertPrivateStorage, protectNewStorage, privateDirectory } from "../platform/private-storage";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { globalConfigPath } from "../config-paths";
import { gitLocation } from "../platform/git-location";
import { configFileSchema } from "../config";
import type { JiraConfig } from "../types";
import { SetupCancelled, SetupChangedError } from "../setup/types";
import { credentialLabelSchema, defaultCredentialLabel, repositoryKeySchema, selectCredential, validCredentialLabel } from "../credential-selection";
import type { CredentialSelection } from "../credential-selection";

export interface JiraCredentials { email: string; token: string }
const pairSchema = z.object({
  email: z.string().regex(/^[^\s:@]+@[^\s:@]+$/u),
  token: z.string().min(1).refine(value => value.trim().length > 0 && !/[\u0000-\u0020\u007f-\u009f]/u.test(value)),
});
const recordSchema = pairSchema.extend({ siteUrl: z.string(), cloudId: z.string().optional() }).strict();
const legacySchema = z.object({ version: z.literal(1), records: z.array(recordSchema) }).strict();
const storeSchema = z.object({
  version: z.literal(2),
  records: z.array(recordSchema.extend({ label: credentialLabelSchema }).strict()),
  associations: z.array(z.object({ repository: repositoryKeySchema, siteUrl: z.string(), cloudId: z.string().optional(),
    label: credentialLabelSchema }).strict()),
}).strict();
type CredentialRecord = JiraConfig & JiraCredentials & { label: string };
interface Association { config: JiraConfig; repository: string; label: string }

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

export type CredentialChange =
  | { kind: "entry"; config: JiraConfig; action: "save" | "remove"; label: string }
  | { kind: "association"; config: JiraConfig; repository: string; label: string | null };

/** Entries and associations are scoped to one normalized site and token mode. */
export interface CredentialStore {
  readonly path: string;
  readonly original: string | null;
  labels(config: JiraConfig): readonly string[];
  /** Without a label, the pair of a sole saved entry for this site and token mode. */
  get(config: JiraConfig, label?: string): JiraCredentials | null;
  /** Without a label, replaces the sole entry (or creates "default"). Removing an entry drops its associations. */
  set(config: JiraConfig, pair: JiraCredentials | null, label?: string): void;
  association(config: JiraConfig, repository: string): string | null;
  associate(config: JiraConfig, repository: string, label: string | null): void;
  users(config: JiraConfig, label: string): readonly string[];
  select(config: JiraConfig, repository: string | null): CredentialSelection;
  changes(): readonly CredentialChange[];
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
  let location;
  try { location = await gitLocation(path); }
  catch { throw storeError(); }
  if (location === "inside") throw new Error("Jira credentials must be stored outside all Git worktrees and Git administrative directories. Change XDG_CONFIG_HOME to a private user configuration directory and rerun setup.");
  if (location === "unverified") {
    throw new Error("Jira credentials must be stored outside Git; Git could not verify this location. Check Git discovery/safety settings or choose another private XDG_CONFIG_HOME and rerun setup.");
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

const entryKey = (identity: string, label: string) => `${identity}\n${label}`;
const associationKey = (identity: string, repository: string) => `${identity}\n${repository}`;

function parseStore(source: string): { records: Map<string, CredentialRecord>; associations: Map<string, Association> } {
  const input: unknown = JSON.parse(source);
  const legacy = legacySchema.safeParse(input);
  const parsed = legacy.success
    ? { records: legacy.data.records.map(record => ({ ...record, label: defaultCredentialLabel })), associations: [] }
    : storeSchema.parse(input);
  const records = new Map<string, CredentialRecord>();
  for (const record of parsed.records) {
    const config = normalized(record);
    const key = entryKey(credentialIdentity(config), record.label);
    if (records.has(key)) throw storeError();
    records.set(key, { ...config, email: record.email, token: record.token, label: record.label });
  }
  const associations = new Map<string, Association>();
  for (const association of parsed.associations) {
    const config = normalized(association);
    const identity = credentialIdentity(config);
    const key = associationKey(identity, association.repository);
    if (associations.has(key) || !records.has(entryKey(identity, association.label))) throw storeError();
    associations.set(key, { config, repository: association.repository, label: association.label });
  }
  return { records, associations };
}

const configOf = (record: CredentialRecord): JiraConfig => ({ siteUrl: record.siteUrl, ...(record.cloudId === undefined ? {} : { cloudId: record.cloudId }) });

export async function readCredentialStore(env: NodeJS.ProcessEnv = process.env): Promise<CredentialStore> {
  const path = join(dirname(globalConfigPath(env)), "credentials/jira.json");
  const original = await readSource(path);
  let state: ReturnType<typeof parseStore> = { records: new Map(), associations: new Map() };
  if (original !== null) {
    try { state = parseStore(original); }
    catch { throw storeError(); }
  }
  const { records, associations } = state;
  const initialRecords = new Map(records);
  const initialAssociations = new Map(associations);
  const labels = (config: JiraConfig) => {
    const identity = credentialIdentity(config);
    return [...records.values()].filter(record => credentialIdentity(record) === identity).map(record => record.label);
  };
  const sole = (config: JiraConfig) => { const names = labels(config); return names.length === 1 ? names[0]! : null; };
  return {
    path, original, labels,
    get(config, label) {
      const name = label ?? sole(config);
      const record = name === null ? undefined : records.get(entryKey(credentialIdentity(config), name));
      return record ? { email: record.email, token: record.token } : null;
    },
    set(config, pair, label) {
      const identity = credentialIdentity(config);
      const name = label ?? sole(config) ?? defaultCredentialLabel;
      if (!validCredentialLabel(name)) throw new Error("Invalid Jira credential label.");
      if (pair === null) {
        records.delete(entryKey(identity, name));
        for (const [key, association] of associations) {
          if (credentialIdentity(association.config) === identity && association.label === name) associations.delete(key);
        }
        return;
      }
      if (!validCredentials(pair)) throw new Error("Enter a valid Atlassian email and a nonblank API token without whitespace or control characters.");
      records.set(entryKey(identity, name), { ...normalized(config), ...pair, label: name });
    },
    association(config, repository) { return associations.get(associationKey(credentialIdentity(config), repository))?.label ?? null; },
    associate(config, repository, label) {
      const identity = credentialIdentity(config);
      if (label === null) { associations.delete(associationKey(identity, repository)); return; }
      if (!records.has(entryKey(identity, label))) throw new Error("Cannot associate an unsaved Jira credential.");
      associations.set(associationKey(identity, repository), { config: normalized(config), repository, label });
    },
    users(config, label) {
      const identity = credentialIdentity(config);
      return [...associations.values()].filter(association => credentialIdentity(association.config) === identity
        && association.label === label).map(association => association.repository);
    },
    select(config, repository) {
      return selectCredential(labels(config), repository === null ? null
        : associations.get(associationKey(credentialIdentity(config), repository))?.label ?? null);
    },
    changes() {
      const changes: CredentialChange[] = [];
      for (const key of new Set([...initialRecords.keys(), ...records.keys()])) {
        const before = initialRecords.get(key); const after = records.get(key);
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        const record = (after ?? before)!;
        changes.push({ kind: "entry", config: configOf(record), action: after ? "save" : "remove", label: record.label });
      }
      for (const key of new Set([...initialAssociations.keys(), ...associations.keys()])) {
        const before = initialAssociations.get(key); const after = associations.get(key);
        if (before?.label === after?.label) continue;
        const association = (after ?? before)!;
        // Removing an entry already reports its dropped associations.
        if (!after && !records.has(entryKey(credentialIdentity(association.config), association.label))) continue;
        changes.push({ kind: "association", config: association.config, repository: association.repository, label: after?.label ?? null });
      }
      return changes;
    },
    serialize() {
      // Default-only entries without associations keep the original format readable by older Timber.
      if (associations.size === 0 && [...records.values()].every(record => record.label === defaultCredentialLabel)) {
        return JSON.stringify({ version: 1, records: [...records.values()].map(({ label: _label, ...record }) => record) }, null, 2) + "\n";
      }
      return JSON.stringify({
        version: 2,
        records: [...records.values()].map(({ label, ...record }) => ({ label, ...record })),
        associations: [...associations.values()].map(({ config, repository, label }) => ({ repository, ...config, label })),
      }, null, 2) + "\n";
    },
  };
}

export function unselectedJiraMessage(): string {
  return "Several saved Jira credentials exist for this site and token mode, and none is selected for this repository. Run timber setup in this repository to choose one, or set both JIRA_EMAIL and JIRA_API_TOKEN.";
}

/** Null means no saved pair; several pairs without this repository's association fail instead of guessing. */
export async function loadSavedCredentials(config: JiraConfig, env: NodeJS.ProcessEnv = process.env,
  repository: string | null = null): Promise<JiraCredentials | null> {
  const store = await readCredentialStore(env);
  const selection = store.select(config, repository);
  if (selection.kind === "missing") return null;
  if (selection.kind === "unselected") throw new Error(unselectedJiraMessage());
  return store.get(config, selection.label);
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
    if (await readSource(store.path) !== store.original) throw new SetupChangedError("Jira credential store changed during setup. Existing credentials were preserved; rerun setup.");
    if (emptied) {
      if (store.original === null) throw storeError();
      await unlink(store.path);
      deleted = true;
    } else {
      const staged = await temporary(store.path, next); temps.add(staged);
      cancel();
      if (await readSource(store.path) !== store.original) throw new SetupChangedError("Jira credential store changed during setup. Existing credentials were preserved; rerun setup.");
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
