import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { snapshot } from "./helpers/snapshot";
import { readAppIssue } from "../src/app-issue/read";
import type { AppIssueServices } from "../src/app-issue/read";
import { loadRepositoryConfig } from "../src/config";
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

interface Seen { requests: { url: string; init: RequestInit }[]; logins: number }

type Answer = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Real Git reads; trackers answer through `answer`, and every login read is counted. */
function services(seen: Seen, home: string, answer: Answer, overrides: Partial<AppIssueServices["trackers"]> = {},
  timeoutMs = 5_000): AppIssueServices {
  const env = { XDG_CONFIG_HOME: join(home, "config"), JIRA_EMAIL: jiraEmail, JIRA_API_TOKEN: jiraToken };
  return {
    discoverRepository: cwd => discoverRepository(cwd),
    loadConfig: repository => loadRepositoryConfig(repository, env),
    listWorktreeInventory: repository => listWorktreeInventory(repository),
    readIssueLink: (repository, tree) => readIssueLink(repository, tree),
    timeoutMs,
    trackers: {
      env,
      fetch: async (url, init) => { seen.requests.push({ url, init }); return answer(url, init); },
      githubToken: async () => { seen.logins++; return githubToken; },
      linearToken: async () => { seen.logins++; return linearToken; },
      jiraCredentials: async () => { seen.logins++; return null; },
      ...overrides,
    },
  };
}

const fresh = (): Seen => ({ requests: [], logins: 0 });

