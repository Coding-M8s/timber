import { expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { snapshot } from "./helpers/snapshot";
import { readAppPullRequests } from "../src/app-pr/read";
import type { AppPullRequestServices } from "../src/app-pr/read";
import type { BitbucketRuntime } from "../src/bitbucket/client";
import { loadRepositoryConfig } from "../src/config";
import { listBranches } from "../src/git/branches";
import { discoverRepository } from "../src/git/repository";
import { listWorktreeInventory } from "../src/git/worktrees";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const email = "dev@example.invalid";
const token = "ATATT_SECRET_TOKEN_7c2f";

interface Seen { urls: URL[]; logins: number; authorization: string[] }

const account = (name: string, extra: Record<string, unknown> = {}) => ({ type: "user", display_name: name, nickname: name.toLowerCase(),
  uuid: `{${name.toLowerCase()}-uuid}`, account_id: `id-${name.toLowerCase()}`,
  links: { html: { href: `https://bitbucket.org/%7B${name.toLowerCase()}-uuid%7D/` } }, ...extra });
const participant = (user: unknown, role: string, state: string | null, approved = state === "approved") =>
  ({ type: "participant", user, role, state, approved, participated_on: state === null && role === "REVIEWER" ? null : "2026-11-20T10:00:00Z" });

/** A pull request as Bitbucket's list endpoint returns it with participants asked for. */
function pr(id: number, branch: string, extra: Record<string, unknown> = {}, source = "acme/widgets") {
  return {
    type: "pullrequest", id, title: `Change ${id}`, state: "OPEN", draft: false, description: `Body ${id}`,
    summary: { raw: `Body ${id}`, markup: "markdown" }, created_on: `2026-11-${String(id).padStart(2, "0")}T00:00:00Z`,
    source: { branch: { name: branch }, commit: { hash: "f6ff5828963e" }, repository: { type: "repository", full_name: source } },
    destination: { branch: { name: "trunk" }, repository: { type: "repository", full_name: "acme/widgets" } },
    participants: [], ...extra,
  };
}

const status = (name: string, state: string, url: string | null = null) => ({ type: "build", key: `key-${name}`, name, state, url });

/**
 * Real Git reads; Bitbucket answers every list request with all of `pulls`, ignoring the
 * query, so the reader's own filtering is what is tested. Statuses come from `statuses` by id.
 */
function services(seen: Seen, pulls: unknown[], statuses: Record<number, unknown[]> = {},
  overrides: Partial<BitbucketRuntime> = {}): AppPullRequestServices {
  return {
    discoverRepository: cwd => discoverRepository(cwd),
    loadConfig: repository => loadRepositoryConfig(repository),
    listWorktreeInventory: repository => listWorktreeInventory(repository),
    listBranches: repository => listBranches(repository),
    env: {},
    github: {
      token: async () => { throw new Error("must not read a GitHub login"); },
      fetch: async () => { throw new Error("must not contact GitHub"); },
      timeoutMs: 5_000,
    },
    bitbucket: {
      login: async () => { seen.logins++; return { email, token }; },
      fetch: async (url, init) => {
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("error");
        seen.authorization.push(String((init.headers as Record<string, string>).Authorization));
        const parsed = new URL(url);
        seen.urls.push(parsed);
        // Bitbucket paths ignore case.
        const route = parsed.pathname.toLowerCase();
        const match = /^\/2\.0\/repositories\/acme\/widgets\/pullrequests\/(\d+)\/statuses$/u.exec(route);
        if (match) return Response.json({ pagelen: 100, values: statuses[Number(match[1])] ?? [] });
        expect(route).toBe("/2.0/repositories/acme/widgets/pullrequests");
        return Response.json({ pagelen: 50, values: pulls });
      },
      timeoutMs: 5_000,
      ...overrides,
    },
  };
}

const fresh = (): Seen => ({ urls: [], logins: 0, authorization: [] });

async function withWorktrees(run: (fixture: { primary: string; directory: string; paths: string[] }) => Promise<void>) {
  await withRepository(async (primary, directory) => {
    await git(primary, "remote", "add", "origin", "git@bitbucket.org:acme/widgets.git");
    const paths = [primary];
    for (const branch of ["feature/open", "feature/draft", "feature/merged", "feature/declined", "feature/superseded", "feature/none"]) {
      const path = join(directory, branch.replace("/", "-"));
      await git(primary, "worktree", "add", "-b", branch, path);
      paths.push(path);
    }
    const detached = join(directory, "detached");
    await git(primary, "worktree", "add", "--detach", detached);
    paths.push(detached);
    await writeFile(join(paths[1]!, "untracked.txt"), "keep me\n");
    await run({ primary, directory, paths });
  });
}

test("a bitbucket.org remote is read from Bitbucket with state, checks, review and reviewers mapped", async () => {
  await withWorktrees(async ({ primary, directory, paths }) => {
    const seen = fresh();
    const before = await snapshot(directory, paths);
    const record = await readAppPullRequests(paths[1]!, services(seen, [
      pr(1, "feature/open", { participants: [
        participant(account("Rita"), "REVIEWER", null),
        participant(account("Alice"), "REVIEWER", "approved"),
        participant(account("Carol"), "PARTICIPANT", null),
        participant(account("dc-bot", { type: "app_user", links: {} }), "PARTICIPANT", null),
        participant({ type: "user", display_name: "Mallory", uuid: "{mallory}", links: { html: { href: "javascript:alert(1)" } } }, "PARTICIPANT", null),
      ] }),
      pr(2, "feature/draft", { draft: true, description: null, summary: { raw: "From summary" } }),
      pr(3, "feature/merged", { state: "MERGED", participants: [participant(account("Bob"), "REVIEWER", "changes_requested")] }),
      pr(4, "feature/declined", { state: "DECLINED" }),
      pr(5, "feature/superseded", { state: "SUPERSEDED" }),
      // A newer merged pull request does not hide the branch's open one.
      pr(6, "feature/open", { state: "MERGED" }),
      // Another fork's branch with the same name is not this branch.
      pr(7, "feature/none", {}, "someone/widgets"),
      // A pull request whose source fork was deleted is never this branch.
      pr(8, "feature/none", { source: { branch: { name: "feature/none" }, commit: null, repository: null } }),
    ], {
      1: [status("test", "SUCCESSFUL", "https://ci.example.invalid/1"), status("lint", "INPROGRESS"),
        status("deploy", "STOPPED", "javascript:alert(1)"), status("e2e", "FAILED")],
      2: [status("test", "SUCCESSFUL")],
      3: [status("test", "FAILED")],
    }));
    expect(await snapshot(directory, paths)).toBe(before);
    expect(record.diagnostic).toBeNull();
    expect(record.pullRequestRepository).toEqual({ host: "bitbucket", owner: "acme", name: "widgets" });
    // Kept GitHub-only, so existing consumers never read a Bitbucket repository as a GitHub one.
    expect(record.github).toBeNull();
    const byBranch = Object.fromEntries(record.worktrees.map(item => [item.branch ?? "(detached)", item]));
    expect(byBranch["feature/open"]).toEqual({ path: paths[1]!, branch: "feature/open", isPrimary: false, outcome: "found",
      reason: null, diagnostic: null, pullRequest: { number: 1, url: "https://bitbucket.org/acme/widgets/pull-requests/1",
        title: "Change 1", state: "open", baseBranch: "trunk", description: "Body 1", review: "approved", reviewersComplete: true,
        checks: { summary: "failing", runs: [
          { name: "test", status: "passing", url: "https://ci.example.invalid/1" },
          { name: "lint", status: "pending", url: null },
          { name: "deploy", status: "failing", url: null },
          { name: "e2e", status: "failing", url: null },
        ] },
        reviewers: [
          { kind: "user", name: "Rita", state: "requested", url: "https://bitbucket.org/%7Brita-uuid%7D/" },
          { kind: "user", name: "Alice", state: "approved", url: "https://bitbucket.org/%7Balice-uuid%7D/" },
          { kind: "user", name: "Carol", state: "commented", url: "https://bitbucket.org/%7Bcarol-uuid%7D/" },
          { kind: "bot", name: "dc-bot", state: "commented", url: null },
          { kind: "user", name: "Mallory", state: "commented", url: null },
        ] } });
    expect(byBranch["feature/draft"]!.pullRequest).toMatchObject({ number: 2, state: "draft", description: "From summary",
      review: "none", reviewers: [], reviewersComplete: true, checks: { summary: "passing" } });
    // Build statuses are read only for open and draft pull requests.
    expect(byBranch["feature/merged"]!.pullRequest).toMatchObject({ number: 3, state: "merged", review: "changes-requested",
      reviewers: [{ name: "Bob", state: "changes-requested" }], checks: { summary: "none", runs: [] } });
    expect(byBranch["feature/declined"]!.pullRequest).toMatchObject({ number: 4, state: "closed" });
    expect(byBranch["feature/superseded"]!.pullRequest).toMatchObject({ number: 5, state: "closed" });
    expect(byBranch["feature/none"]).toMatchObject({ outcome: "none", pullRequest: null, reason: null });
    expect(byBranch["(detached)"]).toMatchObject({ branch: null, outcome: "none" });
    expect(record.worktrees[0]).toMatchObject({ branch: "trunk", outcome: "none" });

    expect(seen.logins).toBe(1);
    expect(new Set(seen.authorization)).toEqual(new Set([`Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`]));
    const lists = seen.urls.filter(url => url.pathname.endsWith("/pullrequests"));
    // One open and one closed list cover every branch; the state sits inside q, never as a parameter.
    expect(lists).toHaveLength(2);
    for (const url of lists) {
      expect(url.searchParams.has("state")).toBe(false);
      expect(url.searchParams.get("sort")).toBe("-created_on");
      expect(url.searchParams.get("fields")).toBe("+values.participants");
      expect(url.search).toContain("fields=%2Bvalues.participants");
    }
    const [open, closed] = [lists.find(url => url.searchParams.get("q")!.startsWith('(state = "OPEN")'))!,
      lists.find(url => !url.searchParams.get("q")!.startsWith('(state = "OPEN")'))!].map(url => url.searchParams.get("q")!);
    expect(open).toContain('(source.branch.name = "feature/open" AND source.repository.full_name = "acme/widgets")');
    // Branches with an open pull request are not asked for closed ones.
    expect(closed).not.toContain('"feature/open"');
    expect(closed).not.toContain('"feature/draft"');
    expect(closed).toContain('(source.branch.name = "feature/merged" AND source.repository.full_name = "acme/widgets")');
    expect(lists.map(url => url.searchParams.get("q")!.split(" AND (")[0]).sort()).toEqual([
      '(state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED")', '(state = "OPEN")']);
    expect(seen.urls.filter(url => url.pathname.endsWith("/statuses")).map(url => url.pathname).sort()).toEqual([
      "/2.0/repositories/acme/widgets/pullrequests/1/statuses", "/2.0/repositories/acme/widgets/pullrequests/2/statuses"]);
    expect(JSON.stringify(record)).not.toContain(token);
  });
});

test("participants missing from the list leave reviewers incomplete; a reviewer with no decision requires review", async () => {
  await withRepository(async primary => {
    await git(primary, "remote", "add", "origin", "https://dev@bitbucket.org/acme/widgets.git");
    const { participants: _dropped, ...bare } = pr(1, "trunk");
    const missing = await readAppPullRequests(primary, services(fresh(), [bare]));
    expect(missing.worktrees[0]!.pullRequest).toMatchObject({ reviewers: [], reviewersComplete: false, review: "none" });
    const waiting = await readAppPullRequests(primary, services(fresh(), [pr(1, "trunk", { participants: [
      participant(account("Rita"), "REVIEWER", null), participant(account("Rita"), "REVIEWER", null), { role: "REVIEWER" },
    ] })]));
    expect(waiting.worktrees[0]!.pullRequest).toMatchObject({ review: "review-required", reviewersComplete: false,
      reviewers: [{ kind: "user", name: "Rita", state: "requested" }] });
  });
});

test("a branch pushed to a Bitbucket fork is matched on the fork and upstream branch name", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "remote", "add", "origin", "https://bitbucket.org/acme/widgets.git");
    await git(primary, "remote", "add", "fork", "git@bitbucket.org:me/widgets-fork.git");
    await git(primary, "worktree", "add", "-b", "local-name", join(directory, "fork"));
    await git(primary, "update-ref", "refs/remotes/fork/pushed-name", "HEAD");
    await git(primary, "config", "branch.local-name.remote", "fork");
    await git(primary, "config", "branch.local-name.merge", "refs/heads/pushed-name");
    const seen = fresh();
    const record = await readAppPullRequests(primary, services(seen, [
      pr(12, "pushed-name", {}, "acme/widgets"), pr(11, "pushed-name", {}, "ME/Widgets-Fork"),
    ]));
    expect(record.worktrees.find(item => item.branch === "local-name")!.pullRequest).toMatchObject({ number: 11 });
    const q = seen.urls[0]!.searchParams.get("q")!;
    expect(q).toContain('(source.branch.name = "pushed-name" AND source.repository.full_name = "me/widgets-fork")');
    expect(q).not.toContain("local-name");
  });
});

