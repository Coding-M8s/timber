import { z } from "zod";
import { githubHeaders, githubLogin, IssueReadFailure, json, send, unusable } from "../app-issue/trackers";
import type { IssueSummary, MissingWording } from "../app-issue/trackers";
import { jsonDisplay } from "../display";
import type { GithubRepository } from "../github/repository";
import { batches, keyPrefix, maxSprintIssues, NotConfigured, searchWords } from "./lists";
import type { IssueList, IssueQuery, LinkedPullRequest, ListContext, PullRequestLinks } from "./lists";

const api = "https://api.github.com";
const maxPages = 5;
const maxProjectPages = 20;

const restIssue = z.object({
  number: z.number().int().positive(),
  html_url: z.string(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  assignee: z.object({ login: z.string() }).nullable().optional(),
  pull_request: z.unknown().optional(),
});
type RestIssue = z.infer<typeof restIssue>;

const issueUrl = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/u;

function summary(number: number, url: string, title: string, open: boolean, assignee: string | null): IssueSummary {
  if (!issueUrl.test(url)) throw unusable("github");
  return { tracker: "github", key: String(number), url, title, assignee,
    status: open ? { name: "Open", category: "open" } : { name: "Closed", category: "closed" } };
}

const fromRest = (issue: RestIssue) => summary(issue.number, issue.html_url, issue.title, issue.state === "open", issue.assignee?.login ?? null);

const repositoryWording: MissingWording = {
  forbidden: "The GitHub login cannot read issues in this repository; check its access.",
  notFound: "GitHub has no repository at the selected remote, or it is hidden from this login.",
};

const repoPath = (repo: GithubRepository) => `${api}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

async function get(ctx: ListContext, token: string, url: string, wording = repositoryWording): Promise<{ body: unknown; next: string | null }> {
  const response = await send("github", ctx.runtime, url, { method: "GET", headers: githubHeaders(token) }, ctx.signal);
  const body = await json("github", response, undefined, wording);
  const next = /<([^>]+)>;\s*rel="next"/u.exec(response.headers.get("link") ?? "")?.[1] ?? null;
  // Follow only GitHub's own API; a next link elsewhere would send the login to another host.
  return { body, next: next !== null && next.startsWith(`${api}/`) ? next : null };
}

/** Pages through an issues listing, dropping pull requests, until `limit` issues are known to exist. */
async function listIssues(ctx: ListContext, token: string, first: string, limit: number, pages = maxPages): Promise<IssueList> {
  const issues: IssueSummary[] = [];
  let url: string | null = first;
  for (let page = 0; url !== null && page < pages && issues.length <= limit; page++) {
    const result = await get(ctx, token, url);
    const parsed = z.array(restIssue).safeParse(result.body);
    if (!parsed.success) throw unusable("github");
    issues.push(...parsed.data.filter(issue => issue.pull_request === undefined).map(fromRest));
    url = result.next;
  }
  return { sprint: null, issues: issues.slice(0, limit), truncated: issues.length > limit || url !== null };
}

async function assigned(ctx: ListContext, token: string, repo: GithubRepository): Promise<IssueList> {
  const user = z.object({ login: z.string().min(1) }).safeParse((await get(ctx, token, `${api}/user`)).body);
  if (!user.success) throw unusable("github");
  const url = new URL(`${repoPath(repo)}/issues`);
  for (const [key, value] of Object.entries({ state: "open", assignee: user.data.login, sort: "updated", direction: "desc", per_page: "100" })) {
    url.searchParams.set(key, value);
  }
  return listIssues(ctx, token, url.href, ctx.limit);
}

async function open(ctx: ListContext, token: string, repo: GithubRepository): Promise<IssueList> {
  return listIssues(ctx, token, `${repoPath(repo)}/issues?state=open&sort=created&direction=desc&per_page=100`, ctx.limit);
}

/** Open issues read for a search; the most recently updated come first. */
const searchPages = 3;

/**
 * Matches the exact issue number in any state, then open issues whose number
 * starts with the typed digits or whose title contains every typed word, in
 * any case and as part of a word. Matching is local, so typing never meets the
 * Search API's rate limit and typed text is never read as query syntax.
 */
async function search(ctx: ListContext, token: string, repo: GithubRepository): Promise<IssueList> {
  const words = searchWords(ctx.text).map(word => word.toLowerCase());
  if (words.length === 0) return { sprint: null, issues: [], truncated: false };
  const prefix = keyPrefix(ctx.text);
  const number = prefix !== null && /^[0-9]+$/u.test(prefix) ? prefix : null;
  const exact = async (): Promise<IssueSummary[]> => {
    if (number === null) return [];
    const response = await send("github", ctx.runtime, `${repoPath(repo)}/issues/${number}`,
      { method: "GET", headers: githubHeaders(token) }, ctx.signal);
    if (response.status === 404 || response.status === 410) { void response.body?.cancel().catch(() => {}); return []; }
    const parsed = restIssue.safeParse(await json("github", response, undefined, repositoryWording));
    if (!parsed.success) throw unusable("github");
    return parsed.data.pull_request === undefined ? [fromRest(parsed.data)] : [];
  };
  const listed = async (): Promise<{ issues: IssueSummary[]; more: boolean }> => {
    const issues: IssueSummary[] = [];
    let url: string | null = `${repoPath(repo)}/issues?state=open&sort=updated&direction=desc&per_page=100`;
    for (let page = 0; url !== null && page < searchPages; page++) {
      const result = await get(ctx, token, url);
      const parsed = z.array(restIssue).safeParse(result.body);
      if (!parsed.success) throw unusable("github");
      issues.push(...parsed.data.filter(issue => issue.pull_request === undefined).map(fromRest));
      url = result.next;
    }
    return { issues, more: url !== null };
  };
  const [first, open] = await Promise.all([exact(), listed()]);
  const byNumber = number === null ? [] : open.issues.filter(issue => issue.key.startsWith(number))
    .sort((a, b) => a.key.length - b.key.length || Number(a.key) - Number(b.key));
  const byTitle = open.issues.filter(issue => words.every(word => issue.title.toLowerCase().includes(word)));
  const seen = new Set<string>();
  const issues = [...first, ...byNumber, ...byTitle].filter(issue => !seen.has(issue.key) && !!seen.add(issue.key));
  return { sprint: null, issues: issues.slice(0, ctx.limit), truncated: issues.length > ctx.limit || open.more };
}

async function milestoneSprint(ctx: ListContext, token: string, repo: GithubRepository, title: string): Promise<IssueList> {
  let url: string | null = `${repoPath(repo)}/milestones?state=open&per_page=100`;
  let number: number | undefined;
  for (let page = 0; url !== null && number === undefined && page < maxPages; page++) {
    const result = await get(ctx, token, url);
    const parsed = z.array(z.object({ number: z.number().int().positive(), title: z.string() })).safeParse(result.body);
    if (!parsed.success) throw unusable("github");
    number = parsed.data.find(milestone => milestone.title === title)?.number;
    url = result.next;
  }
  if (number === undefined) {
    throw new IssueReadFailure("not-found", `GitHub has no open milestone named ${jsonDisplay(title)} in this repository; check [github].milestone.`);
  }
  const list = await listIssues(ctx, token, `${repoPath(repo)}/issues?milestone=${number}&state=open&per_page=100`,
    maxSprintIssues, Math.ceil(maxSprintIssues / 100) + 1);
  return { ...list, sprint: { name: title, source: "github-milestone" } };
}

const graphqlErrors = z.object({ errors: z.array(z.object({ type: z.string().optional() })).min(1) });

async function graphql(ctx: ListContext, token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const response = await send("github", ctx.runtime, `${api}/graphql`, {
    method: "POST", headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  }, ctx.signal);
  const body = await json("github", response, undefined, {
    forbidden: "The GitHub login cannot read this project; check its access.",
    notFound: "GitHub has no such project, or it is hidden from this login.",
  });
  const errors = graphqlErrors.safeParse(body);
  if (errors.success) {
    const types = errors.data.errors.map(error => error.type);
    if (types.includes("NOT_FOUND")) throw new IssueReadFailure("not-found", "GitHub has no project at [github].project, or it is hidden from this login.");
    if (types.includes("INSUFFICIENT_SCOPES")) {
      throw new IssueReadFailure("forbidden", "The GitHub login cannot read Projects. Run gh auth refresh -s read:project, or use a token with project read access.");
    }
    if (types.includes("FORBIDDEN")) throw new IssueReadFailure("forbidden", "The GitHub login cannot read this project; check its access.");
    if (types.includes("RATE_LIMITED")) throw new IssueReadFailure("failed", "GitHub is rate limiting requests; try again later.");
    throw new IssueReadFailure("failed", "GitHub could not answer the project query; try again later.");
  }
  return body;
}

const fieldsQuery = `query TimberProjectIterations($owner: String!, $number: Int!) {
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) {
    fields(first: 50) { nodes { ... on ProjectV2IterationField { name configuration { iterations { id title startDate duration } } } } }
  } } }
}`;

const itemsQuery = `query TimberProjectItems($owner: String!, $number: Int!, $field: String!, $after: String) {
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) {
    items(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        fieldValueByName(name: $field) { ... on ProjectV2ItemFieldIterationValue { iterationId } }
        content { ... on Issue { number url title state assignees(first: 1) { nodes { login } } } }
      }
    }
  } } }
}`;

const project = <T extends z.ZodType>(inner: T) => z.object({ data: z.object({
  repositoryOwner: z.object({ projectV2: inner.nullable().optional() }).nullable(),
}) });

const iterationField = z.object({ name: z.string(), configuration: z.object({ iterations: z.array(z.object({
  id: z.string(), title: z.string(), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), duration: z.number().int().nonnegative(),
})) }) });

const itemsPage = z.object({ items: z.object({
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  nodes: z.array(z.object({
    fieldValueByName: z.object({ iterationId: z.string().optional() }).nullable().optional(),
    content: z.object({ number: z.number().optional(), url: z.string().optional(), title: z.string().optional(),
      state: z.string().optional(), assignees: z.object({ nodes: z.array(z.object({ login: z.string() })) }).optional() }).nullable().optional(),
  }).nullable()),
}) });

/** The iteration whose dates include today in local time: start date inclusive, start plus duration exclusive. */
export function currentIteration<T extends { startDate: string; duration: number }>(iterations: readonly T[], now: Date): T | undefined {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return iterations.find(iteration => {
    const start = Date.parse(`${iteration.startDate}T00:00:00Z`);
    return start <= today && today < start + iteration.duration * 86_400_000;
  });
}

async function iterationSprint(ctx: ListContext, token: string, setting: string): Promise<IssueList | null> {
  const [owner, numberText] = setting.split("/") as [string, string];
  const variables = { owner, number: Number(numberText) };
  const fields = project(z.object({ fields: z.object({ nodes: z.array(z.unknown()) }) }))
    .safeParse(await graphql(ctx, token, fieldsQuery, variables));
  if (!fields.success) throw unusable("github");
  const board = fields.data.data.repositoryOwner?.projectV2;
  if (!board) throw new IssueReadFailure("not-found", "GitHub has no project at [github].project, or it is hidden from this login.");
  const field = board.fields.nodes.map(node => iterationField.safeParse(node)).find(result => result.success)?.data;
  if (!field) throw new NotConfigured("The GitHub project at [github].project has no iteration field.");
  const iteration = currentIteration(field.configuration.iterations, ctx.now());
  if (!iteration) return null;

  const issues: IssueSummary[] = [];
  let after: string | null = null;
  let more = true;
  for (let page = 0; more && page < maxProjectPages && issues.length <= maxSprintIssues; page++) {
    const parsed = project(itemsPage).safeParse(await graphql(ctx, token, itemsQuery, { ...variables, field: field.name, after }));
    if (!parsed.success || !parsed.data.data.repositoryOwner?.projectV2) throw unusable("github");
    const { items } = parsed.data.data.repositoryOwner.projectV2;
    for (const node of items.nodes) {
      const content = node?.content;
      // Pull requests and draft items have no issue number; they are not issues.
      if (node?.fieldValueByName?.iterationId !== iteration.id || content?.number === undefined) continue;
      if (content.url === undefined || content.title === undefined || content.state === undefined) throw unusable("github");
      issues.push(summary(content.number, content.url, content.title, content.state === "OPEN", content.assignees?.nodes[0]?.login ?? null));
    }
    more = items.pageInfo.hasNextPage;
    after = items.pageInfo.endCursor;
  }
  return { sprint: { name: iteration.title, source: "github-iteration" },
    issues: issues.slice(0, maxSprintIssues), truncated: issues.length > maxSprintIssues || more };
}

const pullUrl = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u;
const pullRequestsPerIssue = 20;
const linkedPullRequest = z.object({
  number: z.number().int().positive(),
  url: z.string().regex(pullUrl),
  state: z.string(),
  isDraft: z.boolean(),
  isCrossRepository: z.boolean(),
  headRefName: z.string().min(1),
});
const closingReferences = z.object({ closedByPullRequestsReferences: z.object({
  totalCount: z.number().int().nonnegative(), nodes: z.array(linkedPullRequest) }) });

/** Open pull requests linked to one issue; null when the answer is missing, unreadable or cut short. */
function openPullRequests(node: unknown): LinkedPullRequest[] | null {
  const parsed = closingReferences.safeParse(node);
  if (!parsed.success) return null;
  const { totalCount, nodes } = parsed.data.closedByPullRequestsReferences;
  if (totalCount > nodes.length) return null;
  // includeClosedPrs: false still returns merged pull requests.
  return nodes.filter(pull => pull.state === "OPEN").map(pull => ({ number: pull.number, url: pull.url,
    branch: pull.headRefName, fromFork: pull.isCrossRepository, draft: pull.isDraft }));
}

/**
 * Reads the pull requests GitHub links to each issue: those that close it or
 * were linked in its Development section. One GraphQL query per batch of
 * issues, grouped by repository; an issue GitHub does not answer for is null.
 */
async function githubPullRequests(ctx: ListContext, token: string, issues: readonly IssueSummary[], links: PullRequestLinks): Promise<void> {
  const unique = [...new Map(issues.map(issue => [issue.url, issue])).values()];
  await Promise.all(batches(unique).map(async batch => {
    const repositories = new Map<string, { owner: string; name: string; issues: IssueSummary[] }>();
    for (const issue of batch) {
      const [, owner, name] = new URL(issue.url).pathname.split("/") as [string, string, string];
      const key = `${owner}/${name}`.toLowerCase();
      const repository = repositories.get(key) ?? { owner, name, issues: [] };
      repository.issues.push(issue);
      repositories.set(key, repository);
    }
    const grouped = [...repositories.values()];
    const variables: Record<string, string> = {};
    const parts = grouped.map((repository, index) => {
      variables[`o${index}`] = repository.owner;
      variables[`n${index}`] = repository.name;
      // Issue numbers come from validated issue URLs, so they are plain digits.
      const fields = repository.issues.map(issue => `i${issue.key}: issue(number: ${issue.key}) { closedByPullRequestsReferences(first: ${pullRequestsPerIssue}, includeClosedPrs: false) { totalCount nodes { number url state isDraft isCrossRepository headRefName } } }`);
      return `r${index}: repository(owner: $o${index}, name: $n${index}) { ${fields.join(" ")} }`;
    });
    const declarations = Object.keys(variables).map(name => `$${name}: String!`).join(", ");
    const response = await send("github", ctx.runtime, `${api}/graphql`, {
      method: "POST", headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query TimberIssuePullRequests(${declarations}) { ${parts.join(" ")} }`, variables }),
    }, ctx.signal);
    const body = await json("github", response, undefined, repositoryWording);
    // GitHub answers what it can; a missing repository or issue is null beside an error.
    const parsed = z.object({ data: z.record(z.string(), z.record(z.string(), z.unknown()).nullable()) }).safeParse(body);
    if (!parsed.success) throw unusable("github");
    grouped.forEach((repository, index) => {
      const answered = parsed.data.data[`r${index}`];
      for (const issue of repository.issues) links.set(issue.url, answered ? openPullRequests(answered[`i${issue.key}`]) : null);
    });
  }));
}

/** One read-only GitHub list. Returns null when a sprint is configured but none is current. */
export async function listGithub(query: IssueQuery, ctx: ListContext): Promise<IssueList | null> {
  const { project: projectSetting, milestone } = ctx.settings.github;
  if (query === "sprint" && projectSetting === undefined && milestone === undefined) {
    throw new NotConfigured("No GitHub sprint is configured. Set [github].project to a Projects board with an iteration field, or [github].milestone.");
  }
  // The repository is local Git state, read before the login so a bad remote never reads one.
  const repo = query === "sprint" && projectSetting !== undefined ? null : await ctx.githubRepository();
  const token = await githubLogin(ctx.runtime, ctx.signal);
  const read = (): Promise<IssueList | null> => {
    if (query === "sprint") {
      return projectSetting !== undefined ? iterationSprint(ctx, token, projectSetting) : milestoneSprint(ctx, token, repo!, milestone!);
    }
    if (query === "assigned") return assigned(ctx, token, repo!);
    if (query === "open") return open(ctx, token, repo!);
    return search(ctx, token, repo!);
  };
  const list = await read();
  return list && { ...list, pullRequests: (issues, links) => githubPullRequests(ctx, token, issues, links) };
}
