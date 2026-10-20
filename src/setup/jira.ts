import type { CommandIO } from "../services";
import type { JiraConfig } from "../types";
import { safeDisplay } from "../display";
import { checkJiraConnection, JiraLookupFailure } from "../jira/client";
import { readCredentialStore, validCredentials, withCredentialSave } from "../jira/credentials";
import type { CredentialStore, JiraCredentials } from "../jira/credentials";
import { SetupCancelled } from "./types";
import type { SetupPrompt } from "./types";

export interface JiraSetupSession {
  edit(config: JiraConfig, prompt: SetupPrompt, io: CommandIO): Promise<void>;
  review(io: CommandIO): void;
  save(publishConfig: () => Promise<void>, signal?: AbortSignal): Promise<void>;
}
type ConnectionCheck = (config: JiraConfig, credentials: JiraCredentials, signal?: AbortSignal) => Promise<void>;

const defaultCheck: ConnectionCheck = (config, credentials, signal) => checkJiraConnection(config, {
  env: { JIRA_EMAIL: credentials.email, JIRA_API_TOKEN: credentials.token },
  fetch: (url, init) => fetch(url, init), timeoutMs: 10_000,
  ...(signal ? { signal } : {}),
});

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name: unknown }).name === "AbortError";
}

/** This draft lives beside the config draft; neither asking nor checking publishes it. */
export function createJiraSetupSession(env: NodeJS.ProcessEnv = process.env, check: ConnectionCheck = defaultCheck): JiraSetupSession {
  let store: CredentialStore | undefined;
  return {
    async edit(config, prompt, io) {
      store ??= await readCredentialStore(env);
      io.stdout(`Personal credentials: ${safeDisplay(store.path)}\n`);
      io.stdout("Plaintext, owner-only storage shared across repositories. Changes apply on Save.\n");
      if (env.JIRA_EMAIL !== undefined || env.JIRA_API_TOKEN !== undefined) {
        io.stdout("Jira environment overrides are present. Runtime requires both nonblank variables; unset both to use saved credentials. This connection check uses the draft pair.\n");
      }
      let pair = store.get(config);
      const choices = [
        { value: "keep", label: pair ? "Keep saved credentials (token hidden)" : "None" },
        { value: "replace", label: pair ? "Replace email and API token" : "Enter email and API token" },
        ...(pair ? [{ value: "remove", label: "Remove this site's saved credentials (shared across repositories)" }] : []),
      ];
      const choice = await prompt.select("Personal login for this Jira site and token mode", choices, "keep");
      if (choice === null) throw new SetupCancelled();
      if (!choices.some(value => value.value === choice)) throw new Error("Invalid Jira credentials choice; no settings saved.");
      if (choice === "remove") { store.set(config, null); return; }
      if (choice === "replace") {
        while (true) {
          const email = await prompt.text("Atlassian account email", pair?.email ?? "");
          if (email === null) throw new SetupCancelled();
          if (!prompt.secret) throw new Error("Hidden token input is unavailable; use an interactive terminal with timber setup.");
          io.stdout("Create an API token: https://id.atlassian.com/manage-profile/security/api-tokens\n");
          const token = await prompt.secret("Jira API token (hidden, including pasted input)");
          if (token === null) throw new SetupCancelled();
          if (!validCredentials({ email, token })) {
            io.stderr("Enter a valid Atlassian email and a nonblank token without whitespace or control characters. Credentials were not saved.\n");
            continue;
          }
          pair = { email, token }; store.set(config, pair); break;
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
      for (const change of changes) io.stdout(`Personal credentials: ${change.action === "save" ? "save/replace" : "remove"} ${safeDisplay(change.config.siteUrl)} (${change.config.cloudId ? `scoped: ${change.config.cloudId}` : "unscoped"}); shared across repositories.\n`);
      io.stdout(`Personal credential destination: ${safeDisplay(store.path)} (plaintext; owner-only).\n`);
    },
    async save(publishConfig, signal) {
      if (store) await withCredentialSave(store, publishConfig, signal);
      else await publishConfig();
    },
  };
}
