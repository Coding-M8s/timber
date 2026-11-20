import { z } from "zod";
import { IssueReadFailure, json, linearCategories, linearLogin, send, throwLinearErrors, unusable } from "../app-issue/trackers";
import type { IssueSummary } from "../app-issue/trackers";
import { isJiraTicketKey } from "../jira/branch";
import { missingIssue } from "../linear/client";
import { keyPrefix, maxSprintIssues, NotConfigured } from "./lists";
import type { IssueList, IssueQuery, ListContext } from "./lists";

const issueFields = "identifier url title state { name type } assignee { displayName }";
const closedTypes = ["completed", "canceled", "duplicate"];

const node = z.object({
  identifier: z.string().refine(isJiraTicketKey),
  url: z.string().refine(value => { try { return new URL(value).hostname === "linear.app"; } catch { return false; } }),
  title: z.string(),
  state: z.object({ name: z.string(), type: z.string() }),
  assignee: z.object({ displayName: z.string() }).nullable().optional(),
});
const connection = z.object({ pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable().optional() }).optional(),
  nodes: z.array(node) });

const summary = (issue: z.infer<typeof node>): IssueSummary => ({
  tracker: "linear", key: issue.identifier, url: issue.url, title: issue.title,
  assignee: issue.assignee?.displayName.trim() || null,
  status: { name: issue.state.name, category: linearCategories[issue.state.type] ?? "open" },
});

async function graphql(ctx: ListContext, token: string, query: string, variables: Record<string, unknown>,
  allowMissing = false): Promise<unknown> {
  const response = await send("linear", ctx.runtime, "https://api.linear.app/graphql", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query, variables }),
  }, ctx.signal);
  // Linear reports a missing issue and some login problems as GraphQL errors with HTTP 400.
  const body = await json("linear", response, status => status === 400);
  if (allowMissing && missingIssue(body)) return null;
  throwLinearErrors(body, "The Linear login cannot read these issues; check its team access.");
  if (!response.ok) throw unusable("linear");
  return body;
}

const data = <T extends z.ZodType>(inner: T) => z.object({ data: inner });

function teamFilter(team: string | undefined): Record<string, unknown> {
  return team === undefined ? {} : { team: { key: { eq: team } } };
}

async function cycle(ctx: ListContext, token: string, team: string): Promise<IssueList | null> {
  const query = `query TimberLinearCycle($team: String!, $after: String) {
    teams(first: 1, filter: { key: { eq: $team } }) { nodes { activeCycle { name number
      issues(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${issueFields} } } } } } }`;
  const issues: IssueSummary[] = [];
  let after: string | null = null;
  let more = true;
  let name: string | null = null;
  for (let page = 0; more && issues.length <= maxSprintIssues && page < 10; page++) {
    const parsed = data(z.object({ teams: z.object({ nodes: z.array(z.object({ activeCycle: z.object({
      name: z.string().nullable().optional(), number: z.number(), issues: connection }).nullable() })) }) }))
      .safeParse(await graphql(ctx, token, query, { team, after }));
    if (!parsed.success) throw unusable("linear");
    const found = parsed.data.data.teams.nodes[0];
    if (!found) throw new IssueReadFailure("not-found", "Linear has no team with the key in [linear].team, or it is hidden from this login.");
    if (!found.activeCycle) return null;
    name = found.activeCycle.name?.trim() || `Cycle ${found.activeCycle.number}`;
    issues.push(...found.activeCycle.issues.nodes.map(summary));
    more = found.activeCycle.issues.pageInfo?.hasNextPage ?? false;
    after = found.activeCycle.issues.pageInfo?.endCursor ?? null;
  }
  return { sprint: { name, source: "linear-cycle" }, issues: issues.slice(0, maxSprintIssues), truncated: more || issues.length > maxSprintIssues };
}

async function listed(ctx: ListContext, token: string, kind: "assigned" | "open", team: string | undefined): Promise<IssueList> {
  const filter = { state: { type: { nin: closedTypes } }, ...teamFilter(team) };
  const query = kind === "assigned"
    ? `query TimberLinearAssigned($first: Int!, $filter: IssueFilter) { viewer { assignedIssues(first: $first, orderBy: updatedAt, filter: $filter) { pageInfo { hasNextPage } nodes { ${issueFields} } } } }`
    : `query TimberLinearOpen($first: Int!, $filter: IssueFilter) { issues(first: $first, orderBy: createdAt, filter: $filter) { pageInfo { hasNextPage } nodes { ${issueFields} } } }`;
  const body = await graphql(ctx, token, query, { first: ctx.limit, filter });
  const parsed = kind === "assigned"
    ? data(z.object({ viewer: z.object({ assignedIssues: connection }) })).safeParse(body)
    : data(z.object({ issues: connection })).safeParse(body);
  if (!parsed.success) throw unusable("linear");
  const result = "viewer" in parsed.data.data ? parsed.data.data.viewer.assignedIssues : parsed.data.data.issues;
  return { sprint: null, issues: result.nodes.map(summary).slice(0, ctx.limit), truncated: result.pageInfo?.hasNextPage ?? false };
}

async function search(ctx: ListContext, token: string, team: string | undefined): Promise<IssueList> {
  const text = ctx.text.trim();
  if (text.length === 0) return { sprint: null, issues: [], truncated: false };
  const key = keyPrefix(text);
  const exact = async (): Promise<IssueSummary[]> => {
    if (key === null || !isJiraTicketKey(key)) return [];
    const body = await graphql(ctx, token, `query TimberLinearKey($id: String!) { issue(id: $id) { ${issueFields} } }`, { id: key }, true);
    if (body === null) return [];
    const parsed = data(z.object({ issue: node.nullable() })).safeParse(body);
    if (!parsed.success) throw unusable("linear");
    return parsed.data.data.issue ? [summary(parsed.data.data.issue)] : [];
  };
  const terms = async (): Promise<{ issues: IssueSummary[]; more: boolean }> => {
    const body = await graphql(ctx, token, `query TimberLinearSearch($term: String!, $first: Int!, $filter: IssueFilter) {
      searchIssues(term: $term, first: $first, filter: $filter) { pageInfo { hasNextPage } nodes { ${issueFields} } } }`,
    { term: text, first: ctx.limit, filter: teamFilter(team) });
    const parsed = data(z.object({ searchIssues: connection })).safeParse(body);
    if (!parsed.success) throw unusable("linear");
    return { issues: parsed.data.data.searchIssues.nodes.map(summary), more: parsed.data.data.searchIssues.pageInfo?.hasNextPage ?? false };
  };
  const [first, rest] = await Promise.all([exact(), terms()]);
  const issues = [...first, ...rest.issues.filter(issue => !first.some(found => found.key === issue.key))];
  return { sprint: null, issues: issues.slice(0, ctx.limit), truncated: rest.more || issues.length > ctx.limit };
}

/** One read-only Linear list. Returns null when the team has no active cycle. */
export async function listLinear(query: IssueQuery, ctx: ListContext): Promise<IssueList | null> {
  const { team } = ctx.settings.linear;
  if ((query === "sprint" || query === "open") && team === undefined) {
    throw new NotConfigured("No Linear team is configured. Set [linear].team to a team key.");
  }
  const token = await linearLogin(ctx.runtime, ctx.signal);
  if (query === "sprint") return cycle(ctx, token, team!);
  if (query === "assigned" || query === "open") return listed(ctx, token, query, team);
  return search(ctx, token, team);
}
