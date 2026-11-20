import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { runCli } from "../src/cli";
import { createPullRequestHandler } from "../src/commands/pr";
import { loadRepositoryConfig } from "../src/config";
import { readBaseAssociation, writeBaseAssociation } from "../src/git/base-metadata";
import { readIssueLink, writeIssueLink } from "../src/git/issue-link";
import { resolveRebaseTarget } from "../src/git/rebase";
import { discoverRepository } from "../src/git/repository";
import { openPullRequest, type PullRequestDependencies } from "../src/github/pull-request";
import { pullRequestRepositoryOfRemote, resolveGithubRepository } from "../src/github/repository";
import type { BitbucketRuntime } from "../src/bitbucket/client";
import { planPublish, publishWorktree } from "../src/git/publish";
import { git, withRepository } from "./helpers/git";
import { commit, fixture } from "./helpers/rebase";

const branch = "TIM-28-feature";
const github = "https://github.com/acme/widgets.git";
const record = async (path: string) => JSON.parse(await readFile(path, "utf8"));
/** Every local ref and branch setting, to prove a stop changed nothing. */
const localState = async (cwd: string) => [
  await git(cwd, "for-each-ref", "--format=%(refname) %(objectname)"),
  (await execa("git", ["config", "--get-regexp", "^branch\\."], { cwd, reject: false })).stdout,
].join("\n");
const remoteHas = async (remote: string) => (await git(remote, "for-each-ref", "refs/heads")).includes(branch);

/** A GitHub double that keeps open pull requests in memory; nothing leaves the machine. */
function fakeGithub(token: () => Promise<string> = async () => "test-token") {
  const pulls: { number: number; draft: boolean; head: { ref: string; repo: { full_name: string } }; base: { ref: string } }[] = [];
  const calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] = [];
  const runtime: PullRequestDependencies["runtime"] = { timeoutMs: 2_000, token, fetch: async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method: String(init.method), url, body });
    if (init.method === "GET") return Response.json(pulls);
    const created = { number: 100 + pulls.length, draft: body.draft, head: { ref: String(body.head).split(":")[1]!, repo: { full_name: "acme/widgets" } }, base: { ref: body.base } };
    pulls.push(created);
    return Response.json(created, { status: 201 });
  } };
  return { runtime, calls };
}

async function setup(primary: string, directory: string) {
  const { remote, target } = await fixture(primary, directory);
  const tip = await commit(target, "feature.txt", "feature\n");
  await git(primary, "fetch", "origin");
  const repository = await discoverRepository(primary);
  const found = await resolveRebaseTarget(repository, target, await loadRepositoryConfig(repository));
  if (found.kind !== "found" || found.value.kind !== "worktree") throw new Error("fixture worktree not found");
  await writeBaseAssociation(repository, found.value.worktree, "refs/remotes/origin/main");
  // The remote reads as github.com, while pushes land in the local bare repository.
  await git(primary, "remote", "set-url", "origin", github);
  await git(primary, "config", `url.${remote}.pushInsteadOf`, github);
  return { remote, target, tip, repository, worktree: found.value.worktree };
}

/**
 * Real remote URL reads, except that the local bare repository pushInsteadOf
 * points at reads back as the github.com URL it stands in for.
 */
const readRemote = (local: string, stands: string) => async (cwd: string, args: string[]) =>
  (await execa("git", args, { cwd, stdin: "ignore" })).stdout.split("\n").map(url => url === local ? stands : url);

/** A Bitbucket double that must never be called; GitHub runs use it. */
const noBitbucket: BitbucketRuntime = { timeoutMs: 2_000,
  login: async () => { throw new Error("Bitbucket must not be used"); },
  fetch: async () => { throw new Error("Bitbucket must not be used"); } };

