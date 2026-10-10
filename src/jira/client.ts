import { Buffer } from "node:buffer";
import { z } from "zod";
import type { JiraConfig, JiraTicket } from "../types";
import { isJiraTicketKey } from "./branch";

const defaultTimeoutMs = 10_000;
const jiraHostname = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/;
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const issueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().refine(value => value.trim().length > 0),
  }),
});

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

  const siteOrigin = validatedSiteOrigin(config);
  const apiRoot = config.cloudId === undefined
    ? siteOrigin
    : `https://api.atlassian.com/ex/jira/${config.cloudId}`;
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
  const authorization = `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
  const requestUrl = new URL(`${apiRoot}/rest/api/3/issue/${encodeURIComponent(key)}`);
  requestUrl.searchParams.set("fields", "summary");

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectDeadline(new Error(timeoutMessage(runtime.timeoutMs)));
  }, runtime.timeoutMs);

  const request = fetchIssue(runtime, requestUrl.href, authorization, controller.signal, siteOrigin);
  try {
    return await Promise.race([request, deadline]);
  } catch (error) {
    if (timedOut) {
      throw new Error(timeoutMessage(runtime.timeoutMs));
    }
    if (error instanceof JiraLookupFailure) throw error;
    throw new JiraLookupFailure("Jira request failed because of a network or redirect error; check connectivity and the configured site/token mode.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fetchIssue(
  runtime: JiraRuntime,
  requestUrl: string,
  authorization: string,
  signal: AbortSignal,
  siteOrigin: string,
): Promise<JiraTicket> {
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
    throw httpFailure(response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof SyntaxError) throw new JiraLookupFailure("Unexpected Jira response; issue data was not usable.");
    throw new JiraLookupFailure("Jira request failed while reading the response; check connectivity and retry.");
  }

  const issue = issueSchema.safeParse(body);
  if (!issue.success || !isJiraTicketKey(issue.data.key)) {
    throw new JiraLookupFailure("Unexpected Jira response; issue data was not usable.");
  }

  return {
    key: issue.data.key,
    title: issue.data.fields.summary,
    url: new URL(`/browse/${encodeURIComponent(issue.data.key)}`, siteOrigin).href,
  };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Error bodies are intentionally ignored; their contents are never diagnostic data.
  }
}

function httpFailure(status: number): JiraLookupFailure {
  switch (status) {
    case 401:
      return new JiraLookupFailure("Jira authentication rejected (401); check the email, token expiry, and token/API-root mode.");
    case 403:
      return new JiraLookupFailure("Jira access denied (403); check project permissions and token scopes.");
    case 404:
      return new JiraLookupFailure("Jira issue is unavailable or not visible (404); check the key and access.");
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

function timeoutMessage(timeoutMs: number): string {
  const duration = timeoutMs === defaultTimeoutMs ? "10 seconds" : `${timeoutMs} ms`;
  return `Jira lookup timed out after ${duration}; retry when service is reachable.`;
}

class JiraLookupFailure extends Error {}

function defaultRuntime(): JiraRuntime {
  return {
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    timeoutMs: defaultTimeoutMs,
  };
}
