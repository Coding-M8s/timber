import { z } from "zod";
import { IssueReadFailure, jiraCategories, jiraLogin, json, send, unusable } from "../app-issue/trackers";
import type { IssueSummary, MissingWording } from "../app-issue/trackers";
import { isJiraTicketKey } from "../jira/branch";
import { batches, keyPrefix, maxSprintIssues, mine, NotConfigured } from "./lists";
import type { IssueList, IssueQuery, LinkedPullRequest, ListContext, PullRequestLinks } from "./lists";

type JiraRequest = Awaited<ReturnType<typeof jiraLogin>>;

const fields = "summary,status,assignee";
const listIssue = z.object({
  key: z.string().refine(isJiraTicketKey),
  fields: z.object({
    summary: z.string(),
    status: z.object({ name: z.string(), statusCategory: z.object({ key: z.string() }) }),
    assignee: z.object({ displayName: z.string(), accountId: z.string().optional() }).nullable().optional(),
  }),
});

/** Assignee account IDs per listed issue; undefined when Jira left an account ID out. */
const assigneeIds = new WeakMap<IssueSummary, readonly string[] | undefined>();

const siteWording: MissingWording = {
  forbidden: "The Jira login cannot read these issues; check its access to the project.",
  notFound: "Jira has no such board or project, or it is hidden from this login.",
};

function summary(request: JiraRequest, issue: z.infer<typeof listIssue>): IssueSummary {
  const { fields: value } = issue;
  const key = value.status.statusCategory.key;
  const result: IssueSummary = { tracker: "jira", key: issue.key, url: `${request.siteOrigin}/browse/${issue.key}`, title: value.summary,
    // A blank display name still names an assignee, so the account ID stands in for it.
    assignee: value.assignee ? value.assignee.displayName.trim() || value.assignee.accountId || null : null,
    // Jira reserves "undefined" for statuses outside the three groups; they are not started.
    status: { name: value.status.name, category: key in jiraCategories ? jiraCategories[key as keyof typeof jiraCategories] : "open" } };
  const { assignee } = value;
  assigneeIds.set(result, assignee === undefined ? undefined : assignee === null ? []
    : assignee.accountId === undefined ? undefined : [assignee.accountId]);
  return result;
}

/** The signed-in account ID; null when Jira does not say, which some scoped tokens cause. */
async function myself(ctx: ListContext, request: JiraRequest): Promise<string | null> {
  const parsed = z.object({ accountId: z.string().min(1) })
    .safeParse((await get(ctx, request, new URL(`${request.apiRoot}/rest/api/3/myself`))).body);
  return parsed.success ? parsed.data.accountId : null;
}

async function get(ctx: ListContext, request: JiraRequest, url: URL, allowStatus?: (status: number) => boolean): Promise<{ status: number; body: unknown }> {
  const response = await send("jira", ctx.runtime, url.href, { method: "GET",
    headers: { Accept: "application/json", Authorization: request.authorization } }, ctx.signal);
  if (!response.ok && allowStatus?.(response.status)) {
    // An allowed error status is answered from the status alone; its body is discarded unread.
    void response.body?.cancel().catch(() => {});
    return { status: response.status, body: null };
  }
  return { status: response.status, body: await json("jira", response, undefined, siteWording) };
}

const searchPage = z.object({ issues: z.array(listIssue), nextPageToken: z.string().nullable().optional() });

/** Runs a JQL search, paging until `limit` issues are known to exist. A rejected query is reported as `rejected`. */
async function search(ctx: ListContext, request: JiraRequest, jql: string, limit: number, rejected: string): Promise<IssueList> {
  const issues: IssueSummary[] = [];
  let token: string | null | undefined;
  do {
    const url = new URL(`${request.apiRoot}/rest/api/3/search/jql`);
    url.searchParams.set("jql", jql);
    url.searchParams.set("fields", fields);
    url.searchParams.set("maxResults", String(Math.min(100, limit + 1)));
    if (token) url.searchParams.set("nextPageToken", token);
    const result = await get(ctx, request, url, status => status === 400);
    if (result.status === 400) throw new IssueReadFailure("failed", rejected);
    const page = searchPage.safeParse(result.body);
    if (!page.success) throw unusable("jira");
    issues.push(...page.data.issues.map(issue => summary(request, issue)));
    token = page.data.nextPageToken;
  } while (token && issues.length <= limit);
  return { sprint: null, issues: issues.slice(0, limit), truncated: issues.length > limit || !!token };
}

async function boardSprint(ctx: ListContext, request: JiraRequest, board: number): Promise<IssueList | null> {
  const url = new URL(`${request.apiRoot}/rest/agile/1.0/board/${board}/sprint`);
  url.searchParams.set("state", "active");
  url.searchParams.set("maxResults", "50");
  // Jira answers 400 for a board without sprints, such as a Kanban board.
  const result = await get(ctx, request, url, status => status === 400);
  if (result.status === 400) throw new NotConfigured(`Jira board ${board} does not use sprints; set [jira].board to a Scrum board or use [jira].sprint_jql.`);
  const parsed = z.object({ values: z.array(z.object({ id: z.number().int().positive(), name: z.string() })) }).safeParse(result.body);
  if (!parsed.success) throw unusable("jira");
  const sprints = parsed.data.values;
  if (sprints.length === 0) return null;
  const list = await search(ctx, request, `sprint in (${sprints.map(sprint => sprint.id).join(", ")}) ORDER BY Rank ASC`,
    maxSprintIssues, "Jira rejected the sprint query; try again later.");
  return { ...list, sprint: { name: sprints.map(sprint => sprint.name).join(", "), source: "jira-board" } };
}

