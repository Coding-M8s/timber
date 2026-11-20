import { z } from "zod";
import { IssueReadFailure, jiraCategories, jiraLogin, json, send, unusable } from "../app-issue/trackers";
import type { IssueSummary, MissingWording } from "../app-issue/trackers";
import { isJiraTicketKey } from "../jira/branch";
import { keyPrefix, maxSprintIssues, NotConfigured } from "./lists";
import type { IssueList, IssueQuery, ListContext } from "./lists";

type JiraRequest = Awaited<ReturnType<typeof jiraLogin>>;

const fields = "summary,status,assignee";
const listIssue = z.object({
  key: z.string().refine(isJiraTicketKey),
  fields: z.object({
    summary: z.string(),
    status: z.object({ name: z.string(), statusCategory: z.object({ key: z.string() }) }),
    assignee: z.object({ displayName: z.string() }).nullable().optional(),
  }),
});

const siteWording: MissingWording = {
  forbidden: "The Jira login cannot read these issues; check its access to the project.",
  notFound: "Jira has no such board or project, or it is hidden from this login.",
};

function summary(request: JiraRequest, issue: z.infer<typeof listIssue>): IssueSummary {
  const { fields: value } = issue;
  const key = value.status.statusCategory.key;
  return { tracker: "jira", key: issue.key, url: `${request.siteOrigin}/browse/${issue.key}`, title: value.summary,
    assignee: value.assignee?.displayName.trim() || null,
    // Jira reserves "undefined" for statuses outside the three groups; they are not started.
    status: { name: value.status.name, category: key in jiraCategories ? jiraCategories[key as keyof typeof jiraCategories] : "open" } };
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
}
