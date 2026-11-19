import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { snapshot } from "./helpers/snapshot";
import { readAppPullRequests } from "../src/app-pr/read";
import type { AppPullRequestServices } from "../src/app-pr/read";
import { loadRepositoryConfig } from "../src/config";
import { listBranches } from "../src/git/branches";
import { discoverRepository } from "../src/git/repository";
import { listWorktreeInventory } from "../src/git/worktrees";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const token = "ghp_SECRET_TOKEN_5d1e9a";

interface Seen { requests: { query: string; variables: Record<string, string> }[]; tokenReads: number }

function pr(number: number, branch: string, extra: Record<string, unknown> = {}, owner = "acme") {
  return {
    number, url: `https://github.com/acme/widgets/pull/${number}`, title: `Change ${number}`, state: "OPEN", isDraft: false,
    baseRefName: "trunk", body: `Body ${number}`, reviewDecision: null, headRefName: branch,
    headRepositoryOwner: { login: owner }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] }, reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] }, ...extra,
  };
}

const rollup = (state: string, nodes: unknown[]) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes } } } }] } });

/** Real Git reads; GitHub answers from `byBranch`, keyed by head branch name. */
function services(seen: Seen, byBranch: Record<string, unknown[]>, overrides: Partial<AppPullRequestServices["github"]> = {}): AppPullRequestServices {
  return {
    discoverRepository: cwd => discoverRepository(cwd),
    loadConfig: repository => loadRepositoryConfig(repository),
    listWorktreeInventory: repository => listWorktreeInventory(repository),
    listBranches: repository => listBranches(repository),
    env: { GH_TOKEN: token },
    github: {
      token: async () => { seen.tokenReads++; return token; },
      fetch: async (url, init) => {
        expect(url).toBe("https://api.github.com/graphql");
        expect(init.method).toBe("POST");
        const body = JSON.parse(String(init.body));
        seen.requests.push(body);
        const repository: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(body.variables as Record<string, string>)) {
          if (/^h\d+$/u.test(key)) repository[key] = { nodes: byBranch[value] ?? [] };
        }
        return Response.json({ data: { repository } });
      },
      timeoutMs: 5_000,
      ...overrides,
    },
  };
}

