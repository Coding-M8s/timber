import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readBitbucketCredentialStore, withBitbucketCredentialSave } from "../bitbucket/credentials";
import type { BitbucketCredentialStore } from "../bitbucket/credentials";
import { configFileSchema, configIssueFields, effectiveConfigValues } from "../config";
import type { ConfigFile, ConfigScopes } from "../config";
import { discoverRepository } from "../git/repository";
import { readCredentialStore, withCredentialSave } from "../jira/credentials";
import type { CredentialStore } from "../jira/credentials";
import { readLinearCredentialStore, withLinearCredentialSave } from "../linear/credentials";
import type { LinearCredentialStore } from "../linear/credentials";
import type { MachineReporter } from "../machine";
import { renderConfig } from "../setup/render";
import { inspectSetupTarget, saveSetupConfig } from "../setup/storage";
import { SetupChangedError, SetupVisibilityError } from "../setup/types";
import type { SetupTarget } from "../setup/types";
import type { JiraConfig } from "../types";
import { AppConfigInvalid } from "./input";
import type { AppConfigInput, AppConfigScope } from "./input";
import { repositoryCredentialKey } from "../credential-selection";
import type { CredentialSelection } from "../credential-selection";

type CredentialState = "saved" | "none" | "unreadable";
type CredentialChange = "saved" | "removed" | "unchanged";

export interface AppConfigRead {
  schemaVersion: 1;
  scope: AppConfigScope;
  /** Absolute destination an apply to this scope writes. */
  path: string;
  exists: boolean;
  /** The repository file is tracked by Git; apply then needs --edit-tracked. */
  tracked: boolean;
  /** Opaque token for the content that was read; null when the file is absent. */
  revision: string | null;
  values: ConfigFile;
  effective: ConfigFile;
  credentials: {
    jira: { configured: boolean; state: CredentialState; environmentOverride: boolean };
    linear: { state: CredentialState; environmentOverride: boolean };
    bitbucket: { state: CredentialState; environmentOverride: boolean };
  };
}

export interface AppConfigReport {
  result: "saved" | "invalid" | "conflict" | "refused" | "failed";
  scope: AppConfigScope;
  path: string | null;
  /** Revision of the saved content; null unless result is "saved". */
  revision: string | null;
  invalidFields: string[];
  credentials: { jira: CredentialChange; linear: CredentialChange; bitbucket: CredentialChange };
}

export function createAppConfigReport(scope: AppConfigScope): AppConfigReport {
  return { result: "failed", scope, path: null, revision: null, invalidFields: [],
    credentials: { jira: "unchanged", linear: "unchanged", bitbucket: "unchanged" } };
}

/** Settings this interface never edits: an apply carries them over from the saved file. */
// Backup settings are edited only by setup; an app that does not know them must never drop them.
const preserved = ["workflows", "arena", "backup_retention_days", "backup_storage_warning"] as const;

function revisionOf(source: string | null): string | null {
  return source === null ? null : createHash("sha256").update(source, "utf8").digest("hex");
}

async function inspect(scope: AppConfigScope, cwd: string, env: NodeJS.ProcessEnv): Promise<SetupTarget> {
  if (scope === "repository") {
    try { await discoverRepository(cwd); }
    catch { throw new Error("Repository scope needs a working directory inside a Git repository. Use --scope global for machine defaults."); }
  }
  return inspectSetupTarget(scope === "global", cwd, env);
}

function jiraIdentity(effective: ConfigFile): JiraConfig | null {
  return effective.jira ? { siteUrl: effective.jira.site_url,
    ...(effective.jira.cloud_id === undefined ? {} : { cloudId: effective.jira.cloud_id }) } : null;
}

