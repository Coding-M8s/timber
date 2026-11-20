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
const linearNode = (key: string, type = "unstarted") => ({ identifier: key, url: `https://linear.app/acme/issue/${key}/x`,
  title: `Title ${key}`, state: { name: type === "started" ? "In Progress" : "Todo", type }, assignee: null });
const graphqlBody = (init: RequestInit) => JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };

const iterations = [
  { id: "past", title: "Sprint 1", startDate: "2026-11-02", duration: 14 },
  { id: "now", title: "Sprint 2", startDate: "2026-11-16", duration: 14 },
];
const githubSprint: Answer = (url, init) => {
  expect(url.href).toBe("https://api.github.com/graphql");
  const { query, variables } = graphqlBody(init);
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

const jiraSprint: Answer = url => {
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

const linearCycle: Answer = (_url, init) => {
  const { variables } = graphqlBody(init);
  expect(variables).toMatchObject({ team: "LIN" });
  return Response.json({ data: { teams: { nodes: [{ activeCycle: { name: null, number: 4, issues: {
    pageInfo: { hasNextPage: false, endCursor: null }, nodes: [linearNode("LIN-3", "started"), linearNode("LIN-4")] } } }] } } });
};

const run = (primary: string, query: string, text: string | undefined, options: AppIssuesOptions, service: AppIssuesServices) =>
  readAppIssues(primary, query, text, options, service);

const noSecrets = (record: AppIssuesRecord) => { for (const secret of secrets) expect(JSON.stringify(record)).not.toContain(secret); };

test("the current sprint of GitHub, Jira and Linear lists every issue, marks linked worktrees and changes nothing", async () => {
  await withFixture(async ({ primary, directory, paths, all }) => {
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
        worktree: { path: paths.github!, branch: "feature/github" } },
      { tracker: "github", key: "43", url: "https://github.com/acme/widgets/issues/43", title: "Issue 43",
        status: { name: "Closed", category: "closed" }, assignee: "octo", worktree: null },
      // The same number in another repository is a different issue, so it has no worktree.
      { tracker: "github", key: "42", url: "https://github.com/other/repo/issues/42", title: "Issue 42",
        status: { name: "Open", category: "open" }, assignee: "octo", worktree: null },
    ]);

    expect(jira).toMatchObject({ tracker: "jira", outcome: "found", sprint: { name: "ENG Sprint 9", source: "jira-board" }, truncated: false });
    expect(jira.issues.map(issue => [issue.key, issue.status.category, issue.worktree?.branch ?? null])).toEqual([
      ["ENG-7", "in-progress", "feature/jira"], ["ENG-8", "open", null], ["ENG-9", "closed", null], ["ENG-10", "open", null]]);
    expect(jira.issues[0]).toMatchObject({ url: "https://acme.atlassian.net/browse/ENG-7", title: "Title ENG-7", assignee: "Ada" });

    expect(linear).toMatchObject({ tracker: "linear", outcome: "found", sprint: { name: "Cycle 4", source: "linear-cycle" } });
    expect(linear.issues.map(issue => [issue.key, issue.status.category, issue.worktree?.path ?? null])).toEqual([
      ["LIN-3", "in-progress", paths.linear!], ["LIN-4", "open", null]]);

    const methods = seen.requests.map(request => `${request.init.method} ${new URL(request.url).host}`);
    expect(methods).toEqual(["POST api.github.com", "POST api.github.com", "POST api.github.com",
      "GET acme.atlassian.net", "GET acme.atlassian.net", "GET acme.atlassian.net", "POST api.linear.app"]);
    for (const record of [github, jira, linear]) noSecrets(record);
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
    expect(seen.requests.every(request => request.url.startsWith("https://api.github.com/repos/acme/widgets/"))).toBeTrue();

    const jira = await run(primary, "search", "eng-7", { tracker: "jira" }, services(fresh(), directory, url => {
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