async function withWorktrees(run: (fixture: { primary: string; directory: string; paths: string[] }) => Promise<void>) {
  await withRepository(async (primary, directory) => {
    await git(primary, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    const paths = [primary];
    for (const branch of ["feature/open", "feature/draft", "feature/merged", "feature/closed", "feature/none"]) {
      const path = join(directory, branch.replace("/", "-"));
      await git(primary, "worktree", "add", "-b", branch, path);
      paths.push(path);
    }
    const detached = join(directory, "detached");
    await git(primary, "worktree", "add", "--detach", detached);
    paths.push(detached);
    await writeFile(join(paths[1]!, "untracked.txt"), "keep me\n");
    await writeFile(join(paths[2]!, "tracked.txt"), "modified\n");
    await writeFile(join(paths[3]!, ".env"), "SECRET=ignored\n");
    await run({ primary, directory, paths });
  });
}

test("open, draft, merged and closed pull requests report state, checks and review; others report none", async () => {
  await withWorktrees(async ({ primary, directory, paths }) => {
    const seen: Seen = { requests: [], tokenReads: 0 };
    const before = await snapshot(directory, paths);
    const record = await readAppPullRequests(paths[1]!, services(seen, {
      "feature/open": [pr(1, "feature/open", { reviewDecision: "APPROVED", ...rollup("SUCCESS", [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://example.invalid/1" },
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: null },
        { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", targetUrl: "https://example.invalid/2" },
      ]) })],
      "feature/draft": [pr(2, "feature/draft", { isDraft: true, reviewDecision: "REVIEW_REQUIRED", ...rollup("PENDING", [
        { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null, detailsUrl: "https://example.invalid/3" },
      ]) })],
      "feature/merged": [pr(3, "feature/merged", { state: "MERGED", reviewDecision: "APPROVED", ...rollup("SUCCESS", []) })],
      // Another owner's fork with the same branch name is not this branch.
      "feature/closed": [pr(9, "feature/closed", {}, "someone-else"), pr(4, "feature/closed", { state: "CLOSED",
        reviewDecision: "CHANGES_REQUESTED", ...rollup("FAILURE", [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "TIMED_OUT", detailsUrl: null },
          { __typename: "StatusContext", context: "ci/legacy", state: "ERROR", targetUrl: null },
        ]) })],
      "feature/none": [pr(5, "feature/none", {}, "someone-else")],
    }));
    expect(await snapshot(directory, paths)).toBe(before);
    expect(record.diagnostic).toBeNull();
    expect(record.github).toEqual({ owner: "acme", name: "widgets" });
    expect(record.repository?.primaryWorktreeRoot).toBe(primary);
    const byBranch = Object.fromEntries(record.worktrees.map(entry => [entry.branch ?? "(detached)", entry]));
    expect(record.worktrees[0]).toMatchObject({ path: primary, branch: "trunk", isPrimary: true, outcome: "none", pullRequest: null, reason: null });
    expect(byBranch["feature/open"]).toEqual({ path: paths[1]!, branch: "feature/open", isPrimary: false, outcome: "found",
      reason: null, diagnostic: null, pullRequest: { number: 1, url: "https://github.com/acme/widgets/pull/1", title: "Change 1",
        state: "open", baseBranch: "trunk", review: "approved", reviewers: [], reviewersComplete: true, description: "Body 1", checks: { summary: "passing", runs: [
          { name: "test", status: "passing", url: "https://example.invalid/1" },
          { name: "lint", status: "skipped", url: null },
          { name: "ci/legacy", status: "passing", url: "https://example.invalid/2" },
        ] } } });
    expect(byBranch["feature/draft"]!.pullRequest).toMatchObject({ number: 2, state: "draft", review: "review-required",
      checks: { summary: "pending", runs: [{ name: "test", status: "pending", url: "https://example.invalid/3" }] } });
    expect(byBranch["feature/merged"]!.pullRequest).toMatchObject({ number: 3, state: "merged", review: "approved", checks: { summary: "passing", runs: [] } });
    expect(byBranch["feature/closed"]!.pullRequest).toMatchObject({ number: 4, state: "closed", review: "changes-requested",
      checks: { summary: "failing", runs: [{ name: "test", status: "failing", url: null }, { name: "ci/legacy", status: "failing", url: null }] } });
    expect(byBranch["feature/none"]).toMatchObject({ outcome: "none", pullRequest: null, reason: null, diagnostic: null });
    expect(byBranch["(detached)"]).toMatchObject({ branch: null, outcome: "none" });
    // One request covers every branch; names travel as variables, never in the query text.
    expect(seen.requests).toHaveLength(1);
    expect(seen.requests[0]!.query).not.toContain("feature/");
    expect(Object.values(seen.requests[0]!.variables).sort()).toEqual(
      ["acme", "feature/closed", "feature/draft", "feature/merged", "feature/none", "feature/open", "trunk", "widgets"]);
    expect(JSON.stringify(record)).not.toContain(token);
  });
});

const requests = (nodes: unknown[], hasNextPage = false) => ({ reviewRequests: { pageInfo: { hasNextPage }, nodes } });
const reviews = (nodes: unknown[], hasPreviousPage = false) => ({ reviews: { pageInfo: { hasPreviousPage }, nodes } });
const user = (login: string) => ({ __typename: "User", login, url: `https://github.com/${login}` });
const review = (state: string, author: unknown) => ({ state, author });

