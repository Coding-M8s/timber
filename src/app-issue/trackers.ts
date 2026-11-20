import { z } from "zod";
import type { IssueLink, LinkedTracker } from "../git/issue-link";
import { prepareRequest } from "../jira/client";
import type { JiraCredentials } from "../jira/credentials";
import { missingIssue } from "../linear/client";
import type { JiraConfig } from "../types";

export type IssueReadReason = "offline" | "sign-in-needed" | "not-found" | "forbidden" | "failed";

/** A classified read failure. The message is Timber's own wording and never carries a response body. */
export class IssueReadFailure extends Error {
  constructor(readonly reason: IssueReadReason, message: string) { super(message); }
}

export interface IssueStatus {
  /** The tracker's own status name, such as "In Review". */
  name: string;
  category: "open" | "in-progress" | "closed";
}

export interface IssueSummary {
  tracker: LinkedTracker;
  key: string;
  url: string;
  title: string;
  status: IssueStatus;
  /** Display name of the assignee; null when unassigned. */
  assignee: string | null;
}

/** Network and login seams. Every call shares one abort signal owned by the caller's time limit. */
export interface IssueTrackerRuntime {
  env: NodeJS.ProcessEnv;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  githubToken: (signal: AbortSignal) => Promise<string>;
  linearToken: (signal: AbortSignal) => Promise<string>;
  jiraCredentials: (config: JiraConfig) => Promise<JiraCredentials | null>;
  /** Called with every login value read, so it can be hidden from diagnostics. */
  secret: (value: string) => void;
}

export const names: Record<LinkedTracker, string> = { github: "GitHub", jira: "Jira", linear: "Linear" };
export const unusable = (tracker: LinkedTracker) => new IssueReadFailure("failed", `${names[tracker]} returned an issue Timber could not read; try again later.`);
const text = z.string().refine(value => value.trim().length > 0);

export async function send(tracker: LinkedTracker, runtime: IssueTrackerRuntime, url: string, init: RequestInit,
  signal: AbortSignal): Promise<Response> {
  try {
    return await runtime.fetch(url, { ...init, redirect: "manual", signal });
  } catch {
    signal.throwIfAborted();
    throw new IssueReadFailure("offline", `${names[tracker]} could not be reached; check connectivity and try again.`);
  }
}

/** Wording for a 403 and a 404, which depend on what was asked for. */
export interface MissingWording { forbidden: string; notFound: string }

/** Reads the body as JSON after mapping every non-success status to a reason; error bodies are discarded unread. */
export async function json(tracker: LinkedTracker, response: Response, allowStatus: (status: number) => boolean = () => false,
  wording?: MissingWording): Promise<unknown> {
  const name = names[tracker];
  if (!response.ok && !allowStatus(response.status)) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new IssueReadFailure("sign-in-needed", `${name} rejected the login; run timber setup to check or replace it.`);
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") !== "0") {
      throw new IssueReadFailure("forbidden", wording?.forbidden ?? `The ${name} login cannot read this issue; check its access to the project or repository.`);
    }
    if (response.status === 404 || response.status === 410) {
      throw new IssueReadFailure("not-found", wording?.notFound ?? `${name} has no issue at the linked address, or it is hidden from this login.`);
    }
    if (response.status === 403 || response.status === 429) throw new IssueReadFailure("failed", `${name} is rate limiting requests; try again later.`);
    if (response.status >= 300 && response.status < 400) {
      throw new IssueReadFailure("failed", `${name} redirected the request; the issue may have moved. Link the worktree again with timber open --issue.`);
    }
    throw new IssueReadFailure("failed", `${name} answered with HTTP ${response.status}; try again later.`);
  }
  try { return await response.json(); } catch { throw unusable(tracker); }
}

const githubIssue = z.object({
  title: text,
  state: z.enum(["open", "closed"]),
  assignee: z.object({ login: text }).nullable().optional(),
});