/** Offline and read-only. Credentials are reported as present or absent, never as values. */
export async function readAppConfig(scope: AppConfigScope, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<AppConfigRead> {
  const target = await inspect(scope, cwd, env);
  const effective = effectiveConfigValues(target.scopes);
  const jira = jiraIdentity(effective);
  const state = async (saved: () => Promise<boolean>): Promise<CredentialState> => {
    try { return await saved() ? "saved" : "none"; } catch { return "unreadable"; }
  };
  return {
    schemaVersion: 1, scope, path: target.path, exists: target.file.source !== null, tracked: target.tracked,
    revision: revisionOf(target.file.source), values: target.file.values, effective,
    credentials: {
      jira: { configured: jira !== null,
        state: jira === null ? "none" : await state(async () => (await readCredentialStore(env)).labels(jira).length > 0),
        environmentOverride: env.JIRA_EMAIL !== undefined || env.JIRA_API_TOKEN !== undefined },
      linear: { state: await state(async () => (await readLinearCredentialStore(env)).labels().length > 0),
        environmentOverride: env.LINEAR_API_KEY !== undefined },
      bitbucket: { state: await state(async () => (await readBitbucketCredentialStore(env)).get() !== null),
        environmentOverride: env.BITBUCKET_EMAIL !== undefined || env.BITBUCKET_API_TOKEN !== undefined },
    },
  };
}

/** Validates a draft for one scope and carries over the settings this interface does not edit. */
export function draftConfig(values: Record<string, unknown>, saved: ConfigFile): ConfigFile {
  const parsed = configFileSchema.safeParse(values);
  if (!parsed.success) throw new AppConfigInvalid(configIssueFields(parsed.error.issues));
  const file: ConfigFile = { ...parsed.data };
  const changed = preserved.filter(key => key in file && !isDeepStrictEqual(file[key], saved[key]));
  if (changed.length) throw new AppConfigInvalid(changed.map(key => `${key} cannot be changed here`));
  // Reparse for the canonical key order, so the rendered file does not depend on the draft's.
  return configFileSchema.parse({ ...file,
    ...Object.fromEntries(preserved.flatMap(key => saved[key] === undefined ? [] : [[key, saved[key]]])) });
}

/** The scopes as they would be once the draft replaced this scope's file. */
export function scopesWithDraft(target: Pick<SetupTarget, "scope" | "scopes" | "file">, file: ConfigFile): ConfigScopes {
  const scope = { ...target.file, values: file };
  return target.scope === "global" ? { global: scope, local: null } : { ...target.scopes, local: scope };
}

function credentialChange(store: { changes(): readonly ({ action: "save" | "remove" } | { kind: "association" })[] } | undefined): CredentialChange {
  const action = store?.changes().find(change => "action" in change);
  return action === undefined ? "unchanged" : action.action === "save" ? "saved" : "removed";
}

/**
 * The saved entry a draft replaces or removes: the one this repository selects, else
 * the only one. Several entries without a selection are ambiguous, so nothing is guessed.
 */
function draftLabel(selection: CredentialSelection, field: string): string | undefined {
  if (selection.kind === "selected") return selection.label;
  if (selection.kind === "missing") return undefined;
  throw new AppConfigInvalid([`${field} is ambiguous: several saved entries exist and none is selected; choose one with timber setup`]);
}

/**
 * Saves a complete draft through setup's validation and publication. It starts no
 * tool, runs no hook, and touches only the config file, the Git-local exclusion
 * file, and the private credential stores.
 */
export async function applyAppConfig(
  scope: AppConfigScope, cwd: string, input: AppConfigInput, options: { editTracked: boolean },
  report: AppConfigReport, env: NodeJS.ProcessEnv = process.env, machine?: MachineReporter,
): Promise<void> {
  try {
    const target = await inspect(scope, cwd, env);
    report.path = target.path;
    if (target.repository) await machine?.repository(target.repository);
    if (input.revision === undefined) throw new AppConfigInvalid(["revision is invalid"]);
    const file = draftConfig(input.values, target.file.values);
    const jira = jiraIdentity(effectiveConfigValues(scopesWithDraft(target, file)));
    const credentials = input.credentials ?? {};
    const repository = target.scope === "repository" && target.repository ? await repositoryCredentialKey(target.repository.commonGitDir) : null;
    let jiraStore: CredentialStore | undefined;
    let linearStore: LinearCredentialStore | undefined;
    let bitbucketStore: BitbucketCredentialStore | undefined;
    if (credentials.jira !== undefined) {
      if (jira === null) throw new AppConfigInvalid(["credentials.jira needs a configured Jira site"]);
      jiraStore = await readCredentialStore(env);
      const label = draftLabel(jiraStore.select(jira, repository), "credentials.jira");
      try { jiraStore.set(jira, credentials.jira, label); }
      catch { throw new AppConfigInvalid(["credentials.jira is invalid"]); }
    }
    if (credentials.linear !== undefined) {
      linearStore = await readLinearCredentialStore(env);
      const label = draftLabel(linearStore.select(repository), "credentials.linear");
      try { linearStore.set(credentials.linear?.token ?? null, label); }
      catch { throw new AppConfigInvalid(["credentials.linear is invalid"]); }
    }
    if (credentials.bitbucket !== undefined) {
      bitbucketStore = await readBitbucketCredentialStore(env);
      try { bitbucketStore.set(credentials.bitbucket); }
      catch { throw new AppConfigInvalid(["credentials.bitbucket is invalid"]); }
    }
    if (input.revision !== revisionOf(target.file.source)) {
      throw new SetupChangedError(`Settings at ${target.path} changed since they were read. Read them again before applying; nothing was saved.`);
    }
    if (target.tracked && !options.editTracked) {
      report.result = "refused";
      throw new Error(`${target.path} is tracked by Git. Pass --edit-tracked to change the tracked file (the index stays unchanged), or apply to the global scope; nothing was saved.`);
    }
    const source = renderConfig(file);
    const publish = () => saveSetupConfig(target, source, target.tracked && options.editTracked);
    // Each credential store publishes before the config and rolls back if anything inside it fails.
    const publishBitbucket = () => bitbucketStore ? withBitbucketCredentialSave(bitbucketStore, publish) : publish();
    const publishLinear = () => linearStore ? withLinearCredentialSave(linearStore, publishBitbucket) : publishBitbucket();
    try {
      if (jiraStore) await withCredentialSave(jiraStore, publishLinear); else await publishLinear();
    } catch (error) {
      if (!(error instanceof SetupVisibilityError)) throw error;
      report.result = "refused";
      throw new Error("Repository ignore rules cannot hide .timber.toml, so it would show in Git status. Nothing was saved and shared ignore rules were preserved; apply to the global scope instead.");
    }
    report.result = "saved";
    report.revision = revisionOf(source);
    report.credentials = { jira: credentialChange(jiraStore), linear: credentialChange(linearStore),
      bitbucket: credentialChange(bitbucketStore) };
  } catch (error) {
    if (error instanceof AppConfigInvalid) { report.result = "invalid"; report.invalidFields = [...error.fields]; }
    if (error instanceof SetupChangedError) report.result = "conflict";
    throw error;
  }
}
