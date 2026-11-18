import { expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { createPullRequestHandler } from "../src/commands/pr";
import { createPullRequestReport, openPullRequest, type PullRequestDependencies, type PullRequestOptions } from "../src/github/pull-request";
import type { BaseAssociationRead } from "../src/git/base-metadata";
import type { IssueLinkRead } from "../src/git/issue-link";
import type { PublishReport } from "../src/git/publish";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CommandContext } from "../src/services";
import type { OpenTarget, RepositoryConfig } from "../src/types";

const repository = repositoryFixture({ remotes: [{ name: "origin" }, { name: "up/stream" }] as never });
const config: RepositoryConfig = { baseBranch: "main", remote: "origin", worktreeDir: null,
  editor: { command: "must-not-run", args: [], enabled: true }, agent: { command: "must-not-run", args: [], enabled: true },
  hooks: { postCreate: ["must-not-run"] } };
const branch = "GH-157-timber-pr";
const tree = worktreeFixture({ path: "/repo/feature", branch, isPrimary: false });
const repos: Record<string, { owner: string; name: string }> = { origin: { owner: "acme", name: "widgets" }, "up/stream": { owner: "upstream", name: "widgets" } };
const io = () => {
  let stdout = "", stderr = "";
  return { io: { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } }, out: () => ({ stdout, stderr }) };
};
const pull = (number: number, extra: Record<string, unknown> = {}) => ({ number, draft: false,
  head: { ref: branch, repo: { full_name: "acme/widgets" } }, base: { ref: "main" }, ...extra });

/** Doubles for every seam; the order of calls proves nothing is pushed before a refusal. */
function harness(options: {
  saved?: BaseAssociationRead; publish?: (report: PublishReport) => void; token?: () => Promise<string>;
  respond?: (method: string, url: string, body: unknown) => Response; issues?: { owner: string; name: string } | null;
  issue?: IssueLinkRead;
} = {}) {
  const events: string[] = [];
  const requests: { method: string; url: string; body: unknown }[] = [];
  const dependencies: PullRequestDependencies = {
    readBase: async () => { events.push("readBase"); return options.saved ?? { kind: "assigned", ref: "refs/remotes/origin/main" }; },
    readIssue: async () => options.issue ?? { kind: "none" },
    planPublish: async () => { events.push("plan"); return { path: tree.path, branch, head: tree.head!, remote: "origin", upstream: `refs/remotes/origin/${branch}` }; },
    publishWorktree: async (_r, _w, _c, _io, report) => {
      events.push("publish");
      report!.remote = "origin";
      report!.result = "published";
      options.publish?.(report!);
      return 0;
    },
    githubRepository: async (_r, remote, _role, push) => {
      events.push(push ? "head" : "base");
      const found = repos[remote];
      if (!found) throw new Error(`The remote ${remote} does not identify one github.com repository.`);
      return found;
    },
    issueRepository: async () => { if (options.issues === null) throw new Error("no issue remote"); return options.issues ?? repos.origin!; },
    runtime: { timeoutMs: 200,
      token: async () => { events.push("token"); return options.token ? options.token() : "token"; },
      fetch: async (url, init) => {
        const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
        requests.push({ method: String(init.method), url, body });
        events.push(String(init.method));
        return options.respond?.(String(init.method), url, body)
          ?? (init.method === "GET" ? Response.json([]) : Response.json(pull(42, { draft: body.draft }), { status: 201 }));
      } },
  };
  const run = async (prOptions: PullRequestOptions = { title: "Add timber pr" }) => {
    const report = createPullRequestReport();
    const output = io();
    const outcome = await openPullRequest(repository, tree, config, prOptions, output.io, report, dependencies)
      .then(code => ({ code, error: null as Error | null }), (error: Error) => ({ code: 1, error }));
    return { ...outcome, report, output: output.out() };
  };
  return { run, events, requests };
}

