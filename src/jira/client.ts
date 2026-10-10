import { Buffer } from "node:buffer";
import { z } from "zod";
import type { JiraConfig, JiraTicket } from "../types";
import { isJiraTicketKey } from "./branch";

const defaultTimeoutMs = 10_000;
const jiraHostname = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/;
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const statusCategoryKeySchema = z.enum(["new", "indeterminate", "done"]);
const issueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().refine(value => value.trim().length > 0),
    status: z.unknown().optional(),
  }),
});
const searchPageSchema = z.object({
  issues: z.array(z.unknown()),
  isLast: z.boolean(),
  nextPageToken: z.string().optional(),
});

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
}

/** Resolve one Jira issue with a bounded native fetch and safe diagnostics. */
export async function resolveJiraTicket(
  config: JiraConfig,
  key: string,
  runtime: JiraRuntime = defaultRuntime(),
): Promise<JiraTicket> {
  if (!isJiraTicketKey(key)) throw new Error("Invalid Jira ticket key.");

  const requestContext = prepareRequest(config, runtime);
  const requestUrl = new URL(`${requestContext.apiRoot}/rest/api/3/issue/${encodeURIComponent(key)}`);
  requestUrl.searchParams.set("fields", "summary,status");

  return withDeadline(runtime, async signal => {
    const body = await fetchJson(runtime, requestUrl.href, requestContext.authorization, signal, true);
    const issue = usableIssue(body);
    if (!isJiraTicketKey(issue.key)) {
      throw new JiraLookupFailure("Unexpected Jira response; issue data was not usable.");
    }
    const statusCategory = statusCategoryKeySchema.safeParse(statusCategoryKey(issue.fields.status));
    if (!statusCategory.success) throw unknownStatusCategory(issue.key);
    if (statusCategory.data === "done") {
      throw new JiraLookupFailure(`Jira issue ${issue.key} is complete; refusing to create a branch.`, "done");
    }

    return toTicket(issue, requestContext.siteOrigin);
  });
}

/** Find validated active tickets whose full key begins with the requested Jira key. */
export async function findJiraSuggestions(
  config: JiraConfig,
  key: string,
  runtime: JiraRuntime = defaultRuntime(),
): Promise<readonly JiraTicket[]> {
  if (!isJiraTicketKey(key)) throw new Error("Invalid Jira ticket key.");

  const requestContext = prepareRequest(config, runtime);
  const projectKey = key.slice(0, key.lastIndexOf("-"));
  const jql = `project = "${projectKey}" AND statusCategory != Done ORDER BY key ASC`;

  return withDeadline(runtime, async signal => {
    const tickets = new Map<string, JiraTicket>();
    const requestedTokens = new Set<string>();
    let nextPageToken: string | undefined;

    while (true) {
      const requestUrl = new URL(`${requestContext.apiRoot}/rest/api/3/search/jql`);
      requestUrl.searchParams.set("jql", jql);
      requestUrl.searchParams.set("fields", "summary,status");
      requestUrl.searchParams.set("maxResults", "100");
      if (nextPageToken !== undefined) requestUrl.searchParams.set("nextPageToken", nextPageToken);

      const body = await fetchJson(runtime, requestUrl.href, requestContext.authorization, signal);
      const page = searchPageSchema.safeParse(body);
      if (!page.success) throw unusableSearchResponse();

      for (const rawIssue of page.data.issues) {
        const issue = usableIssue(rawIssue);
        if (!isJiraTicketKey(issue.key)) throw unusableSearchResponse();

        const statusCategory = statusCategoryKeySchema.safeParse(statusCategoryKey(issue.fields.status));
        if (!statusCategory.success || statusCategory.data === "done") continue;
        if (issue.key === key || !issue.key.startsWith(key)) continue;
        if (!tickets.has(issue.key)) tickets.set(issue.key, toTicket(issue, requestContext.siteOrigin));
      }

      if (page.data.isLast) {
        return [...tickets.values()].sort((left, right) => compareKeys(left.key, right.key));
      }

      const token = page.data.nextPageToken;
      if (token === undefined || token.trim().length === 0 || requestedTokens.has(token)) {
        throw incompleteSuggestions();
      }
      requestedTokens.add(token);
      nextPageToken = token;
    }
  });
}

interface JiraRequestContext {
  siteOrigin: string;
  apiRoot: string;
  authorization: string;
}

function prepareRequest(config: JiraConfig, runtime: JiraRuntime): JiraRequestContext {
  const siteOrigin = validatedSiteOrigin(config);
  const missing = [
    ["JIRA_EMAIL", runtime.env.JIRA_EMAIL],
    ["JIRA_API_TOKEN", runtime.env.JIRA_API_TOKEN],
  ].flatMap(([name, value]) => typeof value === "string" && value.trim().length > 0 ? [] : [name]);
  if (missing.length > 0) {
    throw new Error(`JIRA credentials are missing: ${missing.join(", ")}. Set them and retry.`);
  }

  if (!Number.isFinite(runtime.timeoutMs) || runtime.timeoutMs <= 0) {
    throw new Error("Invalid Jira timeout setting.");
  }

  const email = runtime.env.JIRA_EMAIL as string;
  const token = runtime.env.JIRA_API_TOKEN as string;
  const apiRoot = config.cloudId === undefined
    ? siteOrigin
    : `https://api.atlassian.com/ex/jira/${config.cloudId}`;
  return {
    siteOrigin,
    apiRoot,
    authorization: `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`,
  };
}

async function withDeadline<T>(runtime: JiraRuntime, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectDeadline(new Error(timeoutMessage(runtime.timeoutMs)));
  }, runtime.timeoutMs);

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (error) {
    if (timedOut) throw new JiraLookupFailure(timeoutMessage(runtime.timeoutMs));
    if (error instanceof JiraLookupFailure) throw error;
    throw new JiraLookupFailure("Jira request failed because of a network or redirect error; check connectivity and the configured site/token mode.");
  } finally {
    clearTimeout(timer);
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
  return {
    key: issue.key,
    title: issue.fields.summary,
    url: new URL(`/browse/${encodeURIComponent(issue.key)}`, siteOrigin).href,
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

function unusableSearchResponse(): JiraLookupFailure {
  return new JiraLookupFailure("Unexpected Jira response; search data was not usable.");
}

function incompleteSuggestions(): JiraLookupFailure {
  return new JiraLookupFailure("Jira suggestions could not be loaded completely; retry when service is reachable.");
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function timeoutMessage(timeoutMs: number): string {
  const duration = timeoutMs === defaultTimeoutMs ? "10 seconds" : `${timeoutMs} ms`;
  return `Jira lookup timed out after ${duration}; retry when service is reachable.`;
}

function defaultRuntime(): JiraRuntime {
  return {
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    timeoutMs: defaultTimeoutMs,
  };
}