async function pickerSearch(ctx: ListContext, request: JiraRequest, project: string | undefined): Promise<IssueList> {
  const text = ctx.text.trim();
  if (text.length === 0) return { sprint: null, issues: [], truncated: false };
  const url = new URL(`${request.apiRoot}/rest/api/3/issue/picker`);
  url.searchParams.set("query", keyPrefix(text) ?? text);
  url.searchParams.set("showSubTasks", "true");
  url.searchParams.set("showSubTaskParent", "true");
  // Without a current query the picker answers only from the login's own history.
  url.searchParams.set("currentJQL", `${project === undefined ? "" : `project = "${project}" `}ORDER BY updated DESC`);
  const picked = z.object({ sections: z.array(z.object({ id: z.string(), issues: z.array(z.object({ key: z.string() })) })) })
    .safeParse((await get(ctx, request, url)).body);
  if (!picked.success) throw unusable("jira");
  // "cs" holds matches for the typed text; history matches come after it.
  const sections = [...picked.data.sections].sort((a, b) => Number(b.id === "cs") - Number(a.id === "cs"));
  const exact = keyPrefix(text);
  // An issue whose key is exactly the typed key comes first.
  const keys = [...new Set(sections.flatMap(section => section.issues.map(issue => issue.key)).filter(isJiraTicketKey))]
    .sort((a, b) => Number(b === exact) - Number(a === exact));
  const wanted = keys.slice(0, ctx.limit);
  if (wanted.length === 0) return { sprint: null, issues: [], truncated: false };
  const found = await search(ctx, request, `key in (${wanted.join(", ")})`, wanted.length,
    "Jira rejected the search; an issue may have just been moved or deleted. Try again.");
  const order = new Map(wanted.map((key, index) => [key, index]));
  return { sprint: null, issues: found.issues.sort((a, b) => order.get(a.key)! - order.get(b.key)!), truncated: keys.length > wanted.length };
}

/** Development panel reads in flight at once, so a sprint with many pull requests stays within the time limit. */
const devStatusConcurrency = 10;

const devSummary = z.object({ summary: z.object({ pullrequest: z.object({
  byInstanceType: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/u), z.unknown()) }).optional() }) });

const devPullRequest = z.object({
  id: z.string(),
  url: z.string(),
  status: z.string(),
  source: z.object({ branch: z.string().min(1), url: z.string().optional() }),
  destination: z.object({ url: z.string().optional() }).optional(),
});
const devDetail = z.object({ detail: z.array(z.object({ pullRequests: z.array(devPullRequest).optional() })) });