test("an unpublished branch is published, then the pull request is created against the saved base", async () => {
  const h = harness();
  const result = await h.run({ title: "Add timber pr", body: "Adds the command." });
  expect(result.error).toBeNull();
  expect(result.report).toEqual({ result: "created", number: 42, url: "https://github.com/acme/widgets/pull/42", base: "main", published: true });
  // The head repository is read from the push URL, the base from the fetch URL.
  expect(h.events).toEqual(["readBase", "plan", "base", "head", "token", "publish", "GET", "POST"]);
  expect(h.requests[1]!.body).toEqual({ title: "Add timber pr", head: `acme:${branch}`, base: "main",
    body: "Adds the command.\n\nRefs #157", draft: false });
  expect(result.output.stdout).toBe("Created pull request #42: https://github.com/acme/widgets/pull/42\n");
});

test("an open pull request into the same base is reported as exists and nothing is created", async () => {
  const h = harness({ publish: report => { report.result = "up-to-date"; },
    respond: method => method === "GET" ? Response.json([pull(7, { base: { ref: "release" } })]) : new Response(null, { status: 500 }) });
  const result = await h.run({ title: "t", base: "release" });
  expect(result.report).toEqual({ result: "exists", number: 7, url: "https://github.com/acme/widgets/pull/7", base: "release", published: false });
  expect(h.requests.map(request => request.method)).toEqual(["GET"]);
  expect(result.output.stdout).toContain("already open");
});

test("a pull request opened by someone else between lookup and creation is reported as exists", async () => {
  let lookups = 0;
  const h = harness({ respond: method => method === "GET"
    ? Response.json(lookups++ === 0 ? [] : [pull(8)])
    : Response.json({ message: "Validation Failed", errors: [{ message: "A pull request already exists" }] }, { status: 422 }) });
  const result = await h.run();
  expect(result.report).toMatchObject({ result: "exists", number: 8 });
  expect(h.requests.map(request => request.method)).toEqual(["GET", "POST", "GET"]);
});

test("--draft creates a draft and --base accepts each documented form", async () => {
  const h = harness();
  expect((await h.run({ title: "t", draft: true, base: "origin/release" })).report).toMatchObject({ result: "created" });
  expect(h.requests[1]!.body).toMatchObject({ base: "release", draft: true });
  expect(h.events).not.toContain("readBase");
  for (const [base, expected] of [["refs/remotes/origin/dev", "dev"], ["topic/x", "topic/x"]] as const) {
    const each = harness();
    await each.run({ title: "t", base });
    expect(each.requests[1]!.body).toMatchObject({ base: expected });
  }
  // The longest remote name wins, so a remote with a slash selects its own repository.
  const upstream = harness();
  await upstream.run({ title: "t", base: "up/stream/main" });
  expect(upstream.requests[1]!.url).toBe("https://api.github.com/repos/upstream/widgets/pulls");
});

test("an unusable base, title or remote is refused before the login is read or anything is pushed", async () => {
  const cases: [BaseAssociationRead | undefined, PullRequestOptions, string, string | null][] = [
    [{ kind: "unassigned" }, { title: "t" }, "no saved base", null],
    [{ kind: "invalid", reason: "stale" }, { title: "t" }, "cannot be used (stale)", null],
    [{ kind: "assigned", ref: "refs/heads/parent" }, { title: "t" }, "local branch parent", null],
    [{ kind: "assigned", ref: "refs/remotes/gone/main" }, { title: "t" }, "no longer configured", null],
    [undefined, { title: "t", base: "refs/heads/main" }, "not a local branch", null],
    [undefined, { title: "t", base: "HEAD" }, "not a local branch", null],
    [undefined, { title: "t", base: "origin/bad..name" }, "not valid", null],
    [undefined, { title: "t", base: `origin/${branch}` }, "the branch itself", branch],
    [undefined, { title: "  " }, "--title", null],
    [undefined, {}, "--title", null],
    [undefined, { title: "two\nlines" }, "one line", null],
    [undefined, { title: "x".repeat(257) }, "longer than 256", null],
    [undefined, { title: "t", body: "x".repeat(65_537) }, "body is longer", null],
  ];
  for (const [saved, options, message, base] of cases) {
    const h = harness(saved === undefined ? {} : { saved });
    const result = await h.run(options);
    expect(result.error?.message).toContain(message);
    expect(result.report).toEqual({ result: "refused", number: null, url: null, base, published: false });
    expect(h.events).not.toContain("token");
    expect(h.events).not.toContain("publish");
    expect(h.requests).toEqual([]);
  }
});