test("reviewers recorded from cli/cli: an unreadable team leaves the others listed and the list incomplete", async () => {
  await withRepository(async primary => {
    await git(primary, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    // Recorded from github.com on 2026-11-18 (cli/cli#15100) by a login outside the requested team's organization.
    const record = await readAppPullRequests(primary, services({ requests: [], tokenReads: 0 }, {
      trunk: [pr(1, "trunk", {
        ...requests([{ requestedReviewer: null }, { requestedReviewer: { __typename: "User", login: "niik", url: "https://github.com/niik" } }]),
        ...reviews([{ state: "COMMENTED", author: { __typename: "Bot", login: "copilot-pull-request-reviewer",
          url: "https://github.com/apps/copilot-pull-request-reviewer" } }]),
      })],
    }));
    expect(record.worktrees[0]).toMatchObject({ outcome: "found", reason: null });
    expect(record.worktrees[0]!.pullRequest).toMatchObject({ reviewersComplete: false, reviewers: [
      { kind: "user", name: "niik", state: "requested", url: "https://github.com/niik" },
      { kind: "bot", name: "copilot-pull-request-reviewer", state: "commented", url: "https://github.com/apps/copilot-pull-request-reviewer" },
    ] });
  });
});

test("requests and reviews map to one state per reviewer", async () => {
  await withRepository(async primary => {
    await git(primary, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    const record = await readAppPullRequests(primary, services({ requests: [], tokenReads: 0 }, {
      trunk: [pr(1, "trunk", {
        ...requests([
          { requestedReviewer: user("rita") },
          { requestedReviewer: { __typename: "Team", combinedSlug: "acme/reviewers", url: "https://github.com/orgs/acme/teams/reviewers" } },
          // Asked again after approving below.
          { requestedReviewer: user("Frank") },
        ]),
        // Oldest first, as GitHub returns them.
        ...reviews([
          review("APPROVED", user("frank")),
          review("APPROVED", user("alice")),
          review("CHANGES_REQUESTED", user("bob")),
          review("COMMENTED", user("alice")),
          review("COMMENTED", user("carol")),
          review("COMMENTED", user("bob")),
          review("DISMISSED", user("dave")),
          review("APPROVED", { __typename: "Bot", login: "dependabot", url: "https://github.com/apps/dependabot" }),
          review("COMMENTED", user("erin")),
          review("APPROVED", user("erin")),
          review("PENDING", user("pat")),
          // A deleted account has no author.
          review("APPROVED", null),
          review("COMMENTED", { __typename: "User", login: "mallory", url: "javascript:alert(1)" }),
        ]),
      })],
    }));
    expect(record.worktrees[0]!.pullRequest).toMatchObject({ reviewersComplete: true, reviewers: [
      { kind: "user", name: "rita", state: "requested", url: "https://github.com/rita" },
      { kind: "team", name: "acme/reviewers", state: "requested", url: "https://github.com/orgs/acme/teams/reviewers" },
      { kind: "user", name: "Frank", state: "requested", url: "https://github.com/Frank" },
      { kind: "user", name: "alice", state: "approved", url: "https://github.com/alice" },
      { kind: "user", name: "bob", state: "changes-requested", url: "https://github.com/bob" },
      { kind: "user", name: "carol", state: "commented", url: "https://github.com/carol" },
      { kind: "user", name: "dave", state: "dismissed", url: "https://github.com/dave" },
      { kind: "bot", name: "dependabot", state: "approved", url: "https://github.com/apps/dependabot" },
      { kind: "user", name: "erin", state: "approved", url: "https://github.com/erin" },
      { kind: "user", name: "mallory", state: "commented", url: null },
    ] });
  });
});

test("more reviewers than one page holds leaves the list incomplete", async () => {
  await withRepository(async primary => {
    await git(primary, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    const record = await readAppPullRequests(primary, services({ requests: [], tokenReads: 0 }, {
      trunk: [pr(1, "trunk", { ...reviews([review("APPROVED", user("alice"))], true) })],
    }));
    expect(record.worktrees[0]!.pullRequest).toMatchObject({ reviewersComplete: false,
      reviewers: [{ kind: "user", name: "alice", state: "approved" }] });
  });
});

test("a login refused team fields is asked once more without them and still lists the other reviewers", async () => {
  await withRepository(async primary => {
    await git(primary, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    const seen: Seen = { requests: [], tokenReads: 0 };
    const record = await readAppPullRequests(primary, services(seen, {}, {
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        seen.requests.push(body);
        // Hand-written from GitHub's documented scope error for a token without read:org.
        if (String(body.query).includes("on Team")) {
          return Response.json({ data: null, errors: [{ type: "INSUFFICIENT_SCOPES",
            message: "Your token has not been granted the required scopes to execute this query." }] });
        }
        return Response.json({ data: { repository: { h0: { nodes: [pr(1, "trunk", {
          ...requests([{ requestedReviewer: { __typename: "Team" } }, { requestedReviewer: user("rita") }]),
        })] } } } });
      },
    }));
    expect(seen.requests).toHaveLength(2);
    expect(seen.tokenReads).toBe(1);
    expect(record.worktrees[0]).toMatchObject({ outcome: "found", reason: null });
    expect(record.worktrees[0]!.pullRequest).toMatchObject({ reviewersComplete: false,
      reviewers: [{ kind: "user", name: "rita", state: "requested" }] });
  });
});

test("a newer closed pull request does not hide the branch's open one", async () => {
  await withRepository(async primary => {
    await git(primary, "remote", "add", "origin", "git@github.com:acme/widgets.git");
    const seen: Seen = { requests: [], tokenReads: 0 };
    const record = await readAppPullRequests(primary, services(seen, {
      trunk: [pr(8, "trunk", { state: "CLOSED" }), pr(7, "trunk", { state: "MERGED" }), pr(6, "trunk", { reviewDecision: "APPROVED" })],
    }));
    expect(record.worktrees[0]!.pullRequest).toMatchObject({ number: 6, state: "open" });
  });
});

test("a branch pushed to a fork is matched on the fork's owner and upstream branch name", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    await git(primary, "remote", "add", "fork", "https://github.com/me/widgets.git");
    await git(primary, "worktree", "add", "-b", "local-name", join(directory, "fork"));
    await git(primary, "update-ref", "refs/remotes/fork/pushed-name", "HEAD");
    await git(primary, "config", "branch.local-name.remote", "fork");
    await git(primary, "config", "branch.local-name.merge", "refs/heads/pushed-name");
    const seen: Seen = { requests: [], tokenReads: 0 };
    const record = await readAppPullRequests(primary, services(seen, {
      "pushed-name": [pr(11, "pushed-name", {}, "acme"), pr(12, "pushed-name", {}, "me")],
    }));
    expect(record.worktrees.find(entry => entry.branch === "local-name")!.pullRequest).toMatchObject({ number: 12 });
    expect(Object.values(seen.requests[0]!.variables)).not.toContain("local-name");
  });
});

