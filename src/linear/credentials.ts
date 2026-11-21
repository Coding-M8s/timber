import { z } from "zod";
import { credentialStorage } from "../platform/credential-file";
import { credentialLabelSchema, defaultCredentialLabel, repositoryKeySchema, selectCredential, validCredentialLabel } from "../credential-selection";
import type { CredentialSelection } from "../credential-selection";

const keySchema = z.string().min(1).refine(value => !/[\s\u0000-\u0020\u007f-\u009f]/u.test(value));
const legacySchema = z.object({ version: z.literal(1), token: keySchema }).strict();
const storeSchema = z.object({
  version: z.literal(2),
  entries: z.array(z.object({ label: credentialLabelSchema, token: keySchema }).strict()),
  associations: z.array(z.object({ repository: repositoryKeySchema, label: credentialLabelSchema }).strict()),
}).strict();

export function validLinearKey(key: string): boolean { return keySchema.safeParse(key).success; }

export type LinearCredentialChange =
  | { kind: "entry"; action: "save" | "remove"; label: string }
  | { kind: "association"; repository: string; label: string | null }
  | { kind: "default"; label: string };

export interface LinearCredentialStore {
  readonly path: string;
  readonly original: string | null;
  /** Saved entry labels, default first; labels are never secret. */
  labels(): readonly string[];
  /** The entry repositories without an association use; null when none is saved. */
  defaultLabel(): string | null;
  /** Makes a saved entry the default without changing any association. */
  makeDefault(label: string): void;
  /** Without a label, the key of the default entry. */
  get(label?: string): string | null;
  /** Without a label, replaces the default entry (or creates "default"). Removing an entry drops its associations. */
  set(key: string | null, label?: string): void;
  association(repository: string): string | null;
  associate(repository: string, label: string | null): void;
  /** Repositories explicitly associated with the entry. */
  users(label: string): readonly string[];
  select(repository: string | null): CredentialSelection;
  changes(): readonly LinearCredentialChange[];
  serialize(): string;
}

const storage = credentialStorage({ name: "linear", label: "Linear" });

function parseStore(source: string): { entries: Map<string, string>; associations: Map<string, string> } {
  const input: unknown = JSON.parse(source);
  const legacy = legacySchema.safeParse(input);
  if (legacy.success) return { entries: new Map([[defaultCredentialLabel, legacy.data.token]]), associations: new Map() };
  const parsed = storeSchema.parse(input);
  const entries = new Map<string, string>();
  for (const entry of parsed.entries) {
    if (entries.has(entry.label)) throw storage.storeError();
    entries.set(entry.label, entry.token);
  }
  const associations = new Map<string, string>();
  for (const association of parsed.associations) {
    if (associations.has(association.repository) || !entries.has(association.label)) throw storage.storeError();
    associations.set(association.repository, association.label);
  }
  return { entries, associations };
}

export async function readLinearCredentialStore(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<LinearCredentialStore> {
  const { path, original } = await storage.read(env, signal);
  let state: ReturnType<typeof parseStore> = { entries: new Map(), associations: new Map() };
  if (original !== null) {
    try { state = parseStore(original); }
    catch { throw storage.storeError(); }
  }
  const { entries, associations } = state;
  const initialEntries = new Map(entries);
  const initialAssociations = new Map(associations);
  const fallback = () => entries.size ? [...entries.keys()][0]! : null;
  const initialDefault = fallback();
  return {
    path, original,
    labels() { return [...entries.keys()]; },
    defaultLabel: fallback,
    makeDefault(label) {
      const key = entries.get(label);
      if (key === undefined) throw new Error("Cannot make an unsaved Linear credential the default.");
      const rest = [...entries].filter(([name]) => name !== label);
      entries.clear();
      entries.set(label, key);
      for (const [name, value] of rest) entries.set(name, value);
    },
    get(label) {
      const name = label ?? fallback();
      return name === null ? null : entries.get(name) ?? null;
    },
    set(key, label) {
      const name = label ?? fallback() ?? defaultCredentialLabel;
      if (!validCredentialLabel(name)) throw new Error("Invalid Linear credential label.");
      if (key === null) {
        entries.delete(name);
        for (const [repository, associated] of associations) if (associated === name) associations.delete(repository);
        return;
      }
      if (!validLinearKey(key)) throw new Error("Enter a nonblank Linear personal API key without whitespace or control characters.");
      entries.set(name, key);
    },
    association(repository) { return associations.get(repository) ?? null; },
    associate(repository, label) {
      if (label === null) { associations.delete(repository); return; }
      if (!entries.has(label)) throw new Error("Cannot associate an unsaved Linear credential.");
      associations.set(repository, label);
    },
    users(label) { return [...associations].filter(([, associated]) => associated === label).map(([repository]) => repository); },
    select(repository) { return selectCredential([...entries.keys()], repository === null ? null : associations.get(repository) ?? null); },
    changes() {
      const changes: LinearCredentialChange[] = [];
      for (const label of new Set([...initialEntries.keys(), ...entries.keys()])) {
        if (initialEntries.get(label) === entries.get(label)) continue;
        changes.push({ kind: "entry", action: entries.has(label) ? "save" : "remove", label });
      }
      for (const repository of new Set([...initialAssociations.keys(), ...associations.keys()])) {
        const label = associations.get(repository) ?? null;
        // Removing an entry already reports its dropped associations.
        if ((initialAssociations.get(repository) ?? null) === label) continue;
        if (label === null && !entries.has(initialAssociations.get(repository)!)) continue;
        changes.push({ kind: "association", repository, label });
      }
      const now = fallback();
      if (initialDefault !== null && now !== null && now !== initialDefault) changes.push({ kind: "default", label: now });
      return changes;
    },
    serialize() {
      // A lone "default" entry, or none, keeps the original single-key format readable by older Timber.
      if (associations.size === 0 && (entries.size === 0 || (entries.size === 1 && entries.has(defaultCredentialLabel)))) {
        return JSON.stringify({ version: 1, token: entries.get(defaultCredentialLabel) ?? null }, null, 2) + "\n";
      }
      return JSON.stringify({
        version: 2,
        entries: [...entries].map(([label, token]) => ({ label, token })),
        associations: [...associations].map(([repository, label]) => ({ repository, label })),
      }, null, 2) + "\n";
    },
  };
}

/** Null means no saved key; otherwise this repository's selected key, else the default key. */
export async function loadSavedLinearKey(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal,
  repository: string | null = null): Promise<string | null> {
  const store = await readLinearCredentialStore(env, signal);
  const selection = store.select(repository);
  if (selection.kind === "missing") return null;
  return store.get(selection.label);
}

/** Credentials publish first; config's successful publication is the shared commit point. */
export function withLinearCredentialSave(store: LinearCredentialStore, publishConfig: () => Promise<void>, signal?: AbortSignal,
  files: Partial<Pick<typeof import("node:fs/promises"), "link">> = {}): Promise<void> {
  return storage.save({
    path: store.path, original: store.original, serialize: () => store.serialize(),
    changed: () => store.changes().length > 0, empty: () => store.labels().length === 0,
  }, publishConfig, signal, files);
}
