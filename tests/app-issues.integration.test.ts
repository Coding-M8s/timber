import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { snapshot } from "./helpers/snapshot";
import { currentIteration } from "../src/app-issues/github";
import { issueIdentity, readAppIssues } from "../src/app-issues/read";
import type { AppIssuesOptions, AppIssuesRecord, AppIssuesServices } from "../src/app-issues/read";
import { keyPrefix, searchWords } from "../src/app-issues/lists";
import { loadRepositoryConfig, parseConfigSource } from "../src/config";
import { resolveGithubRepository } from "../src/github/repository";
import { readIssueLink, writeIssueLink } from "../src/git/issue-link";
import type { IssueLink } from "../src/git/issue-link";
import { discoverRepository } from "../src/git/repository";
import { listWorktreeInventory, listWorktrees } from "../src/git/worktrees";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const githubToken = "ghp_SECRET_GITHUB_7c2f";
const linearToken = "lin_api_SECRET_LINEAR_41ab";
const jiraToken = "SECRET_JIRA_TOKEN_93de";
const jiraEmail = "secret.person@example.invalid";
const secrets = [githubToken, linearToken, jiraToken, jiraEmail, Buffer.from(`${jiraEmail}:${jiraToken}`).toString("base64")];

const links: Record<string, IssueLink> = {
  github: { tracker: "github", key: "42", url: "https://github.com/acme/widgets/issues/42" },
  jira: { tracker: "jira", key: "ENG-7", url: "https://acme.atlassian.net/browse/ENG-7" },
  linear: { tracker: "linear", key: "LIN-3", url: "https://linear.app/acme/issue/LIN-3/fix-the-thing" },
};

const settings = `default_tracker = "jira"
[jira]
site_url = "https://acme.atlassian.net"
board = 12
project = "ENG"
[github]
project = "acme/5"
[linear]
team = "LIN"
`;

interface Seen { requests: { url: string; init: RequestInit }[]; logins: number }
type Answer = (url: URL, init: RequestInit) => Response | Promise<Response>;
const fresh = (): Seen => ({ requests: [], logins: 0 });
const noFetch: Answer = () => { throw new Error("must not fetch"); };

/** Real Git reads; trackers answer through `answer`, and every login read is counted. */
function services(seen: Seen, home: string, answer: Answer, overrides: Partial<AppIssuesServices["trackers"]> = {},
  timeoutMs = 5_000): AppIssuesServices {
  const env = { XDG_CONFIG_HOME: join(home, "config"), JIRA_EMAIL: jiraEmail, JIRA_API_TOKEN: jiraToken };
  return {
    discoverRepository: cwd => discoverRepository(cwd),
    loadConfig: repository => loadRepositoryConfig(repository, env),
    listWorktreeInventory: repository => listWorktreeInventory(repository),
    readIssueLink: (repository, tree) => readIssueLink(repository, tree),
    githubRepository: (repository, config) => resolveGithubRepository(repository, config),
    timeoutMs,
    now: () => new Date(2026, 10, 20, 12),
    trackers: {
      env,
      fetch: async (url, init) => { seen.requests.push({ url, init }); return answer(new URL(url), init); },
      githubToken: async () => { seen.logins++; return githubToken; },
      linearToken: async () => { seen.logins++; return linearToken; },
      jiraCredentials: async () => { seen.logins++; return null; },
      ...overrides,
    },
  };
}

/** One linked worktree per tracker and an unlinked one, beside settings for every list. */
async function withFixture(run: (fixture: { primary: string; directory: string; paths: Record<string, string>; all: string[] }) => Promise<void>) {
  await withRepository(async (primary, directory) => {
    await git(primary, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    await writeFile(join(primary, ".timber.toml"), settings);
    await mkdir(join(directory, "config"));
    const paths: Record<string, string> = {};
    for (const name of ["github", "jira", "linear", "unlinked"]) {
      paths[name] = join(directory, `tree ${name}`);
      await git(primary, "worktree", "add", "-b", `feature/${name}`, paths[name]!);
    }
    const repository = await discoverRepository(primary);
    const trees = await listWorktrees(repository);
    for (const name of ["github", "jira", "linear"]) {
      await writeIssueLink(repository, trees.find(tree => tree.path === paths[name])!, links[name]!);
    }
    await writeFile(join(paths.github!, "untracked.txt"), "keep me\n");
    await run({ primary, directory, paths, all: [primary, ...Object.values(paths)] });
  });
}

const restIssue = (number: number, state = "open", repo = "acme/widgets", extra: object = {}) => ({ number, state,
  title: `Issue ${number}`, html_url: `https://github.com/${repo}/issues/${number}`, assignee: { login: "octo" }, ...extra });
const jiraIssue = (key: string, category = "new", name = "To Do") => ({ key,
  fields: { summary: `Title ${key}`, status: { name, statusCategory: { key: category } }, assignee: { displayName: "Ada" } } });
const linearNode = (key: string, type = "unstarted") => ({ id: `id-${key}`, identifier: key, url: `https://linear.app/acme/issue/${key}/x`,
  title: `Title ${key}`, state: { name: type === "started" ? "In Progress" : "Todo", type }, assignee: null });
const graphqlBody = (init: RequestInit) => JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };

const iterations = [
  { id: "past", title: "Sprint 1", startDate: "2026-11-02", duration: 14 },
  { id: "now", title: "Sprint 2", startDate: "2026-11-16", duration: 14 },
];
const githubPull = (number: number, extra: object = {}) => ({ number, url: `https://github.com/acme/widgets/pull/${number}`,
  state: "OPEN", isDraft: false, isCrossRepository: false, headRefName: `fix-${number}`, ...extra });

/** Answers the linked pull requests query from `byIssue`, keyed by issue URL; an issue not named has none, null has no answer. */
function githubLinks(init: RequestInit, byIssue: Record<string, object[] | null | { totalCount: number; nodes: object[] }> = {}): Response {
  const { query, variables } = graphqlBody(init);
  expect(query).toStartWith("query TimberIssuePullRequests(");
  expect(query).not.toContain("mutation");
  const data: Record<string, Record<string, unknown>> = {};
  for (const part of query.split(/ (?=r[0-9]+: repository\()/u).slice(1)) {
    const index = /^r([0-9]+)/u.exec(part)![1]!;
    const repo = `${variables[`o${index}`]}/${variables[`n${index}`]}`;
    const answers: Record<string, unknown> = {};
    for (const [, number] of part.matchAll(/i([0-9]+): issue\(number: \1\)/gu)) {
      const url = `https://github.com/${repo}/issues/${number}`;
      const nodes = url in byIssue ? byIssue[url]! : [];
      answers[`i${number}`] = nodes === null ? null
        : { closedByPullRequestsReferences: Array.isArray(nodes) ? { totalCount: nodes.length, nodes } : nodes };
    }
    data[`r${index}`] = answers;
  }
  return Response.json({ data });
}

const sprintPulls = {
  "https://github.com/acme/widgets/issues/42": [githubPull(50), githubPull(51, { state: "MERGED" }),
    githubPull(52, { isDraft: true, isCrossRepository: true, headRefName: "patch-1" })],
  "https://github.com/other/repo/issues/42": [githubPull(7, { url: "https://github.com/other/repo/pull/7" })],
};

const githubSprint: Answer = (url, init) => {
  if (url.href === "https://api.github.com/user") return Response.json({ login: "Octo" });
  expect(url.href).toBe("https://api.github.com/graphql");
  const { query, variables } = graphqlBody(init);
  if (query.includes("TimberIssuePullRequests")) return githubLinks(init, sprintPulls);
  expect(variables).toMatchObject({ owner: "acme", number: 5 });
  if (query.includes("TimberProjectIterations")) {
    return Response.json({ data: { repositoryOwner: { projectV2: { fields: { nodes: [{}, { name: "Iteration", configuration: { iterations } }] } } } } });
  }
  expect(variables.field).toBe("Iteration");
  const item = (iterationId: string | null, content: object | null) => ({ fieldValueByName: iterationId === null ? null : { iterationId }, content });
  const issue = (number: number, state: string, repo = "acme/widgets") => ({ number, url: `https://github.com/${repo}/issues/${number}`,
    title: `Issue ${number}`, state, assignees: { nodes: [{ login: "octo" }] } });
  if (variables.after === null) {
    return Response.json({ data: { repositoryOwner: { projectV2: { items: { pageInfo: { hasNextPage: true, endCursor: "c1" },
      nodes: [item("now", issue(42, "OPEN")), item("past", issue(41, "OPEN")), item("now", {}), item(null, issue(40, "OPEN"))] } } } } });
  }
  return Response.json({ data: { repositoryOwner: { projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [item("now", issue(43, "CLOSED")), item("now", issue(42, "OPEN", "other/repo"))] } } } } });
};