/** One linked worktree per tracker, an unlinked one and a detached one, beside a Jira site setting. */
async function withLinkedWorktrees(run: (fixture: { primary: string; directory: string; paths: Record<string, string>; all: string[] }) => Promise<void>) {
  await withRepository(async (primary, directory) => {
    await git(primary, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    await writeFile(join(primary, ".timber.toml"), '[jira]\nsite_url = "https://acme.atlassian.net"\n');
    await mkdir(join(directory, "config"));
    const paths: Record<string, string> = {};
    for (const name of ["github", "jira", "linear", "unlinked"]) {
      paths[name] = join(directory, `tree ${name}`);
      await git(primary, "worktree", "add", "-b", `feature/${name}`, paths[name]!);
    }
    paths.detached = join(directory, "tree detached");
    await git(primary, "worktree", "add", "--detach", paths.detached);
    const repository = await discoverRepository(primary);
    const trees = await listWorktrees(repository);
    for (const name of ["github", "jira", "linear"]) {
      await writeIssueLink(repository, trees.find(tree => tree.path === paths[name])!, links[name]!);
    }
    await writeFile(join(paths.github!, "untracked.txt"), "keep me\n");
    await writeFile(join(paths.jira!, "tracked.txt"), "modified\n");
    await writeFile(join(paths.linear!, ".env"), "SECRET=ignored\n");
    await run({ primary, directory, paths, all: [primary, ...Object.values(paths)] });
  });
}

const githubAnswer: Answer = url => {
  expect(url).toBe("https://api.github.com/repos/acme/widgets/issues/42");
  return Response.json({ number: 42, title: "Widgets wobble", state: "open", assignee: { login: "octo" } });
};
const jiraAnswer: Answer = url => {
  expect(new URL(url).pathname).toBe("/rest/api/3/issue/ENG-7");
  return Response.json({ key: "ENG-7", fields: { summary: "Ship the thing", assignee: { displayName: "Ada Lovelace" },
    status: { name: "In Review", statusCategory: { key: "indeterminate" } } } });
};
const linearAnswer: Answer = (_url, init) => {
  expect(JSON.parse(String(init.body)).variables).toEqual({ id: "LIN-3" });
  return Response.json({ data: { issue: { title: "Fix the thing", trashed: false, state: { name: "Done", type: "completed" }, assignee: null } } });
};

test("GitHub, Jira and Linear issues report key, title, status, assignee and URL without changing the repository", async () => {
  await withLinkedWorktrees(async ({ primary, directory, paths, all }) => {
    const before = await snapshot(directory, all);
    const seen = fresh();
    const github = await readAppIssue(primary, paths.github!, services(seen, directory, githubAnswer));
    const jira = await readAppIssue(paths.jira!, "feature/jira", services(seen, directory, jiraAnswer));
    const linear = await readAppIssue(primary, paths.linear!, services(seen, directory, linearAnswer));
    expect(await snapshot(directory, all)).toBe(before);

    expect(github).toEqual({ schemaVersion: 1, outcome: "found", reason: null, diagnostic: null,
      repository: { commonGitDir: join(primary, ".git"), primaryWorktreeRoot: primary, currentWorktreeRoot: primary },
      worktree: { path: paths.github!, branch: "feature/github", isPrimary: false },
      issue: { ...links.github!, title: "Widgets wobble", status: { name: "Open", category: "open" }, assignee: "octo" } });
    expect(jira).toMatchObject({ outcome: "found", worktree: { path: paths.jira!, branch: "feature/jira" },
      issue: { ...links.jira!, title: "Ship the thing", status: { name: "In Review", category: "in-progress" }, assignee: "Ada Lovelace" } });
    expect(jira.repository?.currentWorktreeRoot).toBe(paths.jira!);
    expect(linear).toMatchObject({ outcome: "found",
      issue: { ...links.linear!, title: "Fix the thing", status: { name: "Done", category: "closed" }, assignee: null } });

    expect(seen.requests.map(request => request.init.method)).toEqual(["GET", "GET", "POST"]);
    const headers = seen.requests.map(request => request.init.headers as Record<string, string>);
    expect(headers[0]!.Authorization).toBe(`Bearer ${githubToken}`);
    expect(headers[1]!.Authorization).toBe(`Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString("base64")}`);
    expect(headers[2]!.Authorization).toBe(linearToken);
    expect(seen.requests[1]!.url.startsWith("https://acme.atlassian.net/")).toBeTrue();
    for (const record of [github, jira, linear]) for (const secret of secrets) expect(JSON.stringify(record)).not.toContain(secret);
  });
});

test("a closed GitHub issue and a to-do Jira issue map their status categories", async () => {
  await withLinkedWorktrees(async ({ primary, paths }) => {
    const closed = await readAppIssue(primary, paths.github!, services(fresh(), "/unused", () =>
      Response.json({ title: "Done already", state: "closed", assignee: null })));
    expect(closed.issue).toMatchObject({ status: { name: "Closed", category: "closed" }, assignee: null });
    const todo = await readAppIssue(primary, paths.jira!, services(fresh(), "/unused", () =>
      Response.json({ fields: { summary: "Later", assignee: null, status: { name: "To Do", statusCategory: { key: "new" } } } })));
    expect(todo.issue).toMatchObject({ status: { name: "To Do", category: "open" }, assignee: null });
  });
});

test("an unlinked, detached or primary worktree reports none without reading a login or contacting a tracker", async () => {
  await withLinkedWorktrees(async ({ primary, paths }) => {
    for (const target of [paths.unlinked!, "feature/unlinked", paths.detached!, primary, "trunk"]) {
      const seen = fresh();
      const record = await readAppIssue(primary, target, services(seen, "/unused", () => { throw new Error("must not fetch"); }, {
        githubToken: async () => { throw new Error("must not read a login"); },
      }));
      expect(record).toMatchObject({ outcome: "none", issue: null, reason: null, diagnostic: null });
      expect(record.worktree).not.toBeNull();
      expect(seen).toEqual({ requests: [], logins: 0 });
    }
  });
});

test("missing logins, rejected logins, missing issues and denied access each report their reason", async () => {
  await withLinkedWorktrees(async ({ primary, directory, paths, all }) => {
    const before = await snapshot(directory, all);
    const cases: [string, AppIssueServices, string][] = [
      [paths.github!, services(fresh(), directory, githubAnswer, { githubToken: async () => { throw new Error(`gh failed near ${githubToken}`); } }), "sign-in-needed"],
      [paths.linear!, services(fresh(), directory, linearAnswer, { linearToken: async () => { throw new Error("Linear credentials are missing."); } }), "sign-in-needed"],
      [paths.github!, services(fresh(), directory, () => new Response(`bad credentials ${githubToken}`, { status: 401 })), "sign-in-needed"],
      [paths.linear!, services(fresh(), directory, () => Response.json({ errors: [{ message: linearToken,
        extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 400 })), "sign-in-needed"],
      [paths.github!, services(fresh(), directory, () => new Response(null, { status: 404 })), "not-found"],
      [paths.jira!, services(fresh(), directory, () => new Response(null, { status: 404 })), "not-found"],
      [paths.linear!, services(fresh(), directory, () => Response.json({ errors: [{ message: "Entity not found: Issue",
        extensions: { code: "INPUT_ERROR" } }] }, { status: 400 })), "not-found"],
      [paths.linear!, services(fresh(), directory, () => Response.json({ data: { issue: { title: "Gone", trashed: true,
        state: { name: "Todo", type: "unstarted" }, assignee: null } } })), "not-found"],
      [paths.jira!, services(fresh(), directory, () => new Response(null, { status: 403 })), "forbidden"],
      [paths.github!, services(fresh(), directory, () => new Response(null, { status: 403 })), "forbidden"],
      [paths.linear!, services(fresh(), directory, () => Response.json({ errors: [{ message: "no", extensions: { code: "FORBIDDEN" } }] })), "forbidden"],
      [paths.github!, services(fresh(), directory, () => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } })), "failed"],
      [paths.github!, services(fresh(), directory, () => Response.json({ title: "", state: "open" })), "failed"],
      [paths.jira!, services(fresh(), directory, () => new Response("not json")), "failed"],
      [paths.github!, services(fresh(), directory, () => new Response(null, { status: 301, headers: { location: "https://api.github.com/x" } })), "failed"],
    ];
    for (const [target, service, reason] of cases) {
      const record = await readAppIssue(primary, target, service);
      expect(record).toMatchObject({ outcome: "failed", reason, issue: null });
      expect(record.diagnostic).toBeString();
      for (const secret of secrets) expect(JSON.stringify(record)).not.toContain(secret);
    }
    expect(await snapshot(directory, all)).toBe(before);
  });
});

