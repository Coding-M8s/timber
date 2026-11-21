import { z } from "zod";
import { IssueReadFailure, json, linearCategories, linearLogin, send, throwLinearErrors, unusable } from "../app-issue/trackers";
import type { IssueSummary } from "../app-issue/trackers";
import { isJiraTicketKey } from "../jira/branch";
import { missingIssue } from "../linear/client";
import { pullUrl } from "./github";
import { batches, keyPrefix, maxSprintIssues, NotConfigured } from "./lists";
import type { IssueList, IssueQuery, LinkedPullRequest, ListContext, PullRequestLinks } from "./lists";

const issueFields = "id identifier url title state { name type } assignee { displayName isMe }";
const closedTypes = ["completed", "canceled", "duplicate"];

const node = z.object({
  id: z.string().min(1),
  identifier: z.string().refine(isJiraTicketKey),
  url: z.string().refine(value => { try { return new URL(value).hostname === "linear.app"; } catch { return false; } }),
  title: z.string(),
  state: z.object({ name: z.string(), type: z.string() }),
  assignee: z.object({ displayName: z.string(), isMe: z.boolean().optional() }).nullable().optional(),
});
const connection = z.object({ pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable().optional() }).optional(),
  nodes: z.array(node) });

type Node = z.infer<typeof node>;
/** Turns a listed node into a summary, remembering its Linear id for the pull request read. */
type Summarize = (issue: Node) => IssueSummary;

const toSummary = (issue: Node): IssueSummary => ({
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

async function cycle(ctx: ListContext, token: string, team: string, summary: Summarize): Promise<IssueList | null> {
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

async function listed(ctx: ListContext, token: string, kind: "assigned" | "open", team: string | undefined, summary: Summarize): Promise<IssueList> {
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

async function search(ctx: ListContext, token: string, team: string | undefined, summary: Summarize): Promise<IssueList> {
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

const pullRequestsPerIssue = 20;
const pullMetadata = z.object({
  number: z.number().int().positive(),
  branch: z.string().min(1),
  draft: z.boolean().optional(),
  status: z.string().optional(),
  closedAt: z.string().nullable(),
  mergedAt: z.string().nullable(),
});
const attachments = data(z.object({ issues: z.object({ nodes: z.array(z.object({
  id: z.string(),
  attachments: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(z.object({ url: z.string(), metadata: z.unknown() })) }),
})) }) }));

/** Open pull requests among one issue's GitHub attachments; null when one cannot be read or some were left out. */
function openPullRequests(found: z.infer<typeof attachments>["data"]["issues"]["nodes"][number]): LinkedPullRequest[] | null {
  if (found.attachments.pageInfo.hasNextPage) return null;
  const links: LinkedPullRequest[] = [];
  for (const attachment of found.attachments.nodes) {
    // The GitHub integration also attaches issues and commits; only pull requests count.
    if (!pullUrl.test(attachment.url)) continue;
    const pull = pullMetadata.safeParse(attachment.metadata);
    if (!pull.success) return null;
    const { number, branch, draft, status, closedAt, mergedAt } = pull.data;
    if (closedAt !== null || mergedAt !== null || status === "closed" || status === "merged") continue;
    // Linear does not record the head repository, so a fork cannot be told apart.
    links.push({ number, url: attachment.url, branch, fromFork: null, draft: draft ?? null });
  }
  return links;
}

/**
 * Reads the pull requests Linear's GitHub integration attached to each issue.
 * One query per 100 issues; an issue Linear does not return is null.
 */
async function linearPullRequests(ctx: ListContext, token: string, ids: ReadonlyMap<string, string>,
  issues: readonly IssueSummary[], links: PullRequestLinks): Promise<void> {
  const wanted = [...new Map(issues.flatMap(issue => {
    const id = ids.get(issue.url);
    return id === undefined ? [] : [[id, issue.url] as const];
  })).entries()];
  await Promise.all(batches(wanted).map(async batch => {
    const body = await graphql(ctx, token, `query TimberLinearPullRequests($ids: [ID!], $first: Int!) {
      issues(first: $first, filter: { id: { in: $ids } }) { nodes { id
        attachments(first: ${pullRequestsPerIssue}, filter: { sourceType: { eq: "github" } }) { pageInfo { hasNextPage } nodes { url metadata } } } } }`,
    { ids: batch.map(([id]) => id), first: batch.length });
    const parsed = attachments.safeParse(body);
    if (!parsed.success) throw unusable("linear");
    const answered = new Map(parsed.data.data.issues.nodes.map(found => [found.id, found]));
    for (const [id, url] of batch) {
      const found = answered.get(id);
      links.set(url, found === undefined ? null : openPullRequests(found));
    }
  }));
}

/** One read-only Linear list. Returns null when the team has no active cycle. */
export async function listLinear(query: IssueQuery, ctx: ListContext): Promise<IssueList | null> {
  const { team } = ctx.settings.linear;
  if ((query === "sprint" || query === "open") && team === undefined) {
    throw new NotConfigured("No Linear team is configured. Set [linear].team to a team key.");
  }
  const token = await linearLogin(ctx.runtime, ctx.signal);
  const ids = new Map<string, string>();
  const assigned = new Map<string, boolean | null>();
  const summarize: Summarize = issue => {
    ids.set(issue.url, issue.id);
    assigned.set(issue.url, issue.assignee === undefined ? null : issue.assignee === null ? false : issue.assignee.isMe ?? null);
    return toSummary(issue);
  };
  const list = query === "sprint" ? await cycle(ctx, token, team!, summarize)
    : query === "assigned" || query === "open" ? await listed(ctx, token, query, team, summarize)
      : await search(ctx, token, team, summarize);
  return list && { ...list, pullRequests: (issues, links) => linearPullRequests(ctx, token, ids, issues, links),
    assignedToMe: issue => assigned.get(issue.url) ?? null };
}