const bitbucketPull = (id: string, status = "OPEN") => ({ id, status, name: "Fix", url: `https://bitbucket.org/acme/widgets/pull-requests/${id}`,
  source: { branch: "ENG-7-fix", url: "https://bitbucket.org/acme/widgets/branch/ENG-7-fix" },
  destination: { branch: "main", url: "https://bitbucket.org/acme/widgets/branch/main" } });
const forkPull = { id: "#12", status: "OPEN", url: "https://github.com/acme/widgets/pull/12",
  source: { branch: "patch-1", url: "https://github.com/someone/widgets/tree/patch-1" },
  destination: { branch: "main", url: "https://github.com/acme/widgets/tree/main" } };

/** The development panel: `ids` maps keys with an open pull request to issue IDs, `panels` maps an issue ID to its sources. */
function jiraPanel(url: URL, ids: Record<string, string>, panels: Record<string, Record<string, object[]> | null>): Response | null {
  if (url.pathname === "/rest/api/3/search/jql" && url.searchParams.get("jql")!.includes("development")) {
    const keys = /^key in \((.*)\) AND development\[pullrequests\]\.open > 0$/u.exec(url.searchParams.get("jql")!)![1]!.split(", ");
    return Response.json({ issues: keys.filter(key => key in ids).map(key => ({ id: ids[key], key })) });
  }
  if (!url.pathname.startsWith("/rest/dev-status/latest/issue/")) return null;
  const panel = panels[url.searchParams.get("issueId")!];
  if (panel === null || panel === undefined) return new Response(null, { status: 500 });
  if (url.pathname.endsWith("/summary")) {
    return Response.json({ summary: { pullrequest: { overall: { count: 1 }, byInstanceType: Object.fromEntries(Object.keys(panel).map(type => [type, {}])) } } });
  }
  expect(url.pathname).toEndWith("/detail");
  expect(url.searchParams.get("dataType")).toBe("pullrequest");
  return Response.json({ errors: [], detail: [{ pullRequests: panel[url.searchParams.get("applicationType")!] }] });
}

const jiraSprint: Answer = url => {
  const panel = jiraPanel(url, { "ENG-7": "10007" }, { 10007: { bitbucket: [bitbucketPull("1633"), bitbucketPull("1600", "MERGED")], GitHub: [forkPull] } });
  if (panel !== null) return panel;
  if (url.pathname === "/rest/agile/1.0/board/12/sprint") {
    expect(url.searchParams.get("state")).toBe("active");
    return Response.json({ values: [{ id: 301, name: "ENG Sprint 9" }] });
  }
  expect(url.pathname).toBe("/rest/api/3/search/jql");
  expect(url.searchParams.get("jql")).toBe("sprint in (301) ORDER BY Rank ASC");
  if (!url.searchParams.has("nextPageToken")) {
    return Response.json({ issues: [jiraIssue("ENG-7", "indeterminate", "In Review"), jiraIssue("ENG-8")], nextPageToken: "p2" });
  }
  return Response.json({ issues: [jiraIssue("ENG-9", "done", "Done"), jiraIssue("ENG-10", "undefined", "Odd")] });
};

const linearPull = (number: number, extra: object = {}) => ({ url: `https://github.com/acme/widgets/pull/${number}`, metadata: {
  number, branch: `lin-${number}`, draft: false, status: "open", closedAt: null, mergedAt: null, ...extra } });

/**
 * Answers the Linear attachments query from `byIssue`, keyed by issue key: an issue not named has none,
 * null is left out of the answer, and an object sets the whole attachments connection.
 */
function linearLinks(init: RequestInit, byIssue: Record<string, object[] | null | { pageInfo: object; nodes: object[] }> = {}): Response {
  const { query, variables } = graphqlBody(init);
  expect(query).toStartWith("query TimberLinearPullRequests(");
  expect(query).not.toContain("mutation");
  const ids = variables.ids as string[];
  expect(variables.first).toBe(ids.length);
  const nodes = ids.flatMap(id => {
    const key = id.slice(3);
    const answer = key in byIssue ? byIssue[key]! : [];
    if (answer === null) return [];
    return [{ id, attachments: Array.isArray(answer) ? { pageInfo: { hasNextPage: false }, nodes: answer } : answer }];
  });
  return Response.json({ data: { issues: { nodes } } });
}

const linearCycle: Answer = (_url, init) => {
  const { query, variables } = graphqlBody(init);
  if (query.includes("TimberLinearPullRequests")) {
    return linearLinks(init, { "LIN-3": [linearPull(60, { draft: true, status: "draft" }), linearPull(61, { status: "merged", mergedAt: "2026-11-19T10:00:00.000Z" }),
      linearPull(62, { status: "closed", closedAt: "2026-11-19T10:00:00.000Z" }),
      // The GitHub integration also attaches issues; they are not pull requests.
      { url: "https://github.com/acme/widgets/issues/5", metadata: { number: 5 } }] });
  }
  expect(variables).toMatchObject({ team: "LIN" });
  return Response.json({ data: { teams: { nodes: [{ activeCycle: { name: null, number: 4, issues: {
    pageInfo: { hasNextPage: false, endCursor: null }, nodes: [linearNode("LIN-3", "started"), linearNode("LIN-4")] } } }] } } });
};

const run = (primary: string, query: string, text: string | undefined, options: AppIssuesOptions, service: AppIssuesServices) =>
  readAppIssues(primary, query, text, options, service);

const noSecrets = (record: AppIssuesRecord) => { for (const secret of secrets) expect(JSON.stringify(record)).not.toContain(secret); };