test("Jira without a site or login reports sign-in-needed, and a different site is refused, without contacting Jira", async () => {
  await withLinkedWorktrees(async ({ primary, directory, paths }) => {
    const noFetch = () => { throw new Error("must not fetch"); };
    const signedOut = services(fresh(), directory, noFetch);
    signedOut.trackers.env = { XDG_CONFIG_HOME: join(directory, "config") };
    const missing = await readAppIssue(primary, paths.jira!, signedOut);
    expect(missing).toMatchObject({ outcome: "failed", reason: "sign-in-needed" });
    expect(missing.diagnostic).toContain("JIRA credentials are missing");

    await writeFile(join(primary, ".timber.toml"), '[jira]\nsite_url = "https://other.atlassian.net"\n');
    const elsewhere = await readAppIssue(primary, paths.jira!, services(fresh(), directory, noFetch));
    expect(elsewhere).toMatchObject({ outcome: "failed", reason: "failed" });
    expect(elsewhere.diagnostic).toContain("different Jira site");

    await writeFile(join(primary, ".timber.toml"), "");
    const unset = await readAppIssue(primary, paths.jira!, services(fresh(), directory, noFetch));
    expect(unset).toMatchObject({ outcome: "failed", reason: "sign-in-needed" });
    expect(unset.diagnostic).toContain("timber setup");
  });
});

test("an unreachable or slow tracker reports offline within the time limit", async () => {
  await withLinkedWorktrees(async ({ primary, directory, paths }) => {
    const unreachable = await readAppIssue(primary, paths.linear!, services(fresh(), directory, () => {
      throw new TypeError(`connect failed ${linearToken}`);
    }));
    expect(unreachable).toMatchObject({ outcome: "failed", reason: "offline" });
    expect(JSON.stringify(unreachable)).not.toContain(linearToken);
    const started = Date.now();
    // A request that ignores its abort signal still cannot hold the call past the limit.
    const slow = await readAppIssue(primary, paths.github!, services(fresh(), directory, () => new Promise<Response>(() => {}), {}, 200));
    const slowLogin = await readAppIssue(primary, paths.linear!, services(fresh(), directory, linearAnswer, {
      linearToken: () => new Promise<string>(() => {}) }, 200));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(slow).toMatchObject({ outcome: "failed", reason: "offline" });
    expect(slowLogin).toMatchObject({ outcome: "failed", reason: "offline" });
  });
});