test("a missing login, a rejected one, an unreachable or slow Bitbucket and bad answers fail without echoing anything", async () => {
  await withRepository(async primary => {
    await git(primary, "remote", "add", "origin", "https://bitbucket.org/acme/widgets.git");
    const unread = fresh();
    const missing = await readAppPullRequests(primary, services(unread, [], {}, {
      login: async () => { throw new Error(`Bitbucket login is missing near ${token}`); },
    }));
    expect(missing.worktrees[0]).toMatchObject({ outcome: "failed", reason: "sign-in-needed" });
    expect(unread.urls).toHaveLength(0);
    const rejected = await readAppPullRequests(primary, services(fresh(), [], {}, {
      fetch: async () => new Response(`bad credentials for ${email} ${token}`, { status: 401 }),
    }));
    expect(rejected.worktrees[0]).toMatchObject({ outcome: "failed", reason: "sign-in-needed" });
    const unreachable = await readAppPullRequests(primary, services(fresh(), [], {}, {
      fetch: async () => { throw new TypeError(`connect failed ${token}`); },
    }));
    expect(unreachable.worktrees[0]).toMatchObject({ outcome: "failed", reason: "offline" });
    const started = Date.now();
    // A request that ignores its abort signal still cannot hold the call past the limit.
    const slow = await readAppPullRequests(primary, services(fresh(), [], {}, {
      fetch: () => new Promise<Response>(() => {}), timeoutMs: 200,
    }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(slow.worktrees[0]).toMatchObject({ outcome: "failed", reason: "offline" });
    const limited = await readAppPullRequests(primary, services(fresh(), [], {}, {
      fetch: async () => new Response(`rate limited ${token}`, { status: 429 }),
    }));
    expect(limited.worktrees[0]).toMatchObject({ outcome: "failed", reason: "failed" });
    const broken = await readAppPullRequests(primary, services(fresh(), [], {}, {
      fetch: async () => Response.json({ values: [{ id: "one", title: token }] }),
    }));
    expect(broken.worktrees[0]).toMatchObject({ outcome: "failed", reason: "failed" });
    const statusFailed = await readAppPullRequests(primary, services(fresh(), [], {}, {
      fetch: async url => url.includes("/statuses") ? new Response(token, { status: 500 }) : Response.json({ values: [pr(1, "trunk")] }),
    }));
    expect(statusFailed.worktrees[0]).toMatchObject({ outcome: "failed", reason: "failed" });
    for (const record of [missing, rejected, unreachable, slow, limited, broken, statusFailed]) {
      expect(record.pullRequestRepository).toEqual({ host: "bitbucket", owner: "acme", name: "widgets" });
      expect(JSON.stringify(record)).not.toContain(token);
      expect(JSON.stringify(record)).not.toContain(email);
    }
  });
});

test("a mixed-case remote is queried in lower case and the author is not listed as a reviewer", async () => {
  await withRepository(async primary => {
    await git(primary, "remote", "add", "origin", "git@bitbucket.org:Acme/Widgets.git");
    const seen = fresh();
    const record = await readAppPullRequests(primary, services(seen, [pr(1, "trunk", {
      author: { type: "user", uuid: "{dana-uuid}", account_id: "id-dana" },
      participants: [participant(account("Dana"), "PARTICIPANT", null), participant(account("Rita"), "REVIEWER", null)],
    }, "acme/widgets")]));
    expect(seen.urls[0]!.searchParams.get("q")).toContain('source.repository.full_name = "acme/widgets"');
    expect(record.worktrees[0]!.pullRequest).toMatchObject({ number: 1, reviewersComplete: true,
      reviewers: [{ name: "Rita", state: "requested" }] });
    expect(record.worktrees[0]!.pullRequest!.reviewers).toHaveLength(1);
  });
});

test("two open pull requests on one branch report the newest, and an upstream on another host is not used", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "remote", "add", "origin", "https://bitbucket.org/acme/widgets.git");
    await git(primary, "remote", "add", "mirror", "https://github.com/me/widgets.git");
    await git(primary, "worktree", "add", "-b", "local-name", join(directory, "mirror"));
    await git(primary, "update-ref", "refs/remotes/mirror/pushed-name", "HEAD");
    await git(primary, "config", "branch.local-name.remote", "mirror");
    await git(primary, "config", "branch.local-name.merge", "refs/heads/pushed-name");
    const seen = fresh();
    const record = await readAppPullRequests(primary, services(seen, [pr(3, "trunk"), pr(9, "trunk"), pr(4, "local-name")]));
    expect(record.worktrees.find(item => item.branch === "trunk")!.pullRequest).toMatchObject({ number: 9 });
    expect(record.worktrees.find(item => item.branch === "local-name")!.pullRequest).toMatchObject({ number: 4 });
    expect(seen.urls[0]!.searchParams.get("q")).not.toContain("pushed-name");
  });
});