function command(primary: string, runtime: PullRequestDependencies["runtime"], stands = github, bitbucket = noBitbucket) {
  const local = join(primary, "..", "remote.git");
  const dependencies: PullRequestDependencies = {
    readBase: (repository, worktree) => readBaseAssociation(repository, worktree),
    readIssue: (repository, worktree) => readIssueLink(repository, worktree), planPublish, publishWorktree,
    remoteRepository: (repository, remote, role, push) => pullRequestRepositoryOfRemote(repository, remote, role, push, readRemote(local, stands)),
    issueRepository: (repository, config) => resolveGithubRepository(repository, config), runtime, bitbucket,
  };
  let stdout = "", stderr = "";
  const handler = createPullRequestHandler({ discoverRepository, loadConfig: loadRepositoryConfig, resolveOpenTarget: resolveRebaseTarget,
    openPullRequest: (repository, worktree, config, options, io, report) => openPullRequest(repository, worktree, config, options, io, report, dependencies) });
  const run = async (...args: string[]) => {
    stdout = ""; stderr = "";
    const code = await runCli(["pr", ...args], { context: { cwd: primary,
      io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } } },
    handlers: { pr: handler, setup: async () => {}, new: async () => {}, open: async () => {}, list: async () => {}, done: async () => {} } });
    return { code, stdout, stderr };
  };
  return run;
}