test("the current sprint of GitHub, Jira and Linear lists every issue, marks linked worktrees and changes nothing", async () => {
  await withFixture(async ({ primary, directory, paths, all }) => {
    // A branch named after an issue is not a link; only the tracker says which pull requests are.
    await git(primary, "branch", "GH-43-fix-it");
    await git(primary, "branch", "ENG-8-fix-it");
    const before = await snapshot(directory, all);
    const seen = fresh();
    const github = await run(primary, "sprint", undefined, { tracker: "github" }, services(seen, directory, githubSprint));
    const jira = await run(paths.unlinked!, "sprint", undefined, {}, services(seen, directory, jiraSprint));
    const linear = await run(primary, "sprint", undefined, { tracker: "linear" }, services(seen, directory, linearCycle));
    expect(await snapshot(directory, all)).toBe(before);

    expect(github).toMatchObject({ schemaVersion: 1, query: "sprint", tracker: "github", outcome: "found", reason: null, diagnostic: null,
      repository: { commonGitDir: join(primary, ".git"), primaryWorktreeRoot: primary, currentWorktreeRoot: primary },
      sprint: { name: "Sprint 2", source: "github-iteration" }, truncated: false });
    expect(github.issues).toEqual([
      { ...links.github!, title: "Issue 42", status: { name: "Open", category: "open" }, assignee: "octo",
        worktree: { path: paths.github!, branch: "feature/github" }, pullRequests: [
          // Merged pull requests are left out; a fork's draft keeps its own head branch.
          { number: 50, url: "https://github.com/acme/widgets/pull/50", branch: "fix-50", fromFork: false, draft: false },
          { number: 52, url: "https://github.com/acme/widgets/pull/52", branch: "patch-1", fromFork: true, draft: true }], assignedToMe: true },
      { tracker: "github", key: "43", url: "https://github.com/acme/widgets/issues/43", title: "Issue 43",
        status: { name: "Closed", category: "closed" }, assignee: "octo", worktree: null, pullRequests: [], assignedToMe: true },
      // The same number in another repository is a different issue, so it has no worktree.
      { tracker: "github", key: "42", url: "https://github.com/other/repo/issues/42", title: "Issue 42",
        status: { name: "Open", category: "open" }, assignee: "octo", worktree: null,
        pullRequests: [{ number: 7, url: "https://github.com/other/repo/pull/7", branch: "fix-7", fromFork: false, draft: false }], assignedToMe: true },
    ]);

    expect(jira).toMatchObject({ tracker: "jira", outcome: "found", sprint: { name: "ENG Sprint 9", source: "jira-board" }, truncated: false });
    expect(jira.issues.map(issue => [issue.key, issue.status.category, issue.worktree?.branch ?? null])).toEqual([
      ["ENG-7", "in-progress", "feature/jira"], ["ENG-8", "open", null], ["ENG-9", "closed", null], ["ENG-10", "open", null]]);
    expect(jira.issues[0]).toMatchObject({ url: "https://acme.atlassian.net/browse/ENG-7", title: "Title ENG-7", assignee: "Ada" });
    // Jira has no draft flag; a fork is a source branch in another repository than the destination.
    expect(jira.issues.map(issue => issue.pullRequests)).toEqual([[
      { number: 1633, url: "https://bitbucket.org/acme/widgets/pull-requests/1633", branch: "ENG-7-fix", fromFork: false, draft: null },
      { number: 12, url: "https://github.com/acme/widgets/pull/12", branch: "patch-1", fromFork: true, draft: null }], [], [], []]);

    expect(linear).toMatchObject({ tracker: "linear", outcome: "found", sprint: { name: "Cycle 4", source: "linear-cycle" } });
    expect(linear.issues.map(issue => [issue.key, issue.status.category, issue.worktree?.path ?? null, issue.pullRequests])).toEqual([
      // Merged and closed pull requests are left out; Linear does not say whether a head is a fork.
      ["LIN-3", "in-progress", paths.linear!, [{ number: 60, url: "https://github.com/acme/widgets/pull/60", branch: "lin-60", fromFork: null, draft: true }]],
      ["LIN-4", "open", null, []]]);

    const methods = seen.requests.map(request => `${request.init.method} ${new URL(request.url).host}`);
    // The signed-in login is read once, after the list, because its issues have assignees.
    expect(methods).toEqual(["POST api.github.com", "POST api.github.com", "POST api.github.com", "GET api.github.com", "POST api.github.com",
      ...Array<string>(7).fill("GET acme.atlassian.net"), "POST api.linear.app", "POST api.linear.app"]);
    for (const record of [github, jira, linear]) noSecrets(record);
  });
});