test("more than 20 branches are split, and branches pushed off a full page are asked for again together", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "remote", "add", "origin", "https://bitbucket.org/acme/widgets.git");
    const names = Array.from({ length: 22 }, (_, index) => `b${String(index).padStart(2, "0")}`);
    for (const name of names) await git(primary, "worktree", "add", "-b", name, join(directory, name));
    const seen = fresh();
    const flood = Array.from({ length: 50 }, (_, index) => pr(100 + index, "trunk", { state: "MERGED" }));
    const record = await readAppPullRequests(primary, services(seen, [], {}, {
      fetch: async url => {
        const parsed = new URL(url);
        seen.urls.push(parsed);
        const q = parsed.searchParams.get("q")!;
        if (parsed.pathname.endsWith("/statuses") || q.includes('state = "OPEN"')) return Response.json({ values: [] });
        // One busy branch fills the shared page of closed pull requests.
        if (q.includes("trunk")) return Response.json({ values: flood, next: "https://api.bitbucket.org/2.0/next" });
        return Response.json({ values: [...q.matchAll(/source\.branch\.name = "([^"]+)"/gu)]
          .map(([, name]) => pr(Number(name!.slice(1)) + 1, name!, { state: "DECLINED" })) });
      },
    }));
    const lists = seen.urls.filter(url => url.pathname.endsWith("/pullrequests"));
    // Two chunks with an open and a closed list each, plus one list of the 19 branches the busy one crowded out.
    expect(lists).toHaveLength(5);
    expect(seen.urls).toHaveLength(5);
    const again = lists.filter(url => !url.searchParams.get("q")!.includes('state = "OPEN"') && !url.searchParams.get("q")!.includes("trunk"));
    expect(again.map(url => url.searchParams.get("q")!.match(/source\.branch\.name/gu)!.length).sort()).toEqual([19, 3]);
    expect(record.worktrees.find(item => item.branch === "trunk")!.pullRequest).toMatchObject({ number: 149, state: "merged" });
    for (const name of names) {
      expect(record.worktrees.find(item => item.branch === name)!.pullRequest).toMatchObject({ number: Number(name.slice(1)) + 1, state: "closed" });
    }
  });
});