test("damaged link metadata and unknown worktrees fail without contacting a tracker", async () => {
  await withLinkedWorktrees(async ({ primary, paths }) => {
    const repository = await discoverRepository(primary);
    const linked = (await listWorktrees(repository)).find(tree => tree.path === paths.github!)!;
    const file = join(await git(paths.github!, "rev-parse", "--path-format=absolute", "--git-dir"), "timber", "issue.json");
    expect(await readIssueLink(repository, linked)).toMatchObject({ kind: "linked" });
    await writeFile(file, "{not json");
    const seen = fresh();
    const noFetch = () => { throw new Error("must not fetch"); };
    const damaged = await readAppIssue(primary, paths.github!, services(seen, "/unused", noFetch));
    expect(damaged).toMatchObject({ outcome: "failed", reason: "failed", worktree: { path: paths.github! } });
    expect(damaged.diagnostic).toContain("malformed");
    expect(await readFile(file, "utf8")).toBe("{not json");
    for (const target of ["feature/nothing", join(primary, "..", "not a worktree"), "tree github"]) {
      const unknown = await readAppIssue(primary, target, services(seen, "/unused", noFetch));
      expect(unknown).toMatchObject({ outcome: "failed", reason: "failed", worktree: null });
      expect(unknown.diagnostic).toContain("No registered worktree");
    }
    expect(seen).toEqual({ requests: [], logins: 0 });
  });
});

/** The real CLI with stdin closed, no terminal and CI on. */
async function cli(cwd: string, args: string[], env: Record<string, string | undefined>) {
  const result = await execa(process.execPath, ["--no-env-file", entry, "__app-issue", ...args], {
    cwd, reject: false, timeout: 30_000, stdin: "ignore",
    env: { CI: "true", GH_TOKEN: undefined, GITHUB_TOKEN: undefined, LINEAR_API_KEY: undefined, JIRA_EMAIL: undefined,
      JIRA_API_TOKEN: undefined, HTTPS_PROXY: undefined, https_proxy: undefined, ...env },
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, record: JSON.parse(result.stdout) };
}

test("the CLI reports none, missing logins and offline with no prompt, no token and no change", async () => {
  await withLinkedWorktrees(async ({ primary, directory, paths, all }) => {
    const bin = join(directory, "bin");
    await mkdir(bin);
    // A GitHub CLI without a login, as gh behaves when signed out.
    await writeFile(join(bin, "gh"), "#!/bin/sh\necho 'You are not logged into any GitHub hosts.' >&2\nexit 1\n");
    await chmod(join(bin, "gh"), 0o755);
    const home = { XDG_CONFIG_HOME: join(directory, "config"), HOME: directory };
    const before = await snapshot(directory, all);
    const none = await cli(primary, ["--", paths.unlinked!], home);
    const signedOut = await cli(primary, ["--", paths.github!], { ...home, PATH: `${bin}:${process.env.PATH}` });
    const linearOut = await cli(primary, ["--", paths.linear!], home);
    const jiraOut = await cli(primary, ["feature/jira"], home);
    // Connection refused at a local proxy stands in for having no network.
    const offline = await cli(primary, ["--", paths.github!], { ...home, GH_TOKEN: githubToken,
      HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" });
    const unknown = await cli(primary, ["feature/nothing"], home);
    expect(await snapshot(directory, all)).toBe(before);

    expect(none.exitCode).toBe(0);
    expect(none.record).toMatchObject({ schemaVersion: 1, outcome: "none", worktree: { path: paths.unlinked! } });
    for (const [run, reason] of [[signedOut, "sign-in-needed"], [linearOut, "sign-in-needed"], [jiraOut, "sign-in-needed"],
      [offline, "offline"], [unknown, "failed"]] as const) {
      expect(run.exitCode).toBe(1);
      expect(run.record).toMatchObject({ schemaVersion: 1, outcome: "failed", reason, issue: null });
    }
    for (const run of [none, signedOut, linearOut, jiraOut, offline, unknown]) {
      expect(run.stdout.trim().split("\n")).toHaveLength(1);
      expect(run.stdout + run.stderr).not.toContain(githubToken);
    }
  });
});

test("the CLI outside a repository prints one failed record", async () => {
  await withRepository(async (_primary, directory) => {
    const outside = join(directory, "outside");
    await mkdir(outside);
    const run = await cli(outside, ["anything"], { GIT_CEILING_DIRECTORIES: directory });
    expect(run.exitCode).toBe(1);
    expect(run.record).toMatchObject({ schemaVersion: 1, repository: null, worktree: null, outcome: "failed", reason: "failed" });
    expect(run.record.diagnostic).toBeString();
  });
});
