import { Buffer } from "node:buffer";
import { z } from "zod";
import type { JiraConfig, JiraTicket, TrackerUser } from "../types";
import { isJiraTicketKey } from "./branch";
import { loadSavedCredentials, validCredentials } from "./credentials";
import { repositoryCredentialKey } from "../credential-selection";
import type { JiraCredentials } from "./credentials";

const defaultTimeoutMs = 10_000;
const jiraHostname = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/;
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const statusCategoryKeySchema = z.enum(["new", "indeterminate", "done"]);
const issueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().refine(value => value.trim().length > 0),
    status: z.unknown().optional(),
    assignee: z.unknown().optional(),
  }),
});
const accountSchema = z.object({
  accountId: z.string().refine(value => value.trim().length > 0),
  displayName: z.string().optional(),
});

function trackerUser(account: z.infer<typeof accountSchema>): TrackerUser {
  return { id: account.accountId, name: account.displayName?.trim() || account.accountId };
}
export type JiraLookupFailureReason = "not-found" | "done";

/** A safe Jira diagnostic; reason is present only for exact missing/done lookups. */
export class JiraLookupFailure extends Error {
  constructor(message: string, readonly reason?: JiraLookupFailureReason) {
    super(message);
    this.name = "JiraLookupFailure";
  }
}

export interface JiraRuntime {
  env: Readonly<Record<string, string | undefined>>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs: number;
  loadCredentials?: (config: JiraConfig) => Promise<JiraCredentials | null>;
  signal?: AbortSignal;
}

/** Resolve one Jira issue with a bounded native fetch and safe diagnostics. */
export async function resolveJiraTicket(
  config: JiraConfig,
  key: string,
  runtime: JiraRuntime = defaultRuntime(),
  allowClosed = false,
): Promise<JiraTicket> {
  if (!isJiraTicketKey(key)) throw new Error("Invalid Jira ticket key.");

  const requestContext = await prepareRequest(config, runtime);
  const requestUrl = new URL(`${requestContext.apiRoot}/rest/api/3/issue/${encodeURIComponent(key)}`);
  requestUrl.searchParams.set("fields", "summary,status,assignee");

  return withDeadline(runtime, async signal => {
    const body = await fetchJson(runtime, requestUrl.href, requestContext.authorization, signal, true);
    const issue = usableIssue(body);
    if (!isJiraTicketKey(issue.key)) {
      throw new JiraLookupFailure("Unexpected Jira response; issue data was not usable.");
    }
    const statusCategory = statusCategoryKeySchema.safeParse(statusCategoryKey(issue.fields.status));
    if (!statusCategory.success) throw unknownStatusCategory(issue.key);
    if (statusCategory.data === "done" && !allowClosed) {
      throw new JiraLookupFailure(`Jira issue ${issue.key} is complete; rerun with -c to create a branch anyway.`, "done");
    }

    return toTicket(issue, requestContext.siteOrigin);
  });
}

export interface JiraRequestContext {
  siteOrigin: string;
  apiRoot: string;
  authorization: string;
}

/** Checks the login and returns its account. */
export async function checkJiraConnection(config: JiraConfig, runtime: JiraRuntime = defaultRuntime()): Promise<TrackerUser> {
  const request = await prepareRequest(config, runtime);
  return withDeadline(runtime, async signal => {
    const body = await fetchJson(runtime, `${request.apiRoot}/rest/api/3/myself`, request.authorization, signal);
    const account = accountSchema.safeParse(body);
    if (!account.success) throw new JiraLookupFailure("Unexpected Jira response; current-user data was not usable.");
    return trackerUser(account.data);
  });
}