/** The repository part of a branch address such as `<repository>/branch/<name>` or `<repository>/tree/<name>`. */
function branchRepository(url: string | undefined): string | null {
  const match = url === undefined ? null : /^(https:\/\/[^?#]+?)\/(?:branch|tree)\/[^?#]/u.exec(url);
  return match ? match[1]!.toLowerCase() : null;
}

/** One development panel pull request; null when Timber cannot read it as one. */
function devPullRequestLink(pull: z.infer<typeof devPullRequest>): LinkedPullRequest | null {
  let url: URL;
  try { url = new URL(pull.url); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const number = /\/(?:pull|pull-requests|merge_requests)\/([1-9][0-9]{0,9})\/?$/u.exec(url.pathname)?.[1]
    ?? (/^[1-9][0-9]{0,9}$/u.test(pull.id) ? pull.id : null);
  if (number === null) return null;
  const source = branchRepository(pull.source.url);
  const destination = branchRepository(pull.destination?.url);
  // The development panel has no draft flag; a fork shows as a source branch in another repository.
  return { number: Number(number), url: pull.url, branch: pull.source.branch,
    fromFork: source === null || destination === null ? null : source !== destination, draft: null };
}

/** Open pull requests on one issue's development panel, from every connected source. Null when any part is unreadable. */
async function devPanelPullRequests(ctx: ListContext, request: JiraRequest, issueId: string): Promise<LinkedPullRequest[] | null> {
  const summaryUrl = new URL(`${request.apiRoot}/rest/dev-status/latest/issue/summary`);
  summaryUrl.searchParams.set("issueId", issueId);
  const summary = devSummary.safeParse((await get(ctx, request, summaryUrl)).body);
  if (!summary.success) return null;
  const links: LinkedPullRequest[] = [];
  // The detail read needs the source type, such as GitHub or bitbucket, which only the summary names.
  for (const applicationType of Object.keys(summary.data.summary.pullrequest?.byInstanceType ?? {})) {
    const url = new URL(`${request.apiRoot}/rest/dev-status/latest/issue/detail`);
    url.searchParams.set("issueId", issueId);
    url.searchParams.set("applicationType", applicationType);
    url.searchParams.set("dataType", "pullrequest");
    const detail = devDetail.safeParse((await get(ctx, request, url)).body);
    if (!detail.success) return null;
    for (const pull of detail.data.detail.flatMap(entry => entry.pullRequests ?? [])) {
      if (pull.status !== "OPEN") continue;
      const link = devPullRequestLink(pull);
      if (link === null) return null;
      if (!links.some(known => known.url === link.url)) links.push(link);
    }
  }
  // Jira's search said this issue has an open pull request, so an empty panel is not a trustworthy answer.
  return links.length === 0 ? null : links;
}

/**
 * Reads the open pull requests on each issue's development panel. One search
 * per batch finds the issues Jira says have an open pull request; only those
 * are read further, a few at a time. An issue whose panel fails, or has not
 * been read yet, is null.
 */
async function jiraPullRequests(ctx: ListContext, request: JiraRequest, issues: readonly IssueSummary[], links: PullRequestLinks): Promise<void> {
  const byKey = new Map(issues.map(issue => [issue.key, issue]));
  const withPulls: { id: string; url: string }[] = [];
  await Promise.all(batches([...byKey.keys()]).map(async keys => {
    const found = new Set<string>();
    let token: string | null | undefined;
    do {
      const url = new URL(`${request.apiRoot}/rest/api/3/search/jql`);
      url.searchParams.set("jql", `key in (${keys.join(", ")}) AND development[pullrequests].open > 0`);
      url.searchParams.set("fields", "summary");
      url.searchParams.set("maxResults", "100");
      if (token) url.searchParams.set("nextPageToken", token);
      const page = z.object({ issues: z.array(z.object({ id: z.string().regex(/^[1-9][0-9]{0,18}$/u), key: z.string() })),
        nextPageToken: z.string().nullable().optional() }).safeParse((await get(ctx, request, url)).body);
      if (!page.success) throw unusable("jira");
      for (const match of page.data.issues) {
        const issue = byKey.get(match.key);
        if (issue !== undefined && !found.has(match.key)) {
          found.add(match.key);
          withPulls.push({ id: match.id, url: issue.url });
        }
      }
      token = page.data.nextPageToken;
    } while (token);
    // Issues the search did not match have no open pull request; the others stay unknown until their panel is read.
    for (const key of keys) if (!found.has(key)) links.set(byKey.get(key)!.url, []);
  }));
  let next = 0;
  const worker = async () => {
    while (next < withPulls.length) {
      const { id, url } = withPulls[next++]!;
      try { links.set(url, await devPanelPullRequests(ctx, request, id)); } catch (error) {
        if (ctx.signal.aborted) throw error;
        links.set(url, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(devStatusConcurrency, withPulls.length) }, worker));
}

/** One read-only Jira list. Returns null when a board is configured but has no active sprint. */
export async function listJira(query: IssueQuery, ctx: ListContext): Promise<IssueList | null> {
  const { board, sprintJql, project } = ctx.settings.jira;
  if (ctx.jira !== undefined) {
    if (query === "sprint" && board === undefined && sprintJql === undefined) {
      throw new NotConfigured("No Jira sprint is configured. Set [jira].board to a Scrum board, or [jira].sprint_jql.");
    }
    if (query === "open" && project === undefined) throw new NotConfigured("No Jira project is configured. Set [jira].project to a project key.");
  }
  const request = await jiraLogin(ctx.jira, ctx.runtime, ctx.signal);
  const scope = project === undefined ? "" : `project = "${project}" AND `;
  const read = async (): Promise<IssueList | null> => {
    if (query === "sprint") {
      if (board !== undefined) return boardSprint(ctx, request, board);
      const list = await search(ctx, request, sprintJql!, maxSprintIssues, "Jira rejected [jira].sprint_jql; check the query.");
      return { ...list, sprint: { name: null, source: "jira-jql" } };
    }
    if (query === "assigned") {
      return search(ctx, request, `${scope}assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, ctx.limit,
        "Jira rejected the assigned issues query; check [jira].project.");
    }
    if (query === "open") {
      return search(ctx, request, `${scope}statusCategory != Done ORDER BY created DESC`, ctx.limit,
        "Jira rejected the open issues query; check [jira].project.");
    }
    return pickerSearch(ctx, request, project);
  };
  const list = await read();
  // The account is read only when an issue has an assignee to compare; every issue in the assigned list is the login's.
  const account = list === null || query === "assigned"
    || !list.issues.some(issue => (assigneeIds.get(issue)?.length ?? 0) > 0) ? null
    : await myself(ctx, request).catch(error => { if (ctx.signal.aborted) throw error; return null; });
  return list && { ...list, pullRequests: (issues, links) => jiraPullRequests(ctx, request, issues, links),
    assignedToMe: issue => query === "assigned" ? true : mine(assigneeIds.get(issue), account, (a, b) => a === b) };
}