test("a remote that is not on github.com reports not-github without reading a login or contacting anything", async () => {
  await withWorktrees(async ({ primary, directory, paths }) => {
    await git(primary, "remote", "set-url", "origin", "https://gitlab.example.invalid/acme/widgets.git");
    const seen: Seen = { requests: [], tokenReads: 0 };
    const before = await snapshot(directory, paths);
    const record = await readAppPullRequests(primary, services(seen, {}, {
      fetch: async () => { throw new Error("must not fetch"); },
    }));
    expect(await snapshot(directory, paths)).toBe(before);
    expect(seen.tokenReads).toBe(0);
    expect(record.github).toBeNull();
    for (const item of record.worktrees) {
      if (item.branch === null) expect(item.outcome).toBe("none");
      else expect(item).toMatchObject({ outcome: "failed", reason: "not-github", pullRequest: null });
    }
    expect(record.worktrees.find(item => item.branch !== null)!.diagnostic).toContain("github.com");
  });
});

test("a rejected login reports sign-in-needed and a slow GitHub stops within the time limit as offline", async () => {
  await withRepository(async primary => {
    await git(primary, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    const rejected = await readAppPullRequests(primary, services({ requests: [], tokenReads: 0 }, {}, {
      fetch: async () => new Response(`bad credentials ${token}`, { status: 401 }),
    }));
    expect(rejected.worktrees[0]).toMatchObject({ outcome: "failed", reason: "sign-in-needed" });
    const missing = await readAppPullRequests(primary, services({ requests: [], tokenReads: 0 }, {}, {
      token: async () => { throw new Error(`gh failed near ${token}`); },
    }));
    expect(missing.worktrees[0]).toMatchObject({ outcome: "failed", reason: "sign-in-needed" });
    const started = Date.now();
    // A request that ignores its abort signal still cannot hold the call past the limit.
    const slow = await readAppPullRequests(primary, services({ requests: [], tokenReads: 0 }, {}, {
      fetch: () => new Promise<Response>(() => {}), timeoutMs: 200,
    }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(slow.worktrees[0]).toMatchObject({ outcome: "failed", reason: "offline" });
    const unreachable = await readAppPullRequests(primary, services({ requests: [], tokenReads: 0 }, {}, {
      fetch: async () => { throw new TypeError(`connect failed ${token}`); },
    }));
    expect(unreachable.worktrees[0]).toMatchObject({ outcome: "failed", reason: "offline" });
    const broken = await readAppPullRequests(primary, services({ requests: [], tokenReads: 0 }, {}, {
      fetch: async () => Response.json({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: token }] }),
    }));
    expect(broken.worktrees[0]).toMatchObject({ outcome: "failed", reason: "failed" });
    for (const record of [rejected, missing, slow, unreachable, broken]) expect(JSON.stringify(record)).not.toContain(token);
  });
});

/** The real CLI with stdin closed, no terminal and CI on. */
async function cli(cwd: string, env: Record<string, string | undefined>) {
  const result = await execa(process.execPath, ["--no-env-file", entry, "__app-pr"], {
    cwd, reject: false, timeout: 30_000, stdin: "ignore",
    env: { CI: "true", GH_TOKEN: undefined, GITHUB_TOKEN: undefined, HTTPS_PROXY: undefined, https_proxy: undefined, ...env },
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, record: JSON.parse(result.stdout) };
}

test("the CLI reports not-github, missing login and offline with no prompt, no token and no change", async () => {
  await withWorktrees(async ({ primary, directory, paths }) => {
    await git(primary, "remote", "add", "elsewhere", "https://gitlab.example.invalid/acme/widgets.git");
    const bin = join(directory, "bin");
    await mkdir(bin);
    // A GitHub CLI without a login, as gh behaves when signed out.
    await writeFile(join(bin, "gh"), "#!/bin/sh\necho 'You are not logged into any GitHub hosts.' >&2\nexit 1\n");
    await chmod(join(bin, "gh"), 0o755);
    const config = join(primary, ".timber.toml");
    await writeFile(config, 'remote = "elsewhere"\n');
    let before = await snapshot(directory, paths);
    const notGithub = await cli(primary, { GH_TOKEN: token });
    expect(await snapshot(directory, paths)).toBe(before);
    await Bun.file(config).delete();
    before = await snapshot(directory, paths);
    const signedOut = await cli(primary, { PATH: `${bin}:${process.env.PATH}` });
    // Connection refused at a local proxy stands in for having no network.
    const offline = await cli(primary, { GH_TOKEN: token, HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" });
    expect(await snapshot(directory, paths)).toBe(before);

    for (const [run, reason] of [[notGithub, "not-github"], [signedOut, "sign-in-needed"], [offline, "offline"]] as const) {
      expect(run.exitCode).toBe(1);
      expect(run.record.schemaVersion).toBe(1);
      expect(run.record.worktrees).toHaveLength(paths.length);
      for (const item of run.record.worktrees) {
        if (item.branch !== null) expect(item).toMatchObject({ outcome: "failed", reason });
      }
      expect(run.stdout + run.stderr).not.toContain(token);
    }
    expect(notGithub.record.github).toBeNull();
    expect(offline.record.github).toEqual({ owner: "acme", name: "widgets" });
  });
});

test("the CLI outside a repository prints one failed record", async () => {
  await withRepository(async (_primary, directory) => {
    const outside = join(directory, "outside");
    await mkdir(outside);
    const run = await cli(outside, { GIT_CEILING_DIRECTORIES: directory });
    expect(run.exitCode).toBe(1);
    expect(run.record).toMatchObject({ schemaVersion: 1, repository: null, github: null, worktrees: [] });
    expect(run.record.diagnostic).toBeString();
    expect(await readFile(join(directory, "primary repo", "tracked.txt"), "utf8")).toBe("original\n");
  });
});
