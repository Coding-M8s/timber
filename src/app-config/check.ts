import { readBitbucketLogin } from "../bitbucket/auth";
import { checkBitbucketConnection } from "../bitbucket/client";
import { validBitbucketLogin } from "../bitbucket/credentials";
import { effectiveConfigValues, loadConfigScopes } from "../config";
import { readGithubToken } from "../github/auth";
import { checkGithubConnection } from "../github/client";
import { discoverRepository } from "../git/repository";
import { checkJiraConnection } from "../jira/client";
import { loadSavedCredentials, validCredentials } from "../jira/credentials";
import { readLinearKey } from "../linear/auth";
import { checkLinearConnection } from "../linear/client";
import { validLinearKey } from "../linear/credentials";
import { draftConfig, scopesWithDraft } from "./settings";
import { knownSecrets, safeAppDiagnostic } from "./input";
import type { AppConfigInput, AppConfigScope } from "./input";

export const appIntegrations = ["github", "linear", "jira", "bitbucket"] as const;
export type AppIntegration = typeof appIntegrations[number];

export interface AppConfigCheck {
  schemaVersion: 1;
  integration: AppIntegration;
  ok: boolean;
  /** Where the checked login came from; null when the check stopped before choosing one. */
  source: "draft" | "saved" | "environment" | "github-cli" | null;
  /** GitHub login name on success; null otherwise. */
  account: string | null;
  diagnostic: string | null;
}

export interface CheckRuntime {
  env: NodeJS.ProcessEnv;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs: number;
}

const defaultRuntime = (): CheckRuntime => ({ env: process.env, fetch: (url, init) => fetch(url, init), timeoutMs: 10_000 });

async function jiraSite(cwd: string, scope: AppConfigScope | undefined, input: AppConfigInput | undefined, env: NodeJS.ProcessEnv) {
  const repository = scope === "global" ? null : await discoverRepository(cwd).catch(() => null);
  if (scope === "repository" && repository === null) {
    throw new Error("Repository scope needs a working directory inside a Git repository. Use --scope global for machine defaults.");
  }
  const scopes = await loadConfigScopes(repository?.primaryWorktreeRoot, env);
  const file = repository === null ? scopes.global : scopes.local!;
  const jira = effectiveConfigValues(input === undefined ? scopes : scopesWithDraft(
    { scope: repository === null ? "global" : "repository", scopes, file }, draftConfig(input.values, file.values))).jira;
  if (!jira) throw new Error(`Jira is not configured in ${input === undefined ? "the saved settings" : "this draft"}. Set a Jira site before checking the connection.`);
  return { siteUrl: jira.site_url, ...(jira.cloud_id === undefined ? {} : { cloudId: jira.cloud_id }) };
}

/**
 * One read-only request for the current user. A draft's credentials are used when
 * it carries them; otherwise the check uses what Timber commands would use.
 * Nothing is saved, and the result never contains a credential.
 */
export async function checkAppIntegration(
  integration: AppIntegration, cwd: string, scope?: AppConfigScope, input?: AppConfigInput,
  runtime: CheckRuntime = defaultRuntime(),
): Promise<AppConfigCheck> {
  const { env, fetch, timeoutMs } = runtime;
  const result: AppConfigCheck = { schemaVersion: 1, integration, ok: false, source: null, account: null, diagnostic: null };
  try {
    if (integration === "github") {
      // Timber stores no GitHub token, so a draft has nothing to contribute.
      result.source = env.GH_TOKEN !== undefined || env.GITHUB_TOKEN !== undefined ? "environment" : "github-cli";
      result.account = await checkGithubConnection({ token: signal => readGithubToken(signal, { env }), fetch, timeoutMs });
    } else if (integration === "linear") {
      const draft = input?.credentials?.linear;
      if (draft === null) throw new Error("This draft removes the saved Linear key, so there is no login to check.");
      if (draft !== undefined && !validLinearKey(draft.token)) throw new Error("Invalid settings draft: credentials.linear is invalid.");
      result.source = draft !== undefined ? "draft" : env.LINEAR_API_KEY !== undefined ? "environment" : "saved";
      await checkLinearConnection({ token: async signal => draft?.token ?? readLinearKey(env, undefined, signal), fetch, timeoutMs });
    } else if (integration === "bitbucket") {
      const draft = input?.credentials?.bitbucket;
      if (draft === null) throw new Error("This draft removes the saved Bitbucket login, so there is no login to check.");
      if (draft !== undefined && !validBitbucketLogin(draft)) throw new Error("Invalid settings draft: credentials.bitbucket is invalid.");
      result.source = draft !== undefined ? "draft"
        : env.BITBUCKET_EMAIL !== undefined || env.BITBUCKET_API_TOKEN !== undefined ? "environment" : "saved";
      await checkBitbucketConnection({ login: async signal => draft ?? readBitbucketLogin(env, undefined, signal), fetch, timeoutMs });
    } else {
      const config = await jiraSite(cwd, scope, input, env);
      const draft = input?.credentials?.jira;
      if (draft === null) throw new Error("This draft removes the saved Jira credentials, so there is no login to check.");
      if (draft !== undefined && !validCredentials(draft)) throw new Error("Invalid settings draft: credentials.jira is invalid.");
      result.source = draft !== undefined ? "draft"
        : env.JIRA_EMAIL !== undefined || env.JIRA_API_TOKEN !== undefined ? "environment" : "saved";
      await checkJiraConnection(config, draft !== undefined
        ? { env: { JIRA_EMAIL: draft.email, JIRA_API_TOKEN: draft.token }, fetch, timeoutMs }
        : { env, fetch, timeoutMs, loadCredentials: identity => loadSavedCredentials(identity, env) });
    }
    result.ok = true;
  } catch (error) {
    result.account = null;
    result.diagnostic = safeAppDiagnostic(error, knownSecrets(env, input), "Connection check failed.");
  }
  return result;
}