test("a failure to read pull request links blanks only those links and keeps the list", async () => {
  await withFixture(async ({ primary, directory, all }) => {
    const before = await snapshot(directory, all);
    const listing = [restIssue(42), restIssue(43), restIssue(44), restIssue(45)];
    const github = (links: (init: RequestInit) => Response | Promise<Response>, timeoutMs?: number) =>
      run(primary, "open", undefined, { tracker: "github" }, services(fresh(), directory, (url, init) =>
        url.pathname === "/graphql" ? links(init) : Response.json(listing), {}, timeoutMs));

    const failures: [string, AppIssuesRecord][] = [
      ["HTTP error", await github(() => new Response(`no ${githubToken}`, { status: 502 }))],
      ["login rejected", await github(() => new Response(null, { status: 401 }))],
      ["unreadable", await github(() => Response.json({ data: null, errors: [{ type: "RATE_LIMITED" }] }))],
      ["unreachable", await github(() => { throw new TypeError("connect failed"); })],
    ];
    for (const [name, record] of failures) {
      expect({ name, record }).toMatchObject({ name, record: { outcome: "found", reason: null, diagnostic: null } });
      expect(record.issues.map(issue => [issue.key, issue.pullRequests])).toEqual([["42", null], ["43", null], ["44", null], ["45", null]]);
      noSecrets(record);
    }

    const started = Date.now();
    const late = await github(() => new Promise<Response>(() => {}), 300);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(late).toMatchObject({ outcome: "found", reason: null });
    expect(late.issues.every(issue => issue.pullRequests === null)).toBeTrue();

    // One issue GitHub cannot answer for, one with more links than were read, and one with an address that is not a pull request.
    const partial = await github(init => githubLinks(init, { "https://github.com/acme/widgets/issues/43": null,
      "https://github.com/acme/widgets/issues/44": { totalCount: 21, nodes: [githubPull(1)] },
      "https://github.com/acme/widgets/issues/45": [githubPull(2, { url: "https://example.invalid/acme/widgets/pull/2" })] }));
    expect(partial.issues.map(issue => [issue.key, issue.pullRequests])).toEqual([["42", []], ["43", null], ["44", null], ["45", null]]);
    expect(await snapshot(directory, all)).toBe(before);

    const linearListing = Response.json({ data: { issues: { pageInfo: { hasNextPage: false },
      nodes: [linearNode("LIN-3"), linearNode("LIN-4"), linearNode("LIN-5"), linearNode("LIN-6")] } } });
    const linear = (links: (init: RequestInit) => Response | Promise<Response>, timeoutMs?: number) =>
      run(primary, "open", undefined, { tracker: "linear" }, services(fresh(), directory, (_url, init) =>
        graphqlBody(init).query.includes("TimberLinearPullRequests") ? links(init) : linearListing.clone(), {}, timeoutMs));
    const linearFailures: [string, AppIssuesRecord][] = [
      ["HTTP error", await linear(() => new Response(`no ${linearToken}`, { status: 502 }))],
      ["login rejected", await linear(() => Response.json({ errors: [{ extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 400 }))],
      ["unreadable", await linear(() => Response.json({ data: { issues: null } }))],
      ["unreachable", await linear(() => { throw new TypeError("connect failed"); })],
      ["late", await linear(() => new Promise<Response>(() => {}), 300)],
    ];
    for (const [name, record] of linearFailures) {
      expect({ name, record }).toMatchObject({ name, record: { outcome: "found", reason: null, diagnostic: null } });
      expect(record.issues.map(issue => [issue.key, issue.pullRequests])).toEqual([["LIN-3", null], ["LIN-4", null], ["LIN-5", null], ["LIN-6", null]]);
      noSecrets(record);
    }
    // One issue Linear leaves out, one with more attachments than were read, and one pull request whose details are unreadable.
    const linearPartial = await linear(init => linearLinks(init, { "LIN-4": null,
      "LIN-5": { pageInfo: { hasNextPage: true }, nodes: [linearPull(1)] }, "LIN-6": [linearPull(2, { branch: "" })] }));
    expect(linearPartial.issues.map(issue => [issue.key, issue.pullRequests])).toEqual([["LIN-3", []], ["LIN-4", null], ["LIN-5", null], ["LIN-6", null]]);
    expect(await snapshot(directory, all)).toBe(before);

    await writeFile(join(primary, ".timber.toml"), `[jira]\nsite_url = "https://acme.atlassian.net"\nproject = "ENG"\n`);
    const configured = await snapshot(directory, all);
    const jira = (answer: Answer) => run(primary, "open", undefined, { tracker: "jira" }, services(fresh(), directory, (url, init) => {
      if (url.pathname === "/rest/api/3/search/jql" && !url.searchParams.get("jql")!.includes("development")) {
        return Response.json({ issues: [jiraIssue("ENG-7"), jiraIssue("ENG-8"), jiraIssue("ENG-9")] });
      }
      return answer(url, init);
    }));
    // A panel that fails, and one with a pull request Timber cannot read, blank only their own issue.
    const panels = await jira(url => jiraPanel(url, { "ENG-7": "7", "ENG-8": "8", "ENG-9": "9" },
      { 7: { bitbucket: [bitbucketPull("1")] }, 8: null, 9: { bitbucket: [{ ...bitbucketPull("x"), url: "http://bitbucket.org/acme/widgets/pull-requests/x" }] } })!);
    expect(panels).toMatchObject({ outcome: "found", reason: null });
    expect(panels.issues.map(issue => [issue.key, issue.pullRequests?.map(pull => pull.number) ?? null]))
      .toEqual([["ENG-7", [1]], ["ENG-8", null], ["ENG-9", null]]);
    // A panel with no open pull request contradicts the search, so it is unknown rather than empty.
    const empty = await jira(url => jiraPanel(url, { "ENG-7": "7" }, { 7: { bitbucket: [bitbucketPull("1", "MERGED")] } })!);
    expect(empty.issues.map(issue => issue.pullRequests)).toEqual([null, [], []]);
    // Running out of time keeps the links already read; only unread panels are unknown.
    const slow = await run(primary, "open", undefined, { tracker: "jira" }, services(fresh(), directory, url => {
      if (url.pathname === "/rest/api/3/search/jql" && !url.searchParams.get("jql")!.includes("development")) {
        return Response.json({ issues: [jiraIssue("ENG-7"), jiraIssue("ENG-8"), jiraIssue("ENG-9")] });
      }
      if (url.searchParams.get("issueId") === "8") return new Promise<Response>(() => {});
      return jiraPanel(url, { "ENG-7": "7", "ENG-8": "8" }, { 7: { bitbucket: [bitbucketPull("1")] } })!;
    }, {}, 400));
    expect(slow).toMatchObject({ outcome: "found", reason: null });
    expect(slow.issues.map(issue => issue.pullRequests?.length ?? null)).toEqual([1, null, 0]);
    // A site that cannot search development fields leaves every link unknown.
    const rejected = await jira(() => new Response(null, { status: 400 }));
    expect(rejected).toMatchObject({ outcome: "found", reason: null });
    expect(rejected.issues.map(issue => issue.pullRequests)).toEqual([null, null, null]);
    expect(await snapshot(directory, all)).toBe(configured);
  });
});

test("a sprint of hundreds of issues reads its links in a few batched, read-only requests", async () => {
  await withFixture(async ({ primary, directory }) => {
    await writeFile(join(primary, ".timber.toml"), `[jira]\nsite_url = "https://acme.atlassian.net"\nsprint_jql = "labels = now"\n[github]\nmilestone = "v2"\n[linear]\nteam = "LIN"\n`);
    const seen = fresh();
    const page = (start: number, count: number) => Array.from({ length: count }, (_, index) => restIssue(start + index));
    const github = await run(primary, "sprint", undefined, { tracker: "github" }, services(seen, directory, (url, init) => {
      if (url.pathname === "/graphql") return githubLinks(init, { "https://github.com/acme/widgets/issues/250": [githubPull(900)] });
      if (url.pathname.endsWith("/milestones")) return Response.json([{ number: 7, title: "v2" }]);
      const number = Number(url.searchParams.get("page") ?? "1");
      const next = `<https://api.github.com/repos/acme/widgets/issues?milestone=7&state=open&per_page=100&page=${number + 1}>; rel="next"`;
      return Response.json(page((number - 1) * 100 + 1, number < 3 ? 100 : 50), number < 3 ? { headers: { link: next } } : {});
    }));
    expect(github.issues).toHaveLength(250);
    expect(github.issues.at(-1)!.pullRequests).toEqual([
      { number: 900, url: "https://github.com/acme/widgets/pull/900", branch: "fix-900", fromFork: false, draft: false }]);
    expect(github.issues.slice(0, -1).every(issue => Array.isArray(issue.pullRequests) && issue.pullRequests.length === 0)).toBeTrue();
    const queries = seen.requests.filter(request => request.init.method === "POST");
    expect(queries).toHaveLength(3);
    for (const request of seen.requests) expect(["GET", "POST"]).toContain(request.init.method!);
    expect(queries.map(request => graphqlBody(request.init).query.match(/: issue\(/gu)!.length)).toEqual([100, 100, 50]);

    // Every issue has an open pull request; panels are read a bounded few at a time.
    const keys = Array.from({ length: 150 }, (_, index) => `ENG-${index + 1}`);
    let inFlight = 0;
    let most = 0;
    const jiraSeen = fresh();
    const jira = await run(primary, "sprint", undefined, { tracker: "jira" }, services(jiraSeen, directory, async url => {
      if (url.searchParams.get("jql") === "labels = now") return Response.json({ issues: keys.map(key => jiraIssue(key)) });
      inFlight++;
      most = Math.max(most, inFlight);
      await Bun.sleep(1);
      inFlight--;
      return jiraPanel(url, Object.fromEntries(keys.map(key => [key, key.slice(4)])),
        Object.fromEntries(keys.map(key => [key.slice(4), { bitbucket: [bitbucketPull(key.slice(4))] }])))!;
    }));
    expect(jira.issues).toHaveLength(150);
    expect(jira.issues.every(issue => issue.pullRequests?.length === 1)).toBeTrue();
    expect(most).toBeLessThanOrEqual(10);
    expect(jiraSeen.requests.every(request => request.init.method === "GET")).toBeTrue();
    // One list search, two link searches of at most 100 keys, then a summary and a detail per issue.
    expect(jiraSeen.requests).toHaveLength(1 + 2 + 150 * 2);

    // A Linear cycle reads its pages, then one attachments query per 100 issues.
    const linearSeen = fresh();
    const cycleKeys = Array.from({ length: 150 }, (_, index) => `LIN-${index + 1}`);
    const linear = await run(primary, "sprint", undefined, { tracker: "linear" }, services(linearSeen, directory, (_url, init) => {
      const { query, variables } = graphqlBody(init);
      if (query.includes("TimberLinearPullRequests")) return linearLinks(init, { "LIN-150": [linearPull(901)] });
      const second = variables.after === "p2";
      return Response.json({ data: { teams: { nodes: [{ activeCycle: { name: "Now", number: 9, issues: {
        pageInfo: { hasNextPage: !second, endCursor: second ? null : "p2" },
        nodes: cycleKeys.slice(second ? 100 : 0, second ? 150 : 100).map(key => linearNode(key)) } } }] } } });
    }));
    expect(linear.issues).toHaveLength(150);
    expect(linear.issues.at(-1)!.pullRequests).toEqual([
      { number: 901, url: "https://github.com/acme/widgets/pull/901", branch: "lin-901", fromFork: null, draft: false }]);
    expect(linear.issues.slice(0, -1).every(issue => issue.pullRequests?.length === 0)).toBeTrue();
    const linkQueries = linearSeen.requests.map(request => graphqlBody(request.init)).filter(body => body.query.includes("TimberLinearPullRequests"));
    expect(linkQueries.map(body => (body.variables.ids as string[]).length)).toEqual([100, 50]);
    expect(linearSeen.requests).toHaveLength(2 + 2);
  });
});

test("a GitHub milestone and a saved Jira query stand in for a sprint", async () => {
  await withFixture(async ({ primary, directory }) => {
    await writeFile(join(primary, ".timber.toml"), `[jira]\nsite_url = "https://acme.atlassian.net"\nsprint_jql = "labels = now"\n[github]\nmilestone = "v2"\n`);
    const github = await run(primary, "sprint", undefined, { tracker: "github" }, services(fresh(), directory, url => {
      if (url.pathname.endsWith("/milestones")) return Response.json([{ number: 1, title: "v1" }, { number: 7, title: "v2" }]);
      expect(url.pathname).toBe("/repos/acme/widgets/issues");
      expect(url.searchParams.get("milestone")).toBe("7");
      expect(url.searchParams.get("state")).toBe("open");
      return Response.json([restIssue(42), restIssue(44, "open", "acme/widgets", { pull_request: {} })]);
    }));
    expect(github).toMatchObject({ outcome: "found", sprint: { name: "v2", source: "github-milestone" }, truncated: false });
    expect(github.issues.map(issue => [issue.key, issue.worktree !== null])).toEqual([["42", true]]);

    const jira = await run(primary, "sprint", undefined, { tracker: "jira" }, services(fresh(), directory, url => {
      expect(url.searchParams.get("jql")).toBe("labels = now");
      return Response.json({ issues: [jiraIssue("ENG-1")] });
    }));
    expect(jira).toMatchObject({ outcome: "found", sprint: { name: null, source: "jira-jql" } });
    expect(jira.issues).toHaveLength(1);

    const missing = await run(primary, "sprint", undefined, { tracker: "github" }, services(fresh(), directory, () => Response.json([{ number: 1, title: "v1" }])));
    expect(missing).toMatchObject({ outcome: "failed", reason: "not-found", issues: [] });
    expect(missing.diagnostic).toContain("v2");
  });
});

test("a configured tracker with no current sprint reports none", async () => {
  await withFixture(async ({ primary, directory }) => {
    const github = await run(primary, "sprint", undefined, { tracker: "github" }, services(fresh(), directory, () => Response.json({ data: {
      repositoryOwner: { projectV2: { fields: { nodes: [{ name: "Iteration", configuration: { iterations: [iterations[0]] } }] } } } } })));
    const jira = await run(primary, "sprint", undefined, {}, services(fresh(), directory, () => Response.json({ values: [] })));
    const linear = await run(primary, "sprint", undefined, { tracker: "linear" }, services(fresh(), directory, () =>
      Response.json({ data: { teams: { nodes: [{ activeCycle: null }] } } })));
    for (const record of [github, jira, linear]) {
      expect(record).toMatchObject({ outcome: "none", sprint: null, issues: [], reason: null, diagnostic: null });
    }
  });
});

test("the current iteration is the one whose dates include today, end date exclusive", () => {
  const at = (day: number) => new Date(2026, 10, day, 23, 59);
  expect(currentIteration(iterations, at(15))?.id).toBe("past");
  expect(currentIteration(iterations, at(16))?.id).toBe("now");
  expect(currentIteration(iterations, at(29))?.id).toBe("now");
  expect(currentIteration(iterations, at(30))).toBeUndefined();
});

test("assigned and open issues respect the limit and report truncation", async () => {
  await withFixture(async ({ primary, directory }) => {
    const seen = fresh();
    const github = await run(primary, "assigned", undefined, { tracker: "github", limit: "2" }, services(seen, directory, url => {
      if (url.pathname === "/user") return Response.json({ login: "octo" });
      expect(url.searchParams.get("assignee")).toBe("octo");
      expect(url.searchParams.get("state")).toBe("open");
      return Response.json([restIssue(42), restIssue(45, "open", "acme/widgets", { pull_request: {} }), restIssue(46), restIssue(47)]);
    }));
    expect(github).toMatchObject({ outcome: "found", sprint: null, truncated: true });
    expect(github.issues.map(issue => issue.key)).toEqual(["42", "46"]);

    const githubOpen = await run(primary, "open", undefined, { tracker: "github" }, services(fresh(), directory, url => {
      expect(url.search).toContain("sort=created");
      expect(url.search).toContain("direction=desc");
      if (url.searchParams.has("page")) return Response.json([restIssue(1)]);
      return Response.json([restIssue(2)], { headers: { link: '<https://api.github.com/repos/acme/widgets/issues?state=open&sort=created&direction=desc&page=2>; rel="next"' } });
    }));
    expect(githubOpen.issues.map(issue => issue.key)).toEqual(["2", "1"]);
    expect(githubOpen.truncated).toBeFalse();

    const jira = await run(primary, "assigned", undefined, {}, services(fresh(), directory, url => {
      expect(url.searchParams.get("jql")).toBe('project = "ENG" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
      return Response.json({ issues: [jiraIssue("ENG-7")] });
    }));
    expect(jira.issues.map(issue => [issue.key, issue.worktree !== null])).toEqual([["ENG-7", true]]);
    const jiraOpen = await run(primary, "open", undefined, { limit: "1" }, services(fresh(), directory, url => {
      expect(url.searchParams.get("jql")).toBe('project = "ENG" AND statusCategory != Done ORDER BY created DESC');
      expect(url.searchParams.get("maxResults")).toBe("2");
      return Response.json({ issues: [jiraIssue("ENG-9"), jiraIssue("ENG-8")], nextPageToken: "more" });
    }));
    expect(jiraOpen).toMatchObject({ outcome: "found", truncated: true });
    expect(jiraOpen.issues.map(issue => issue.key)).toEqual(["ENG-9"]);

    for (const query of ["assigned", "open"]) {
      const linear = await run(primary, query, undefined, { tracker: "linear", limit: "5" }, services(fresh(), directory, (_url, init) => {
        const { query: text, variables } = graphqlBody(init);
        expect(text).toContain(query === "assigned" ? "assignedIssues" : "issues(first: $first, orderBy: createdAt");
        expect(variables).toEqual({ first: 5, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } }, team: { key: { eq: "LIN" } } } });
        const issues = { pageInfo: { hasNextPage: true }, nodes: [linearNode("LIN-3"), linearNode("LIN-9", "triage")] };
        return Response.json({ data: query === "assigned" ? { viewer: { assignedIssues: issues } } : { issues } });
      }));
      expect(linear).toMatchObject({ outcome: "found", truncated: true });
      expect(linear.issues.map(issue => [issue.key, issue.worktree !== null])).toEqual([["LIN-3", true], ["LIN-9", false]]);
    }
  });
});

test("search matches keys and title words on every tracker, with typed text never read as query syntax", async () => {
  await withFixture(async ({ primary, directory }) => {
    const listing = (url: URL, issues: object[], next = false) => {
      expect(url.pathname).toBe("/repos/acme/widgets/issues");
      expect(url.searchParams.get("state")).toBe("open");
      expect(url.searchParams.get("sort")).toBe("updated");
      return Response.json(issues, next ? { headers: { link: '<https://api.github.com/repos/acme/widgets/issues?state=open&sort=updated&page=2>; rel="next"' } } : {});
    };
    const github = await run(primary, "search", "#4", { tracker: "github", limit: "4" }, services(fresh(), directory, url => {
      if (url.pathname === "/repos/acme/widgets/issues/4") return Response.json(restIssue(4, "closed"));
      return listing(url, [restIssue(400), restIssue(42), restIssue(7, "open", "acme/widgets", { title: "Fix 4K screens" }),
        restIssue(44, "open", "acme/widgets", { pull_request: {} }), restIssue(9)]);
    }));
    // The exact number first in any state, then open numbers that start with it, then titles containing it.
    expect(github.issues.map(issue => [issue.key, issue.status.category, issue.worktree !== null]))
      .toEqual([["4", "closed", false], ["42", "open", true], ["400", "open", false], ["7", "open", false]]);
    expect(github.truncated).toBeFalse();

    const partial = await run(primary, "search", "WOB bit", { tracker: "github" }, services(fresh(), directory, url =>
      listing(url, [restIssue(1, "open", "acme/widgets", { title: "Wobbly bits" }), restIssue(2, "open", "acme/widgets", { title: "Wobbly" })], true)));
    expect(partial.issues.map(issue => issue.key)).toEqual(["1"]);
    expect(partial.truncated).toBeTrue();

    const seen = fresh();
    const injected = await run(primary, "search", 'repo:other/secret', { tracker: "github" }, services(seen, directory, url =>
      listing(url, [restIssue(3, "open", "acme/widgets", { title: "repoother/secret" })])));
    expect(injected.issues.map(issue => issue.key)).toEqual(["3"]);
    const [lists, linkQueries] = [seen.requests.filter(request => request.init.method === "GET"), seen.requests.filter(request => request.init.method === "POST")];
    expect(lists.every(request => request.url.startsWith("https://api.github.com/repos/acme/widgets/"))).toBeTrue();
    expect(linkQueries.map(request => graphqlBody(request.init).variables)).toEqual([{ o0: "acme", n0: "widgets" }]);

    const jira = await run(primary, "search", "eng-7", { tracker: "jira" }, services(fresh(), directory, url => {
      const panel = jiraPanel(url, {}, {});
      if (panel !== null) return panel;
      if (url.pathname === "/rest/api/3/issue/picker") {
        expect(url.searchParams.get("query")).toBe("ENG-7");
        expect(url.searchParams.get("currentJQL")).toBe('project = "ENG" ORDER BY updated DESC');
        return Response.json({ sections: [{ id: "hs", issues: [{ key: "ENG-1" }] }, { id: "cs", issues: [{ key: "ENG-70" }, { key: "ENG-7" }] }] });
      }
      expect(url.searchParams.get("jql")).toBe("key in (ENG-7, ENG-70, ENG-1)");
      return Response.json({ issues: [jiraIssue("ENG-1"), jiraIssue("ENG-70"), jiraIssue("ENG-7")] });
    }));
    expect(jira.issues.map(issue => [issue.key, issue.worktree !== null])).toEqual([["ENG-7", true], ["ENG-70", false], ["ENG-1", false]]);

    const linear = await run(primary, "search", "lin-3", { tracker: "linear" }, services(fresh(), directory, (_url, init) => {
      const { query, variables } = graphqlBody(init);
      if (query.includes("TimberLinearKey")) return Response.json({ data: { issue: linearNode("LIN-3") } });
      expect(variables).toEqual({ term: "lin-3", first: 10, filter: { team: { key: { eq: "LIN" } } } });
      return Response.json({ data: { searchIssues: { pageInfo: { hasNextPage: false }, nodes: [linearNode("LIN-30"), linearNode("LIN-3")] } } });
    }));
    expect(linear.issues.map(issue => issue.key)).toEqual(["LIN-3", "LIN-30"]);

    const missingKey = await run(primary, "search", "LIN-99", { tracker: "linear" }, services(fresh(), directory, (_url, init) => {
      if (graphqlBody(init).query.includes("TimberLinearKey")) {
        return Response.json({ errors: [{ message: "Entity not found: Issue", extensions: { code: "INPUT_ERROR" } }] }, { status: 400 });
      }
      return Response.json({ data: { searchIssues: { nodes: [] } } });
    }));
    expect(missingKey).toMatchObject({ outcome: "found", issues: [] });

    for (const tracker of ["github", "jira", "linear"]) {
      const seen = fresh();
      const blank = await run(primary, "search", "  ", { tracker }, services(seen, directory, url => {
        if (url.pathname === "/rest/api/3/issue/picker") throw new Error("must not search");
        throw new Error("must not fetch");
      }));
      expect(blank).toMatchObject({ outcome: "found", issues: [] });
      expect(seen.requests).toEqual([]);
    }
  });
});

test("a Jira search without a project still asks the picker for matches, not only history", async () => {
  await withFixture(async ({ primary, directory }) => {
    await writeFile(join(primary, ".timber.toml"), '[jira]\nsite_url = "https://acme.atlassian.net"\n');
    const record = await run(primary, "search", "ship", { tracker: "jira" }, services(fresh(), directory, url => {
      if (url.pathname === "/rest/api/3/issue/picker") {
        expect(url.searchParams.get("currentJQL")).toBe("ORDER BY updated DESC");
        return Response.json({ sections: [{ id: "cs", issues: [{ key: "OPS-2" }] }] });
      }
      return Response.json({ issues: [jiraIssue("OPS-2")] });
    }));
    expect(record.issues.map(issue => issue.key)).toEqual(["OPS-2"]);
  });
});

test("search helpers strip query syntax and recognize key prefixes", () => {
  expect(searchWords(' a:b  "c" (d) ')).toEqual(["ab", "c", "d"]);
  expect(keyPrefix("#12")).toBe("12");
  expect(keyPrefix("eng-")).toBe("ENG-");
  expect(keyPrefix("eng 4")).toBeNull();
});

test("missing settings and invalid input fail without reading a login or contacting a tracker", async () => {
  await withFixture(async ({ primary, directory, all }) => {
    await writeFile(join(primary, ".timber.toml"), `[jira]\nsite_url = "https://acme.atlassian.net"\n`);
    const before = await snapshot(directory, all);
    const cases: [string, string | undefined, AppIssuesOptions, string, string][] = [
      ["sprint", undefined, { tracker: "github" }, "not-configured", "[github].project"],
      ["sprint", undefined, { tracker: "jira" }, "not-configured", "[jira].board"],
      ["open", undefined, { tracker: "jira" }, "not-configured", "[jira].project"],
      ["sprint", undefined, { tracker: "linear" }, "not-configured", "[linear].team"],
      ["open", undefined, { tracker: "linear" }, "not-configured", "[linear].team"],
      ["open", undefined, {}, "not-configured", "default_tracker"],
      ["board", undefined, { tracker: "jira" }, "failed", "Unknown list"],
      ["open", undefined, { tracker: "gitlab" }, "failed", "Unknown tracker"],
      ["search", "x", {}, "failed", "--tracker"],
      ["search", undefined, { tracker: "jira" }, "failed", "needs text"],
      ["open", "x", { tracker: "jira" }, "failed", "Only search"],
      ["open", undefined, { tracker: "github", limit: "0" }, "failed", "--limit"],
      ["open", undefined, { tracker: "github", limit: "101" }, "failed", "--limit"],
      ["sprint", undefined, { tracker: "github", limit: "5" }, "failed", "listed whole"],
    ];
    for (const [query, text, options, reason, diagnostic] of cases) {
      const seen = fresh();
      const record = await run(primary, query, text, options, services(seen, directory, noFetch, {
        githubToken: async () => { throw new Error("must not read a login"); },
        jiraCredentials: async () => { throw new Error("must not read a login"); },
        linearToken: async () => { throw new Error("must not read a login"); },
      }));
      expect(record).toMatchObject({ outcome: "failed", reason, issues: [], sprint: null });
      expect(record.diagnostic).toContain(diagnostic);
      expect(seen).toEqual({ requests: [], logins: 0 });
    }
    expect(await snapshot(directory, all)).toBe(before);
  });
});

test("tracker failures report the same reasons as __app-issue, plus not-found for a missing board or project", async () => {
  await withFixture(async ({ primary, directory, paths, all }) => {
    const before = await snapshot(directory, all);
    const cases: [string, AppIssuesOptions, AppIssuesServices, string][] = [
      ["open", { tracker: "github" }, services(fresh(), directory, noFetch, { githubToken: async () => { throw new Error(`gh failed ${githubToken}`); } }), "sign-in-needed"],
      ["assigned", { tracker: "linear" }, services(fresh(), directory, noFetch, { linearToken: async () => { throw new Error("Linear credentials are missing."); } }), "sign-in-needed"],
      ["open", { tracker: "github" }, services(fresh(), directory, () => new Response(`bad ${githubToken}`, { status: 401 })), "sign-in-needed"],
      ["sprint", { tracker: "linear" }, services(fresh(), directory, () => Response.json({ errors: [{ extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 400 })), "sign-in-needed"],
      ["sprint", {}, services(fresh(), directory, () => new Response(null, { status: 403 })), "forbidden"],
      ["open", { tracker: "github" }, services(fresh(), directory, () => new Response(null, { status: 403 })), "forbidden"],
      ["sprint", { tracker: "github" }, services(fresh(), directory, () => Response.json({ errors: [{ type: "INSUFFICIENT_SCOPES" }] })), "forbidden"],
      ["open", { tracker: "linear" }, services(fresh(), directory, () => Response.json({ errors: [{ extensions: { code: "FORBIDDEN" } }] })), "forbidden"],
      ["sprint", {}, services(fresh(), directory, () => new Response(null, { status: 404 })), "not-found"],
      ["sprint", { tracker: "github" }, services(fresh(), directory, () => Response.json({ data: { repositoryOwner: null }, errors: [{ type: "NOT_FOUND" }] })), "not-found"],
      ["sprint", { tracker: "linear" }, services(fresh(), directory, () => Response.json({ data: { teams: { nodes: [] } } })), "not-found"],
      ["sprint", {}, services(fresh(), directory, () => new Response(null, { status: 400 })), "not-configured"],
      ["sprint", { tracker: "github" }, services(fresh(), directory, () => Response.json({ data: { repositoryOwner: { projectV2: { fields: { nodes: [{}] } } } } })), "not-configured"],
      ["open", { tracker: "github" }, services(fresh(), directory, () => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } })), "failed"],
      ["open", { tracker: "github" }, services(fresh(), directory, () => Response.json([{ number: 1 }])), "failed"],
      ["open", {}, services(fresh(), directory, () => new Response("not json")), "failed"],
      ["open", { tracker: "github" }, services(fresh(), directory, () => new Response(null, { status: 302, headers: { location: "https://evil.invalid/" } })), "failed"],
      ["open", { tracker: "linear" }, services(fresh(), directory, () => { throw new TypeError(`connect failed ${linearToken}`); }), "offline"],
      ["open", { tracker: "github" }, services(fresh(), directory, () => new Promise<Response>(() => {}), {}, 200), "offline"],
    ];
    for (const [query, options, service, reason] of cases) {
      const record = await run(paths.github!, query, undefined, options, service);
      expect({ query, options, reason: record.reason }).toEqual({ query, options, reason: reason as never });
      expect(record).toMatchObject({ outcome: "failed", issues: [], truncated: false });
      expect(record.diagnostic).toBeString();
      noSecrets(record);
    }
    expect(await snapshot(directory, all)).toBe(before);
  });
});