test("a missing login, a failed or refused publish and a rejected creation each end with their result", async () => {
  const login = harness({ token: async () => { throw new Error("GitHub CLI login is unavailable. Install gh and run timber setup to check or sign in to github.com."); } });
  const noLogin = await login.run();
  expect(noLogin.error?.message).toContain("login is unavailable");
  expect(noLogin.report).toMatchObject({ result: "failed", published: false, number: null });
  expect(login.events).not.toContain("publish");

  for (const [result, expected] of [["failed", "failed"], ["refused", "refused"]] as const) {
    const h = harness({ publish: report => { report.result = result; throw new Error(`publish ${result}`); } });
    const run = await h.run();
    expect(run.report).toMatchObject({ result: expected, published: false, number: null, base: "main" });
    expect(h.requests).toEqual([]);
  }

  const rejected = harness({ respond: method => method === "GET" ? Response.json([])
    : Response.json({ message: "Validation Failed", errors: [{ message: "No commits between main and x" }] }, { status: 422 }) });
  const run = await rejected.run();
  expect(run.error?.message).toContain("no commits");
  expect(run.report).toEqual({ result: "failed", number: null, url: null, base: "main", published: true });
});

test("the linked issue is referenced without a closing keyword, once, and qualified for another repository", async () => {
  const body = async (description: string | undefined, issues?: { owner: string; name: string } | null) => {
    const h = harness(issues === undefined ? {} : { issues });
    await h.run({ title: "t", ...(description === undefined ? {} : { body: description }) });
    return (h.requests[1]!.body as { body: string }).body;
  };
  expect(await body(undefined)).toBe("Refs #157");
  expect(await body("Fixes #157.")).toBe("Fixes #157.");
  expect(await body("See GH-157")).toBe("See GH-157");
  expect(await body("Not #1570")).toBe("Not #1570\n\nRefs #157");
  expect(await body("x", { owner: "acme", name: "tracker" })).toBe("x\n\nRefs acme/tracker#157");
  expect(await body("Closes acme/tracker#157", { owner: "acme", name: "tracker" })).toBe("Closes acme/tracker#157");
  // A bare #157 points at the base repository, so it does not mention the other repository's issue.
  expect(await body("See #157", { owner: "acme", name: "tracker" })).toBe("See #157\n\nRefs acme/tracker#157");
  expect(await body("x", null)).toBe("x\n\nRefs #157");
});

test("a saved issue link wins over the branch name, and an unreadable one adds no mention", async () => {
  const sent = async (issue: IssueLinkRead, description = "Work") => {
    const h = harness({ issue });
    const result = await h.run({ title: "t", body: description });
    return { body: (h.requests[1]!.body as { body: string }).body, stderr: result.output.stderr };
  };
  // The branch says GH-157, but the worktree was linked to another issue in another repository.
  expect((await sent({ kind: "linked", tracker: "github", key: "9", url: "https://github.com/acme/tracker/issues/9" })).body)
    .toBe("Work\n\nRefs acme/tracker#9");
  expect((await sent({ kind: "linked", tracker: "github", key: "9", url: "https://github.com/acme/widgets/issues/9" })).body)
    .toBe("Work\n\nRefs #9");
  expect((await sent({ kind: "linked", tracker: "jira", key: "ENG-7", url: "https://example.atlassian.net/browse/ENG-7" })).body)
    .toBe("Work\n\nRefs ENG-7");
  expect((await sent({ kind: "linked", tracker: "linear", key: "LIN-3", url: "https://linear.app/team/issue/LIN-3" }, "Done LIN-3")).body)
    .toBe("Done LIN-3");
  const invalid = await sent({ kind: "invalid", reason: "stale" });
  expect(invalid.body).toBe("Work");
  expect(invalid.stderr).toContain("saved issue link cannot be read (stale)");
});