/** Reads the GitHub login and registers it as a secret. */
export async function githubLogin(runtime: IssueTrackerRuntime, signal: AbortSignal): Promise<string> {
  let token: string;
  try { token = await runtime.githubToken(signal); } catch {
    signal.throwIfAborted();
    throw new IssueReadFailure("sign-in-needed", "No usable GitHub login. Sign in with gh auth login, or set GH_TOKEN or GITHUB_TOKEN to a valid token.");
  }
  runtime.secret(token);
  return token;
}

export const githubHeaders = (token: string): Record<string, string> => ({ Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "timber" });

async function readGithub(link: IssueLink, runtime: IssueTrackerRuntime, signal: AbortSignal): Promise<IssueSummary> {
  // The saved URL was validated as https://github.com/<owner>/<repo>/issues/<key>.
  const [, owner, name] = new URL(link.url).pathname.split("/");
  const token = await githubLogin(runtime, signal);
  const response = await send("github", runtime, `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/issues/${link.key}`, {
    method: "GET", headers: githubHeaders(token) }, signal);
  const parsed = githubIssue.safeParse(await json("github", response));
  if (!parsed.success) throw unusable("github");
  const issue = parsed.data;
  return { ...link, title: issue.title, assignee: issue.assignee?.login ?? null,
    status: issue.state === "open" ? { name: "Open", category: "open" } : { name: "Closed", category: "closed" } };
}

export const jiraCategories = { new: "open", indeterminate: "in-progress", done: "closed" } as const;
const jiraIssue = z.object({
  fields: z.object({
    summary: text,
    status: z.object({ name: text, statusCategory: z.object({ key: z.enum(["new", "indeterminate", "done"]) }) }),
    assignee: z.object({ displayName: z.string() }).nullable().optional(),
  }),
});

/** Prepares the Jira site and login, registering every login value as a secret. */
export async function jiraLogin(config: JiraConfig | undefined, runtime: IssueTrackerRuntime,
  signal: AbortSignal): Promise<{ apiRoot: string; siteOrigin: string; authorization: string }> {
  if (config === undefined) {
    throw new IssueReadFailure("sign-in-needed", "Jira is not set up for this repository. Run timber setup to choose a Jira site and save a login.");
  }
  let request;
  try {
    // Only the login and site are prepared here; the caller's signal bounds the request, so timeoutMs is a placeholder.
    request = await prepareRequest(config, { env: runtime.env, fetch: runtime.fetch, timeoutMs: 1,
      loadCredentials: async identity => {
        const pair = await runtime.jiraCredentials(identity);
        if (pair) { runtime.secret(pair.token); runtime.secret(pair.email); }
        return pair;
      } });
  } catch (error) {
    signal.throwIfAborted();
    throw new IssueReadFailure("sign-in-needed", error instanceof Error && error.message ? error.message
      : "No usable Jira login. Run timber setup, or set JIRA_EMAIL and JIRA_API_TOKEN.");
  }
  runtime.secret(request.authorization);
  return request;
}

async function readJira(link: IssueLink, config: JiraConfig | undefined, runtime: IssueTrackerRuntime,
  signal: AbortSignal): Promise<IssueSummary> {
  if (config !== undefined && new URL(link.url).origin !== new URL(config.siteUrl).origin) {
    throw new IssueReadFailure("failed", "The linked issue is on a different Jira site from the configured one; the configured login is not used for it.");
  }
  const request = await jiraLogin(config, runtime, signal);
  const url = new URL(`${request.apiRoot}/rest/api/3/issue/${encodeURIComponent(link.key)}`);
  url.searchParams.set("fields", "summary,status,assignee");
  const response = await send("jira", runtime, url.href, { method: "GET",
    headers: { Accept: "application/json", Authorization: request.authorization } }, signal);
  const parsed = jiraIssue.safeParse(await json("jira", response));
  if (!parsed.success) throw unusable("jira");
  const { fields } = parsed.data;
  return { ...link, title: fields.summary, assignee: fields.assignee?.displayName.trim() || null,
    status: { name: fields.status.name, category: jiraCategories[fields.status.statusCategory.key] } };
}