test("an unpublished branch is published and its pull request created against the saved base, then reported as existing", async () => {
  await withRepository(async (primary, directory) => {
    const { remote, target, tip } = await setup(primary, directory);
    const fake = fakeGithub();
    const run = command(primary, fake.runtime);
    const output = join(directory, "pr result.json");
    const result = await run(target, "--title", "Add the feature", "--draft", "--result-file", output);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Created draft pull request #100: https://github.com/acme/widgets/pull/100");
    expect(await record(output)).toMatchObject({ schemaVersion: 1, command: "pr", outcome: "succeeded", exitCode: 0,
      diagnostic: null, materialized: false, worktree: { path: target, branch, head: tip },
      pr: { result: "created", number: 100, url: "https://github.com/acme/widgets/pull/100", base: "main", published: true } });
    expect(await git(remote, "rev-parse", `refs/heads/${branch}`)).toBe(tip);
    expect(await git(target, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(`refs/remotes/origin/${branch}`);
    expect(fake.calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual(["GET /repos/acme/widgets/pulls", "POST /repos/acme/widgets/pulls"]);
    expect(fake.calls[1]!.body).toEqual({ title: "Add the feature", head: `acme:${branch}`, base: "main", body: "Refs TIM-28", draft: true });

    // Already published and already open: nothing is pushed or created.
    const again = join(directory, "again.json");
    const before = await localState(primary);
    expect((await run(branch, "--title", "Other title", "--result-file", again)).code).toBe(0);
    expect(await record(again)).toMatchObject({ outcome: "succeeded",
      pr: { result: "exists", number: 100, url: "https://github.com/acme/widgets/pull/100", base: "main", published: false } });
    expect(fake.calls.filter(call => call.method === "POST")).toHaveLength(1);
    expect(await localState(primary)).toBe(before);
  });
});

test("an unusable base and a missing login stop before any push and leave local refs unchanged", async () => {
  await withRepository(async (primary, directory) => {
    const { remote, target } = await setup(primary, directory);
    const before = await localState(primary);

    const fake = fakeGithub();
    const refused = join(directory, "refused.json");
    expect((await command(primary, fake.runtime)(target, "--title", "t", "--base", "refs/heads/main", "--result-file", refused)).code).toBe(1);
    const data = await record(refused);
    expect(data).toMatchObject({ command: "pr", outcome: "failed", exitCode: 1, worktree: { path: target },
      pr: { result: "refused", number: null, url: null, published: false } });
    expect(data.diagnostic).toContain("not a local branch");

    const missingTitle = join(directory, "title.json");
    expect((await command(primary, fake.runtime)(target, "--result-file", missingTitle)).code).toBe(1);
    expect(await record(missingTitle)).toMatchObject({ pr: { result: "refused" } });
    expect(fake.calls).toEqual([]);

    const loggedOut = fakeGithub(async () => { throw new Error("GitHub CLI login is unavailable. Install gh and run timber setup to check or sign in to github.com."); });
    const login = join(directory, "login.json");
    expect((await command(primary, loggedOut.runtime)(target, "--title", "t", "--result-file", login)).code).toBe(1);
    const failed = await record(login);
    expect(failed).toMatchObject({ outcome: "failed", exitCode: 1, pr: { result: "failed", number: null, base: "main", published: false } });
    expect(failed.diagnostic).toContain("login is unavailable");
    expect(loggedOut.calls).toEqual([]);

    // A remote that is not on github.com is refused before any push.
    await git(primary, "remote", "set-url", "origin", "https://gitlab.example/acme/widgets.git");
    const host = join(directory, "host.json");
    expect((await command(primary, fake.runtime)(target, "--title", "t", "--result-file", host)).code).toBe(1);
    expect(await record(host)).toMatchObject({ pr: { result: "refused" } });

    expect(await remoteHas(remote)).toBe(false);
    expect(await localState(primary)).toBe(before);
  });
});

test("a remote branch that moved on is refused by the push with nothing created and no local ref changed", async () => {
  await withRepository(async (primary, directory) => {
    const { remote, target } = await setup(primary, directory);
    // Someone else published this branch name with a commit this branch lacks.
    const publisher = join(directory, "publisher");
    await git(publisher, "checkout", "-b", branch);
    const theirs = await commit(publisher, "theirs.txt", "theirs\n");
    await git(publisher, "push", "origin", branch);
    const before = await localState(primary);
    const fake = fakeGithub();
    const output = join(directory, "moved.json");
    expect((await command(primary, fake.runtime)(target, "--title", "t", "--result-file", output)).code).toBe(1);
    const data = await record(output);
    expect(data).toMatchObject({ outcome: "failed", exitCode: 1, pr: { result: "refused", number: null, base: "main", published: false } });
    expect(data.diagnostic).toContain("Timber never force-pushes");
    expect(fake.calls).toEqual([]);
    expect(await git(remote, "rev-parse", `refs/heads/${branch}`)).toBe(theirs);
    expect(await localState(primary)).toBe(before);
  });
});

test("the head repository comes from the push URL, so a fork's branch opens against the fetch repository", async () => {
  await withRepository(async (primary, directory) => {
    const { target, repository, worktree } = await setup(primary, directory);
    // The saved issue link names the issue; the branch name's TIM-28 is not used.
    await writeIssueLink(repository, worktree, { tracker: "github", key: "28", url: "https://github.com/acme/widgets/issues/28" });
    // Fetch from acme/widgets, push to a fork. Git ignores pushInsteadOf when pushurl is set, so
    // pushurl names the local repository and the reader shows it as the fork it stands in for.
    const fork = "https://github.com/someone/widgets.git";
    await git(primary, "config", "remote.origin.pushurl", join(directory, "remote.git"));
    const fake = fakeGithub();
    const run = command(primary, { ...fake.runtime, fetch: async (url, init) => {
      const response = await fake.runtime.fetch(url, init);
      if (init.method !== "POST") return response;
      const created = await response.json();
      return Response.json({ ...created, head: { ...created.head, repo: { full_name: "someone/widgets" } } }, { status: 201 });
    } }, fork);
    const result = await run(target, "--title", "t");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(new URL(fake.calls[0]!.url).searchParams.get("head")).toBe(`someone:${branch}`);
    expect(fake.calls[1]).toMatchObject({ url: "https://api.github.com/repos/acme/widgets/pulls", body: { head: `someone:${branch}`, body: "Refs #28" } });
  });
});

test("a failed publish ends as failed without contacting GitHub's pull request API", async () => {
  await withRepository(async (primary, directory) => {
    const { remote, target } = await setup(primary, directory);
    // The push target refuses every update, as a protected or broken remote would.
    await Bun.write(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n");
    await execa("chmod", ["+x", join(remote, "hooks", "pre-receive")]);
    const fake = fakeGithub();
    const output = join(directory, "failed.json");
    expect((await command(primary, fake.runtime)(target, "--title", "t", "--result-file", output)).code).toBe(1);
    expect(await record(output)).toMatchObject({ outcome: "failed", pr: { result: "failed", published: false, number: null } });
    expect(fake.calls).toEqual([]);
    expect(await remoteHas(remote)).toBe(false);
  });
});

/** A Bitbucket Cloud double that keeps open pull requests in memory; nothing leaves the machine. */
function fakeBitbucket(login: () => Promise<{ email: string; token: string }> = async () => ({ email: "dev@example.com", token: "test-token" })) {
  const pulls: Record<string, unknown>[] = [];
  const calls: { method: string; url: string; body: Record<string, unknown> | undefined; authorization: string }[] = [];
  const runtime: BitbucketRuntime = { timeoutMs: 2_000, login, fetch: async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method: String(init.method), url, body, authorization: String((init.headers as Record<string, string>).Authorization) });
    if (init.method === "GET") return Response.json({ values: pulls, pagelen: 50 });
    const created = { id: 200 + pulls.length, draft: body.draft, source: { branch: body.source.branch, repository: { full_name: "acme/widgets" } },
      destination: { branch: body.destination.branch, repository: { full_name: "acme/widgets" } } };
    pulls.push(created);
    return Response.json(created, { status: 201 });
  } };
  return { runtime, calls };
}

test("a bitbucket.org remote is published and its pull request created on Bitbucket, then reported as existing", async () => {
  await withRepository(async (primary, directory) => {
    const bitbucket = "https://dev@bitbucket.org/acme/widgets.git";
    const { remote, target, tip } = await setup(primary, directory);
    await git(primary, "remote", "set-url", "origin", bitbucket);
    await git(primary, "config", `url.${remote}.pushInsteadOf`, bitbucket);
    const fake = fakeBitbucket();
    const github = fakeGithub(async () => { throw new Error("GitHub must not be used"); });
    const run = command(primary, github.runtime, bitbucket, fake.runtime);
    const output = join(directory, "bitbucket.json");
    const result = await run(target, "--title", "Add the feature", "--result-file", output);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Created pull request #200: https://bitbucket.org/acme/widgets/pull-requests/200");
    expect(await record(output)).toMatchObject({ command: "pr", outcome: "succeeded", exitCode: 0,
      pr: { result: "created", number: 200, url: "https://bitbucket.org/acme/widgets/pull-requests/200", base: "main", published: true } });
    expect(await git(remote, "rev-parse", `refs/heads/${branch}`)).toBe(tip);
    expect(fake.calls.map(call => `${call.method} ${new URL(call.url).pathname}`))
      .toEqual(["GET /2.0/repositories/acme/widgets/pullrequests", "POST /2.0/repositories/acme/widgets/pullrequests"]);
    expect(fake.calls[0]!.authorization).toBe(`Basic ${Buffer.from("dev@example.com:test-token").toString("base64")}`);
    expect(fake.calls[1]!.body).toEqual({ title: "Add the feature", description: "Refs TIM-28", draft: false,
      source: { branch: { name: branch } }, destination: { branch: { name: "main" } } });
    expect(github.calls).toEqual([]);

    const again = join(directory, "again.json");
    expect((await run(branch, "--title", "Other", "--result-file", again)).code).toBe(0);
    expect(await record(again)).toMatchObject({ pr: { result: "exists", number: 200,
      url: "https://bitbucket.org/acme/widgets/pull-requests/200", published: false } });
    expect(fake.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
});

test("a missing Bitbucket login fails before any push and leaves local refs unchanged", async () => {
  await withRepository(async (primary, directory) => {
    const bitbucket = "git@bitbucket.org:acme/widgets.git";
    const { remote, target } = await setup(primary, directory);
    await git(primary, "remote", "set-url", "origin", bitbucket);
    await git(primary, "config", `url.${remote}.pushInsteadOf`, bitbucket);
    const before = await localState(primary);
    const fake = fakeBitbucket(async () => { throw new Error("Bitbucket login is missing. Run timber setup to save an Atlassian email and Bitbucket API token, or supply BITBUCKET_EMAIL and BITBUCKET_API_TOKEN."); });
    const output = join(directory, "login.json");
    expect((await command(primary, fakeGithub().runtime, bitbucket, fake.runtime)(target, "--title", "t", "--result-file", output)).code).toBe(1);
    const data = await record(output);
    expect(data).toMatchObject({ outcome: "failed", exitCode: 1, pr: { result: "failed", number: null, url: null, base: "main", published: false } });
    expect(data.diagnostic).toContain("Bitbucket login is missing");
    expect(fake.calls).toEqual([]);
    expect(await remoteHas(remote)).toBe(false);
    expect(await localState(primary)).toBe(before);
  });
});