test("denied access and a missing repository fail without echoing Bitbucket's text", async () => {
  await withRepository(async primary => {
    await git(primary, "remote", "add", "origin", "https://bitbucket.org/acme/widgets.git");
    for (const code of [403, 404]) {
      const record = await readAppPullRequests(primary, services(fresh(), [], {}, {
        fetch: async () => new Response(`denied ${token}`, { status: code }),
      }));
      expect(record.worktrees[0]).toMatchObject({ outcome: "failed", reason: "failed" });
      expect(JSON.stringify(record)).not.toContain(token);
    }
  });
});

/** The real CLI with stdin closed, no terminal, CI on and its own empty config home. */
async function cli(cwd: string, home: string, env: Record<string, string | undefined>) {
  const result = await execa(process.execPath, ["--no-env-file", entry, "__app-pr"], {
    cwd, reject: false, timeout: 30_000, stdin: "ignore",
    env: { CI: "true", XDG_CONFIG_HOME: home, BITBUCKET_EMAIL: undefined, BITBUCKET_API_TOKEN: undefined,
      HTTPS_PROXY: undefined, https_proxy: undefined, ...env },
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, record: JSON.parse(result.stdout) };
}

test("the CLI on a Bitbucket remote reports a missing login and offline with no prompt, no token and no change", async () => {
  await withWorktrees(async ({ primary, directory, paths }) => {
    const home = join(directory, "config home");
    await mkdir(home);
    // The login saved by timber setup is read when the environment supplies none.
    const saved = join(directory, "saved home");
    await mkdir(join(saved, "timber", "credentials"), { recursive: true, mode: 0o700 });
    await chmod(join(saved, "timber", "credentials"), 0o700);
    await writeFile(join(saved, "timber", "credentials", "bitbucket.json"), JSON.stringify({ version: 1, email, token }), { mode: 0o600 });
    const before = await snapshot(directory, paths);
    const signedOut = await cli(primary, home, {});
    const savedOffline = await cli(primary, saved, { HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" });
    // Connection refused at a local proxy stands in for having no network.
    const offline = await cli(primary, home, { BITBUCKET_EMAIL: email, BITBUCKET_API_TOKEN: token,
      HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" });
    expect(await snapshot(directory, paths)).toBe(before);
    for (const [run, reason] of [[signedOut, "sign-in-needed"], [offline, "offline"], [savedOffline, "offline"]] as const) {
      expect(run.exitCode).toBe(1);
      expect(run.record).toMatchObject({ schemaVersion: 1, github: null,
        pullRequestRepository: { host: "bitbucket", owner: "acme", name: "widgets" } });
      for (const item of run.record.worktrees) {
        if (item.branch !== null) expect(item).toMatchObject({ outcome: "failed", reason });
      }
      expect(run.stdout + run.stderr).not.toContain(token);
    }
  });
});