export const linearCategories: Record<string, IssueStatus["category"]> = { triage: "open", backlog: "open", unstarted: "open",
  started: "in-progress", completed: "closed", canceled: "closed", duplicate: "closed" };
const linearIssue = z.object({
  trashed: z.boolean().nullable().optional(),
  title: text,
  state: z.object({ name: text, type: z.string() }),
  assignee: z.object({ displayName: z.string() }).nullable().optional(),
});
const linearError = z.object({ errors: z.array(z.object({ extensions: z.object({ code: z.string() }).optional() })).min(1) });

/** Reads the Linear key and registers it as a secret. */
export async function linearLogin(runtime: IssueTrackerRuntime, signal: AbortSignal): Promise<string> {
  let token: string;
  try { token = await runtime.linearToken(signal); } catch (error) {
    signal.throwIfAborted();
    throw new IssueReadFailure("sign-in-needed", error instanceof Error && error.message ? error.message
      : "No usable Linear login. Run timber setup, or set LINEAR_API_KEY.");
  }
  runtime.secret(token);
  return token;
}

/** Maps GraphQL error codes in a Linear body to a reason; returns quietly when the body has no errors. */
export function throwLinearErrors(body: unknown, forbidden: string): void {
  const errors = linearError.safeParse(body);
  if (!errors.success) return;
  const codes = errors.data.errors.map(error => error.extensions?.code);
  if (codes.includes("AUTHENTICATION_ERROR")) throw new IssueReadFailure("sign-in-needed", "Linear rejected the saved login; run timber setup to check or replace it.");
  if (codes.includes("FORBIDDEN")) throw new IssueReadFailure("forbidden", forbidden);
  if (codes.includes("RATELIMITED")) throw new IssueReadFailure("failed", "Linear is rate limiting requests; try again later.");
  throw new IssueReadFailure("failed", "Linear could not answer the issue query; try again later.");
}

async function readLinear(link: IssueLink, runtime: IssueTrackerRuntime, signal: AbortSignal): Promise<IssueSummary> {
  const token = await linearLogin(runtime, signal);
  const response = await send("linear", runtime, "https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({
      query: "query TimberLinearIssueStatus($id: String!) { issue(id: $id) { title trashed state { name type } assignee { displayName } } }",
      variables: { id: link.key },
    }),
  }, signal);
  // Linear reports a missing issue and some login problems as GraphQL errors with HTTP 400.
  const body = await json("linear", response, status => status === 400);
  if (missingIssue(body)) throw new IssueReadFailure("not-found", "Linear has no issue with the linked key, or it is hidden from this login.");
  throwLinearErrors(body, "The Linear login cannot read this issue; check its team access.");
  if (!response.ok) throw unusable("linear");
  const data = z.object({ data: z.object({ issue: z.unknown() }) }).safeParse(body);
  if (!data.success) throw unusable("linear");
  if (data.data.data.issue === null) throw new IssueReadFailure("not-found", "Linear has no issue with the linked key, or it is hidden from this login.");
  const parsed = linearIssue.safeParse(data.data.data.issue);
  if (!parsed.success) throw unusable("linear");
  const issue = parsed.data;
  if (issue.trashed) throw new IssueReadFailure("not-found", "The linked Linear issue was deleted.");
  const category = linearCategories[issue.state.type];
  if (category === undefined) throw new IssueReadFailure("failed", "The linked Linear issue has a state type Timber does not know.");
  return { ...link, title: issue.title, assignee: issue.assignee?.displayName.trim() || null,
    status: { name: issue.state.name, category } };
}

/** One read-only lookup of a linked issue. Never prompts or writes; the caller owns the time limit through `signal`. */
export async function readLinkedIssue(link: IssueLink, jira: JiraConfig | undefined, runtime: IssueTrackerRuntime,
  signal: AbortSignal): Promise<IssueSummary> {
  if (link.tracker === "github") return readGithub(link, runtime, signal);
  if (link.tracker === "jira") return readJira(link, jira, runtime, signal);
  return readLinear(link, runtime, signal);
}