/** Assign one issue to an account. Jira has one assignee, so this replaces any other. */
export async function assignJiraIssue(config: JiraConfig, key: string, accountId: string,
  runtime: JiraRuntime = defaultRuntime()): Promise<void> {
  if (!isJiraTicketKey(key)) throw new Error("Invalid Jira ticket key.");
  const request = await prepareRequest(config, runtime);
  await withDeadline(runtime, async signal => {
    let response: Response;
    try {
      response = await runtime.fetch(`${request.apiRoot}/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: request.authorization },
        body: JSON.stringify({ accountId }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new JiraLookupFailure("Jira request failed because of a network or redirect error; check connectivity and the configured site/token mode.");
    }
    await discardBody(response);
    if (response.status >= 200 && response.status < 300) return;
    if (response.status >= 300 && response.status < 400) {
      throw new JiraLookupFailure("Jira request was redirected; check connectivity and the configured site/token mode.");
    }
    if (response.status === 400) throw new JiraLookupFailure("Jira refused the assignee (400); the account may not be assignable in this project.");
    if (response.status === 403) throw new JiraLookupFailure("Jira denied the assignment (403); the login needs the Assign Issues permission and a write scope.");
    throw httpFailure(response.status, false);
  });
}

/** Validated site, API root and Basic authorization; throws a safe diagnostic when no usable login exists. */
export async function prepareRequest(config: JiraConfig, runtime: JiraRuntime): Promise<JiraRequestContext> {
  const siteOrigin = validatedSiteOrigin(config);
  const { JIRA_EMAIL: email, JIRA_API_TOKEN: token } = runtime.env;
  let pair: JiraCredentials | null;
  if (email !== undefined || token !== undefined) {
    if (email === undefined || token === undefined || !validCredentials({ email, token })) {
      throw new Error("JIRA credentials are missing or invalid: JIRA_EMAIL and JIRA_API_TOKEN must be a complete nonblank pair. Set both, or unset both and run timber setup to use saved credentials; sources are never mixed.");
    }
    pair = { email, token };
  } else {
    pair = await runtime.loadCredentials?.(config) ?? null;
    if (pair === null) throw new Error("JIRA credentials are missing: JIRA_EMAIL and JIRA_API_TOKEN are unset and no matching saved pair exists. Run timber setup or timber setup --global, or set both environment variables.");
    if (!validCredentials(pair)) throw new Error("Saved Jira credentials are invalid. Replace them with timber setup; never include credential contents in reports.");
  }

  if (!Number.isFinite(runtime.timeoutMs) || runtime.timeoutMs <= 0) {
    throw new Error("Invalid Jira timeout setting.");
  }

  const apiRoot = config.cloudId === undefined
    ? siteOrigin
    : `https://api.atlassian.com/ex/jira/${config.cloudId}`;
  return {
    siteOrigin,
    apiRoot,
    authorization: `Basic ${Buffer.from(`${pair.email}:${pair.token}`, "utf8").toString("base64")}`,
  };
}

async function withDeadline<T>(runtime: JiraRuntime, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let open = true;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const settle = (error: Error) => {
    if (!open) return;
    open = false;
    rejectDeadline(error);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    settle(new Error(timeoutMessage(runtime.timeoutMs)));
  }, runtime.timeoutMs);
  const cancel = () => { controller.abort(); settle(abortError()); };
  runtime.signal?.addEventListener("abort", cancel, { once: true });

  try {
    if (runtime.signal?.aborted) throw abortError();
    const result = await Promise.race([operation(controller.signal), deadline]);
    open = false;
    return result;
  } catch (error) {
    open = false;
    if (runtime.signal?.aborted || isAbortError(error)) throw abortError();
    if (timedOut) throw new JiraLookupFailure(timeoutMessage(runtime.timeoutMs));
    if (error instanceof JiraLookupFailure) throw error;
    throw new JiraLookupFailure("Jira request failed because of a network or redirect error; check connectivity and the configured site/token mode.");
  } finally {
    clearTimeout(timer);
    runtime.signal?.removeEventListener("abort", cancel);
  }
}

async function fetchJson(
  runtime: JiraRuntime,
  requestUrl: string,
  authorization: string,
  signal: AbortSignal,
  missingIssueHasReason = false,
): Promise<unknown> {
  let response: Response;
  try {
    response = await runtime.fetch(requestUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authorization,
      },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new JiraLookupFailure("Jira request failed because of a network or redirect error; check connectivity and the configured site/token mode.");
  }

  if (response.status >= 300 && response.status < 400) {
    await discardBody(response);
    throw new JiraLookupFailure("Jira request was redirected; check connectivity and the configured site/token mode.");
  }
  if (!response.ok) {
    await discardBody(response);
    throw httpFailure(response.status, missingIssueHasReason);
  }

  try {
    return await response.json() as unknown;
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof SyntaxError) throw new JiraLookupFailure("Unexpected Jira response; issue data was not usable.");
    throw new JiraLookupFailure("Jira request failed while reading the response; check connectivity and retry.");
  }
}

function usableIssue(body: unknown): z.infer<typeof issueSchema> {
  const issue = issueSchema.safeParse(body);
  if (!issue.success) throw new JiraLookupFailure("Unexpected Jira response; issue data was not usable.");
  return issue.data;
}

function toTicket(issue: z.infer<typeof issueSchema>, siteOrigin: string): JiraTicket {
  const assignee = issue.fields.assignee;
  const account = assignee === undefined || assignee === null ? null : accountSchema.safeParse(assignee);
  return {
    key: issue.key,
    title: issue.fields.summary,
    url: new URL(`/browse/${encodeURIComponent(issue.key)}`, siteOrigin).href,
    // A missing field or an unreadable account leaves the assignees unknown.
    ...(assignee === undefined || (account !== null && !account.success) ? {}
      : { assignees: account === null ? [] : [trackerUser(account.data!)] }),
  };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Error bodies are intentionally ignored; their contents are never diagnostic data.
  }
}

function httpFailure(status: number, missingIssueHasReason: boolean): JiraLookupFailure {
  switch (status) {
    case 401:
      return new JiraLookupFailure("Jira authentication rejected (401); check the email, token expiry, and token/API-root mode.");
    case 403:
      return new JiraLookupFailure("Jira access denied (403); check project permissions and token scopes.");
    case 404:
      return new JiraLookupFailure(
        "Jira issue is unavailable or not visible (404); check the key and access.",
        missingIssueHasReason ? "not-found" : undefined,
      );
    case 429:
      return new JiraLookupFailure("Jira is rate limited (429); retry later.");
    default:
      if (status >= 500 && status < 600) {
        return new JiraLookupFailure(`Jira is unavailable (${status}); retry later.`);
      }
      return new JiraLookupFailure(`Unexpected Jira response (HTTP ${status}).`);
  }
}

function validatedSiteOrigin(config: JiraConfig): string {
  const value = config.siteUrl;
  if (typeof value !== "string" || value !== value.trim()
    || /[\u0000-\u0020\u007f\\]/u.test(value)
    || !/^https:\/\/[^/?#]+\/?$/iu.test(value)) {
    throw new Error("Invalid Jira configuration; check [jira].site_url and cloud_id.");
  }

  try {
    const site = new URL(value);
    if (site.protocol !== "https:" || site.username !== "" || site.password !== ""
      || site.port !== "" || site.pathname !== "/" || site.search !== "" || site.hash !== ""
      || !jiraHostname.test(site.hostname)) {
      throw new Error("invalid site URL");
    }
    if (config.cloudId !== undefined && !uuidPattern.test(config.cloudId)) {
      throw new Error("invalid cloud ID");
    }
    return site.origin;
  } catch {
    throw new Error("Invalid Jira configuration; check [jira].site_url and cloud_id.");
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Jira request was aborted.");
  error.name = "AbortError";
  return error;
}

function statusCategoryKey(status: unknown): unknown {
  if (!isRecord(status)) return undefined;
  const category = status.statusCategory;
  if (!isRecord(category)) return undefined;
  return category.key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownStatusCategory(key: string): JiraLookupFailure {
  return new JiraLookupFailure(`Jira issue ${key} has an unknown status category; refusing to create a branch.`);
}

function timeoutMessage(timeoutMs: number): string {
  const duration = timeoutMs === defaultTimeoutMs ? "10 seconds" : `${timeoutMs} ms`;
  return `Jira lookup timed out after ${duration}; retry when service is reachable.`;
}

/** Saved-pair selection uses the repository's shared Git directory when one is given. */
export function jiraRuntime(commonGitDir?: string): JiraRuntime {
  return {
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    timeoutMs: defaultTimeoutMs,
    loadCredentials: async config => loadSavedCredentials(config, process.env,
      commonGitDir === undefined ? null : await repositoryCredentialKey(commonGitDir)),
  };
}

function defaultRuntime(): JiraRuntime { return jiraRuntime(); }