test("a GitHub list needs a github.com remote and reads no login without one", async () => {
  await withFixture(async ({ primary, directory }) => {
    await git(primary, "remote", "set-url", "origin", "https://gitlab.com/acme/widgets.git");
    const seen = fresh();
    const record = await run(primary, "open", undefined, { tracker: "github" }, services(seen, directory, noFetch));
    expect(record).toMatchObject({ outcome: "failed", reason: "failed" });
    expect(record.diagnostic).toContain("github.com");
    expect(seen).toEqual({ requests: [], logins: 0 });
  });
});

test("issue identity matches links across URL spelling but not across repositories or sites", () => {
  expect(issueIdentity({ tracker: "github", key: "4", url: "https://github.com/Acme/Widgets/issues/4" }))
    .toBe(issueIdentity({ tracker: "github", key: "4", url: "https://github.com/acme/widgets/issues/4" }));
  expect(issueIdentity({ tracker: "github", key: "4", url: "https://github.com/acme/other/issues/4" }))
    .not.toBe(issueIdentity({ tracker: "github", key: "4", url: "https://github.com/acme/widgets/issues/4" }));
  expect(issueIdentity({ tracker: "jira", key: "ENG-1", url: "https://a.atlassian.net/browse/ENG-1" }))
    .not.toBe(issueIdentity({ tracker: "jira", key: "ENG-1", url: "https://b.atlassian.net/browse/ENG-1" }));
  expect(issueIdentity({ tracker: "github", key: "5", url: "https://github.com/acme/widgets/issues/4" })).toBeNull();
});