test("a Jira or Linear key is mentioned by its key", async () => {
  const jira = { ...tree, branch: "ENG-42-thing" };
  const report = createPullRequestReport();
  const output = io();
  const local: PullRequestDependencies = {
    readBase: async () => ({ kind: "assigned", ref: "refs/remotes/origin/main" }), readIssue: async () => ({ kind: "none" }),
    planPublish: async () => ({ path: jira.path, branch: "ENG-42-thing", head: jira.head!, remote: "origin", upstream: "refs/remotes/origin/ENG-42-thing" }),
    publishWorktree: async (_r, _w, _c, _io, published) => { published!.remote = "origin"; published!.result = "published"; return 0; },
    githubRepository: async () => repos.origin!, issueRepository: async () => repos.origin!,
    runtime: { timeoutMs: 200, token: async () => "t", fetch: async (_url, init) => init.method === "GET" ? Response.json([])
      : Response.json({ ...pull(5), head: { ref: "ENG-42-thing", repo: { full_name: "acme/widgets" } }, body: JSON.parse(String(init.body)).body }, { status: 201 }) },
  };
  let sent = "";
  const recording = { ...local, runtime: { ...local.runtime, fetch: async (url: string, init: RequestInit) => {
    if (init.method === "POST") sent = JSON.parse(String(init.body)).body;
    return local.runtime.fetch(url, init);
  } } };
  expect(await openPullRequest(repository, jira, config, { title: "t", body: "Work" }, output.io, report, recording)).toBe(0);
  expect(sent).toBe("Work\n\nRefs ENG-42");
});

function cliHarness(open = mock(async () => 0), choose?: CommandContext["choose"], commonGitDir = "/repo/.git", ambiguous = true) {
  const found = (path = tree.path): OpenTarget => ({ kind: "worktree", worktree: { ...tree, path } });
  const services = createServiceDouble({ discoverRepository: async () => ({ ...repository, commonGitDir }), loadConfig: async () => config,
    resolveOpenTarget: async () => ambiguous ? { kind: "ambiguous", candidates: [found("/repo/b"), found("/repo/a")] } : { kind: "found", value: found() },
    openPullRequest: open });
  const output = io();
  const context: CommandContext = { cwd: "/repo/nested", io: output.io, ...(choose === undefined ? {} : { choose }) };
  const invoke = (args: string[]) => runCli(args, { context, handlers: { pr: createPullRequestHandler(services),
    setup: async () => {}, new: async () => {}, open: async () => {}, list: async () => {}, done: async () => {} } });
  return { invoke, open, output: output.out };
}

test("the command passes its options through and never opens a chooser in result-file mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber pr "));
  try {
    const open = mock(async () => 0);
    const h = cliHarness(open, undefined, directory, false);
    expect(await h.invoke(["pr", "GH-157", "--title", "T", "--body", "B", "--base", "origin/main", "--draft"])).toBe(0);
    expect(open).toHaveBeenCalledTimes(1);
    expect((open.mock.calls[0] as unknown[])[3]).toEqual({ title: "T", body: "B", base: "origin/main", draft: true });

    const choose = mock(async () => "/repo/a");
    const machine = cliHarness(mock(async () => 0), choose, directory);
    const output = join(directory, "result.json");
    expect(await machine.invoke(["pr", "GH-157", "--result-file", output])).toBe(1);
    expect(choose).not.toHaveBeenCalled();
    expect(machine.open).not.toHaveBeenCalled();
    const data = JSON.parse(await readFile(output, "utf8"));
    expect(data).toMatchObject({ schemaVersion: 1, command: "pr", outcome: "failed", exitCode: 1, worktree: null,
      pr: { result: "refused", number: null, url: null, base: null, published: false } });
    expect(data.diagnostic).toContain("matches 2 worktrees");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
