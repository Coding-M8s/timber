import type { CommandIO } from "../services";
import type { JiraConfig } from "../types";
import { safeDisplay } from "../display";
import { checkJiraConnection, JiraLookupFailure } from "../jira/client";
import { readCredentialStore, validCredentials, withCredentialSave } from "../jira/credentials";
import type { CredentialStore, JiraCredentials } from "../jira/credentials";
import { SetupCancelled } from "./types";
import { repositoryCredentialKey } from "../credential-selection";
import { chooseEntryAction, chooseNewLabel, confirmRemoval, severalEntriesNotice } from "./credential-entries";
import type { EntryMenu } from "./credential-entries";
import type { SetupPrompt } from "./types";

export interface JiraSetupSession {
  edit(config: JiraConfig, prompt: SetupPrompt, io: CommandIO): Promise<void>;
  review(io: CommandIO): void;
  save(publishConfig: () => Promise<void>, signal?: AbortSignal): Promise<void>;
}
type ConnectionCheck = (config: JiraConfig, credentials: JiraCredentials, signal?: AbortSignal) => Promise<unknown>;

const defaultCheck: ConnectionCheck = (config, credentials, signal) => checkJiraConnection(config, {
  env: { JIRA_EMAIL: credentials.email, JIRA_API_TOKEN: credentials.token },
  fetch: (url, init) => fetch(url, init), timeoutMs: 10_000,
  ...(signal ? { signal } : {}),
});

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name: unknown }).name === "AbortError";
}

/** This draft lives beside the config draft; neither asking nor checking publishes it. */
/** `commonGitDir` is the repository whose selection setup may change; null in machine-default setup. */
export function createJiraSetupSession(env: NodeJS.ProcessEnv = process.env, check: ConnectionCheck = defaultCheck,
  commonGitDir: string | null = null): JiraSetupSession {
  let store: CredentialStore | undefined;
  let current: string | null = null;
  return {
    async edit(config, prompt, io) {
      store ??= await readCredentialStore(env);
      io.stdout(`Personal credentials: ${safeDisplay(store.path)}\n`);
      io.stdout(process.platform === "win32"
        ? "Plaintext storage limited by Windows ACLs to your account, SYSTEM and Administrators, shared across repositories. Changes apply on Save.\n"
        : "Plaintext, owner-only storage shared across repositories. Changes apply on Save.\n");
      if (env.JIRA_EMAIL !== undefined || env.JIRA_API_TOKEN !== undefined) {
        io.stdout("Jira environment overrides are present. Runtime requires both nonblank variables; unset both to use saved credentials. This connection check uses the draft pair.\n");
      }
      const repository = commonGitDir === null ? null : await repositoryCredentialKey(commonGitDir);
      current = repository;
      const labels = store.labels(config);
      const menu: EntryMenu = {
        title: "Personal login for this Jira site and token mode", noun: "login", labels,
        describe: label => `"${label}" (${safeDisplay(store!.get(config, label)?.email ?? "")})`, repository,
        association: repository === null ? null : store.association(config, repository),
        users: label => store!.users(config, label),
        single: { keep: "Keep saved credentials (token hidden)", enter: "Enter email and API token",
          replace: "Replace email and API token", remove: "Remove this site's saved credentials (shared across repositories)" },
      };
      const action = await chooseEntryAction(prompt, menu);
      let pair: JiraCredentials | null = null;
      if (action.kind === "forget") { store.associate(config, repository!, null); return; }
      if (action.kind === "remove") {
        if (!await confirmRemoval(prompt, menu, action.label)) return;
        store.set(config, null, action.label);
        if (store.labels(config).length === 1) io.stdout(`The remaining saved login "${store.labels(config)[0]}" is now used by every repository on this site and token mode.\n`);
        return;
      }
      if (action.kind === "use") { store.associate(config, repository!, action.label); pair = store.get(config, action.label); }
      if (action.kind === "keep") {
        const selection = store.select(config, repository);
        if (selection.kind === "selected") pair = store.get(config, selection.label);
      }
      if (action.kind === "add" || action.kind === "replace") {
        const label = action.kind === "add" ? await chooseNewLabel(prompt, io, labels) : action.label;
        const previous = action.kind === "replace" ? store.get(config, label) : null;
        while (true) {
          const email = await prompt.text("Atlassian account email", previous?.email ?? "");
          if (email === null) throw new SetupCancelled();
          if (!prompt.secret) throw new Error("Hidden token input is unavailable; use an interactive terminal with timber setup.");
          io.stdout("Create an API token: https://id.atlassian.com/manage-profile/security/api-tokens\n");
          const token = await prompt.secret("Jira API token (hidden, including pasted input)");
          if (token === null) throw new SetupCancelled();
          if (!validCredentials({ email, token })) {
            io.stderr("Enter a valid Atlassian email and a nonblank token without whitespace or control characters. Credentials were not saved.\n");
            continue;
          }
          pair = { email, token }; store.set(config, pair, label); break;
        }
        if (action.kind === "add" && labels.length) {
          io.stdout(severalEntriesNotice("Jira", "login"));
          if (repository !== null) {
            const use = await prompt.confirm(`Use "${label}" for this repository?`, true);
            if (use === null) throw new SetupCancelled();
            if (use) store.associate(config, repository, label);
            else if (menu.association === null && labels.length === 1) store.associate(config, repository, labels[0]!);
          }
        }
      }
      if (!pair) return;
      io.stdout("Optional check: current-user access only; scoped tokens need current-user read scopes.\n");
      const checking = await prompt.confirm("Check this draft login with Jira now? No settings will be saved.", false);
      if (checking === null) throw new SetupCancelled();
      if (checking) {
        try {
          await check(config, pair, prompt.signal);
          if (prompt.signal?.aborted) throw new SetupCancelled();
          io.stdout("Jira current-user connection succeeded; project and issue access was not checked.\n");
        } catch (error) {
          if (error instanceof SetupCancelled || prompt.signal?.aborted || isAbortError(error)) throw new SetupCancelled();
          io.stderr(`Connection check failed: ${error instanceof JiraLookupFailure ? error.message : "check network connectivity, email/token and token scopes; no settings were saved by this check."}\n`);
        }
      }
    },
    review(io) {
      if (!store) return;
      const changes = store.changes();
      if (!changes.length) return;
      for (const change of changes) {
        const site = `${safeDisplay(change.config.siteUrl)} (${change.config.cloudId ? `scoped: ${change.config.cloudId}` : "unscoped"})`;
        if (change.kind === "entry") io.stdout(`Personal credentials: ${change.action === "save" ? "save/replace" : "remove"} "${change.label}" for ${site}; shared across repositories.\n`);
        else io.stdout(`Jira repository selection: ${change.label === null ? "clear" : `use "${change.label}"`} for ${site} in ${change.repository === current ? "this repository" : safeDisplay(change.repository)}.\n`);
      }
      io.stdout(`Personal credential destination: ${safeDisplay(store.path)} (plaintext; owner-only).\n`);
    },
    async save(publishConfig, signal) {
      if (store) await withCredentialSave(store, publishConfig, signal);
      else await publishConfig();
    },
  };
}