test("list settings are validated and keep the Jira login identity unchanged", () => {
  const parsed = parseConfigSource(settings, "x.toml");
  expect(parsed.jira).toMatchObject({ board: 12, project: "ENG" });
  expect(parseConfigSource('[jira]\nsite_url = "https://a.atlassian.net"\nproject = "eng"\n', "x").jira).toMatchObject({ project: "ENG" });
  expect(() => parseConfigSource('[jira]\nsite_url = "https://a.atlassian.net"\nboard = 1\nsprint_jql = "x"\n', "x.toml")).toThrow("sprint_jql is invalid");
  expect(() => parseConfigSource('[github]\nproject = "acme"\n', "x.toml")).toThrow("github.project is invalid");
  expect(() => parseConfigSource('[linear]\nteam = "a b"\n', "x.toml")).toThrow("linear.team is invalid");
  expect(() => parseConfigSource('[jira]\nsite_url = "https://a.atlassian.net"\nboard = 0\n', "x.toml")).toThrow("jira.board is invalid");
});

/** The real CLI with stdin closed, no terminal and CI on. */
async function cli(cwd: string, args: string[], env: Record<string, string | undefined>) {
  const result = await execa(process.execPath, ["--no-env-file", entry, "__app-issues", ...args], {
    cwd, reject: false, timeout: 30_000, stdin: "ignore",
    env: { CI: "true", GH_TOKEN: undefined, GITHUB_TOKEN: undefined, LINEAR_API_KEY: undefined, JIRA_EMAIL: undefined,
      JIRA_API_TOKEN: undefined, HTTPS_PROXY: undefined, https_proxy: undefined, ...env },
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, record: JSON.parse(result.stdout) };
}

test("the CLI prints one record per call with no prompt, no token and no change", async () => {
  await withFixture(async ({ primary, directory, all }) => {
    const home = { XDG_CONFIG_HOME: join(directory, "config") };
    const before = await snapshot(directory, all);
    const linearOpen = await cli(primary, ["open", "--tracker", "linear"], home);
    const signedOut = await cli(primary, ["sprint", "--tracker", "linear"], home);
    const jiraOut = await cli(primary, ["search", "--tracker", "jira", "--limit", "5", "--", "-ENG 7"], home);
    const offline = await cli(primary, ["open", "--tracker", "github"], { ...home, GH_TOKEN: githubToken,
      HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" });
    const invalid = await cli(primary, ["everything"], home);
    expect(await snapshot(directory, all)).toBe(before);

    await writeFile(join(primary, ".timber.toml"), "");
    const noTeam = await cli(primary, ["open", "--tracker", "linear"], home);
    expect(noTeam.record).toMatchObject({ outcome: "failed", reason: "not-configured" });
    expect(linearOpen.record).toMatchObject({ outcome: "failed", reason: "sign-in-needed" });
    for (const [result, reason] of [[signedOut, "sign-in-needed"], [jiraOut, "sign-in-needed"], [offline, "offline"], [invalid, "failed"]] as const) {
      expect(result.exitCode).toBe(1);
      expect(result.record).toMatchObject({ schemaVersion: 1, outcome: "failed", reason, issues: [] });
    }
    expect(jiraOut.record).toMatchObject({ query: "search", tracker: "jira" });
    expect(invalid.record).toMatchObject({ query: null, tracker: null });
    for (const result of [linearOpen, signedOut, jiraOut, offline, invalid, noTeam]) {
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.stdout + result.stderr).not.toContain(githubToken);
    }
  });
});

test("assignedToMe compares each issue's assignees with the signed-in account, and an unknown account never fails the list", async () => {
  await withFixture(async ({ primary, directory }) => {
    const assignees = (...logins: string[]) => ({ assignees: logins.map(login => ({ login })) });
    const listing = [restIssue(1, "open", "acme/widgets", assignees("someone", "ME")), restIssue(2, "open", "acme/widgets", assignees("someone")),
      restIssue(3, "open", "acme/widgets", { assignee: null, ...assignees() }), restIssue(4)];
    const github = (user: () => Response) => run(primary, "open", undefined, { tracker: "github" }, services(fresh(), directory, (url, init) => {
      if (url.pathname === "/graphql") return githubLinks(init);
      if (url.pathname === "/user") return user();
      return Response.json(listing);
    }));
    // GitHub logins compare without case; an issue without an assignee list is unknown.
    const known = await github(() => Response.json({ login: "me" }));
    expect(known.issues.map(issue => [issue.key, issue.assignedToMe])).toEqual([["1", true], ["2", false], ["3", false], ["4", null]]);
    const unknown = await github(() => new Response(null, { status: 403 }));
    expect(unknown).toMatchObject({ outcome: "found", reason: null, diagnostic: null });
    expect(unknown.issues.map(issue => [issue.key, issue.assignedToMe])).toEqual([["1", null], ["2", null], ["3", false], ["4", null]]);

    // Nobody assigned: the account is never read.
    const seen = fresh();
    await run(primary, "open", undefined, { tracker: "github" }, services(seen, directory, (url, init) =>
      url.pathname === "/graphql" ? githubLinks(init) : Response.json([restIssue(3, "open", "acme/widgets", { assignee: null, ...assignees() })])));
    expect(seen.requests.some(request => request.url.endsWith("/user"))).toBeFalse();

    const jiraAssigned = (key: string, accountId: string | null) => ({ ...jiraIssue(key),
      fields: { ...jiraIssue(key).fields, assignee: accountId === null ? null : { displayName: "Someone", accountId } } });
    const jira = (myself: () => Response) => run(primary, "open", undefined, { tracker: "jira" }, services(fresh(), directory, url => {
      const panel = jiraPanel(url, {}, {});
      if (panel !== null) return panel;
      if (url.pathname === "/rest/api/3/myself") return myself();
      return Response.json({ issues: [jiraAssigned("ENG-1", "acc-me"), jiraAssigned("ENG-2", "acc-other"), jiraAssigned("ENG-3", null), jiraIssue("ENG-4")] });
    }));
    expect((await jira(() => Response.json({ accountId: "acc-me" }))).issues.map(issue => issue.assignedToMe)).toEqual([true, false, false, null]);
    const blank = await run(primary, "open", undefined, { tracker: "jira" }, services(fresh(), directory, url => {
      const panel = jiraPanel(url, {}, {});
      if (panel !== null) return panel;
      if (url.pathname === "/rest/api/3/myself") return Response.json({ accountId: "acc-me" });
      return Response.json({ issues: [{ ...jiraIssue("ENG-5"), fields: { ...jiraIssue("ENG-5").fields, assignee: { displayName: " ", accountId: "acc-blank" } } }] });
    }));
    // A blank display name still names an assignee, so the app does not offer a plain --assign.
    expect(blank.issues.map(issue => [issue.assignee, issue.assignedToMe])).toEqual([["acc-blank", false]]);
    // Some scoped tokens may read issues but not /myself.
    const scoped = await jira(() => new Response(null, { status: 401 }));
    expect(scoped).toMatchObject({ outcome: "found", reason: null });
    expect(scoped.issues.map(issue => issue.assignedToMe)).toEqual([null, null, false, null]);

    const linear = await run(primary, "open", undefined, { tracker: "linear" }, services(fresh(), directory, (_url, init) => {
      const { query } = graphqlBody(init);
      if (query.includes("TimberLinearPullRequests")) return linearLinks(init);
      expect(query).toContain("assignee { displayName isMe }");
      return Response.json({ data: { issues: { pageInfo: { hasNextPage: false }, nodes: [
        { ...linearNode("LIN-1"), assignee: { displayName: "Me", isMe: true } },
        { ...linearNode("LIN-2"), assignee: { displayName: "Other", isMe: false } },
        linearNode("LIN-3")] } } });
    }));
    expect(linear.issues.map(issue => issue.assignedToMe)).toEqual([true, false, false]);

    // Every issue in the assigned list is the login's.
    const assigned = await run(primary, "assigned", undefined, { tracker: "jira" }, services(fresh(), directory, url => {
      const panel = jiraPanel(url, {}, {});
      if (panel !== null) return panel;
      expect(url.pathname).toBe("/rest/api/3/search/jql");
      return Response.json({ issues: [jiraAssigned("ENG-1", "acc-me")] });
    }));
    expect(assigned.issues.map(issue => issue.assignedToMe)).toEqual([true]);
  });
});
