import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createNewHandler } from "../src/commands/new";
import { createCli } from "../src/cli";
import { runMachineCommand, type MachineRecord } from "../src/machine";
import { GithubLookupFailure } from "../src/github/client";
import type { AssignTarget } from "../src/issue-assignment";
import type { CommandContext, CommandServices, NewOptions } from "../src/services";
import type { RepositoryConfig, TrackerUser } from "../src/types";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";

const jira = { siteUrl: "https://acme.atlassian.net" };
const config: RepositoryConfig = { baseBranch: "main", remote: null, worktreeDir: null, editor: null, agent: null, jira };
const base = { ref: "refs/heads/main", commit: "a".repeat(40), source: "explicit" as const };
const created = worktreeFixture({ path: "/repo-worktrees/GH-7-fix", branch: "GH-7-fix", isPrimary: false });
const me: TrackerUser = { id: "me", name: "me" };

interface Run { calls: string[]; stdout: string; stderr: string; assigned: { target: AssignTarget; replace: boolean }[] }

function setup(assignees: readonly TrackerUser[] | undefined, overrides: Partial<CommandServices> = {}) {
  const run: Run = { calls: [], stdout: "", stderr: "", assigned: [] };
  const ticket = (key: string, url: string) => ({ key, title: "Fix", url, ...(assignees === undefined ? {} : { assignees }) });
  const handler = createNewHandler(createServiceDouble({
    // The result reporter resolves the common Git directory, so it must exist.
    discoverRepository: async () => repositoryFixture({ commonGitDir: tmpdir() }),
    loadConfig: async () => config,
    resolveBase: async () => base,
    resolveGithubRepository: async (_repository, _config, remote) => ({ owner: remote ?? "team", name: "project" }),
    resolveGithubTicket: async () => { run.calls.push("lookup"); return ticket("GH-7", "https://github.com/team/project/issues/7"); },
    resolveJiraTicket: async () => { run.calls.push("lookup"); return ticket("ENG-7", "https://acme.atlassian.net/browse/ENG-7"); },
    resolveLinearTicket: async () => { run.calls.push("lookup"); return { ...ticket("LIN-7", "https://linear.app/acme/issue/LIN-7/fix"), id: "uuid-7" }; },
    readTrackerUser: async () => { run.calls.push("me"); return me; },
    createWorktree: async () => { run.calls.push("create"); return created; },
    writeIssueLink: async () => { run.calls.push("link"); return "saved"; },
    assignIssue: async (target, user, replace) => { expect(user).toEqual(me); run.calls.push("assign"); run.assigned.push({ target, replace }); },
    launchEditor: async () => { run.calls.push("editor"); return { kind: "skipped" }; },
    ...overrides,
  }));
  const context: CommandContext = { cwd: "/repo", io: { stdout: text => { run.stdout += text; }, stderr: text => { run.stderr += text; } } };
  return { run, handler, context };
}

/** Runs `new` through the result-file reporter, which prints the record when no file is named. */
async function withRecord(handler: ReturnType<typeof createNewHandler>, input: string, options: NewOptions, context: CommandContext) {
  let json = "";
  const machineContext = { ...context, io: { ...context.io, stdout: (text: string) => { if (text.startsWith("{")) json = text; else context.io.stdout(text); } } };
  const failure = await runMachineCommand("new", machineContext, inner => handler(input, options, inner), undefined,
    async () => ({ kind: "unassigned" }), async () => ({ kind: "none" })).then(() => null, (error: Error) => error);
  return { record: JSON.parse(json) as MachineRecord, failure };
}

test("an unassigned issue is assigned to the signed-in account after the worktree and link exist", async () => {
  const { run, handler, context } = setup([]);
  const { record } = await withRecord(handler, "github:7", { assign: true, remote: "upstream" }, context);
  expect(run.calls).toEqual(["lookup", "me", "create", "link", "assign", "editor"]);
  // The write goes to the repository --remote selected for the lookup.
  expect(run.assigned).toEqual([{ target: { tracker: "github", repository: { owner: "upstream", name: "project" }, number: 7 }, replace: false }]);
  expect(run.stdout).toContain("Assigned GH-7 to me.\n");
  expect(record).toMatchObject({ outcome: "succeeded", exitCode: 0, diagnostic: null, materialized: true,
    assignment: { tracker: "github", key: "7", result: "assigned", me: "me", previous: [], diagnostic: null } });
});

test("Jira and Linear issues are assigned through their own trackers", async () => {
  for (const [input, target] of [
    ["jira:ENG-7", { tracker: "jira", config: jira, key: "ENG-7" }],
    ["linear:LIN-7", { tracker: "linear", key: "LIN-7", id: "uuid-7" }],
  ] as const) {
    const { run, handler, context } = setup([]);
    await handler(input, { assign: true }, context);
    expect(run.calls).toEqual(["lookup", "me", "create", "link", "assign", "editor"]);
    expect(run.assigned).toEqual([{ target, replace: false }]);
  }
});

test("someone else's issue is refused before anything is created, naming them; --reassign replaces them", async () => {
  const others = [{ id: "ada", name: "Ada" }, { id: "bob", name: "Bob\u001b[31m" }];
  const refused = setup(others);
  const { record, failure } = await withRecord(refused.handler, "github:7", { assign: true }, refused.context);
  expect(failure?.message).toBe("GitHub issue GH-7 is assigned to Ada, \"Bob\\u001b[31m\". Nothing was created.\nTo replace them with you, rerun with --reassign.");
  expect(refused.run.calls).toEqual(["lookup", "me"]);
  expect(record).toMatchObject({ outcome: "failed", materialized: false, worktree: null,
    assignment: { result: "not-attempted", previous: ["Ada", "Bob\u001b[31m"] } });

  const replaced = setup(others);
  const result = await withRecord(replaced.handler, "github:7", { reassign: true }, replaced.context);
  expect(replaced.run.calls).toEqual(["lookup", "me", "create", "link", "assign", "editor"]);
  expect(replaced.run.assigned.map(entry => entry.replace)).toEqual([true]);
  expect(replaced.run.stdout).toContain("Assigned GH-7 to me, replacing Ada, \"Bob\\u001b[31m\".\n");
  expect(result.record.assignment).toMatchObject({ result: "reassigned", previous: ["Ada", "Bob\u001b[31m"] });
});

test("an issue already assigned to the account writes nothing", async () => {
  for (const assignees of [[{ id: "ME", name: "ME" }], [{ id: "ada", name: "Ada" }, me]]) {
    const { run, handler, context } = setup(assignees);
    const { record } = await withRecord(handler, "github:7", { assign: true }, context);
    expect(run.calls).toEqual(["lookup", "me", "create", "link", "editor"]);
    expect(run.stdout).toContain("GH-7 is already assigned to you.\n");
    expect(record).toMatchObject({ outcome: "succeeded", assignment: { result: "already-mine" } });
  }
});

test("a failed assignment keeps the worktree, warns, goes on, and is recorded with a safe reason", async () => {
  const { run, handler, context } = setup([], { assignIssue: async () => { run.calls.push("assign"); throw new Error("GitHub refused\nthe assignment."); } });
  const { record, failure } = await withRecord(handler, "github:7", { assign: true }, context);
  expect(failure).toBeNull();
  expect(run.calls).toEqual(["lookup", "me", "create", "link", "assign", "editor"]);
  expect(run.stderr).toBe("Warning: could not assign GH-7 to me. The worktree was kept.\nGitHub refused\\nthe assignment.\n");
  expect(record).toMatchObject({ outcome: "succeeded", exitCode: 0, diagnostic: null, materialized: true,
    worktree: { path: created.path }, assignment: { result: "failed", diagnostic: "GitHub refused\\nthe assignment." } });
});

test("a failure after creation but before the write leaves the assignment not attempted", async () => {
  const { run, handler, context } = setup([], { writeIssueLink: async () => { run.calls.push("link"); throw new Error("disk"); } });
  const { record, failure } = await withRecord(handler, "github:7", { assign: true }, context);
  expect(failure?.message).toContain("Could not save the issue link");
  expect(run.calls).toEqual(["lookup", "me", "create", "link"]);
  expect(record).toMatchObject({ outcome: "failed", materialized: true, assignment: { result: "not-attempted" } });
});

test("--assign and --reassign need an issue, and never fall back to a literal branch", async () => {
  for (const options of [{ assign: true }, { reassign: true }]) {
    const { run, handler, context } = setup([]);
    await expect(handler("feature words", options, context)).rejects.toThrow("require an issue selector");
    expect(run.calls).toEqual([]);
  }
  // A default-tracker number that is not found would otherwise become a literal branch.
  const missing = setup([], {
    loadConfig: async () => ({ ...config, defaultTracker: "github" }),
    resolveGithubTicket: async () => { throw new GithubLookupFailure("GitHub issue is missing.", "not-found"); },
  });
  await expect(missing.handler("7", { assign: true }, missing.context)).rejects.toThrow("GitHub issue is missing.");
  expect(missing.run.calls).toEqual([]);
  expect(missing.run.stdout).toBe("");
});

test("an unreadable account or assignee list refuses before anything is created", async () => {
  const noAccount = setup([], { readTrackerUser: async () => { throw new Error("No usable GitHub login."); } });
  await expect(noAccount.handler("github:7", { assign: true }, noAccount.context))
    .rejects.toThrow("Could not read the signed-in GitHub account, so the issue cannot be assigned. Nothing was created.\nNo usable GitHub login.");
  expect(noAccount.run.calls).toEqual(["lookup"]);

  const unknown = setup(undefined);
  await expect(unknown.handler("linear:LIN-7", { assign: true }, unknown.context)).rejects.toThrow("Linear did not report who LIN-7 is assigned to");
  expect(unknown.run.calls).toEqual(["lookup", "me"]);
});

test("without --assign nothing about assignment is read or written", async () => {
  const { run, handler, context } = setup([{ id: "ada", name: "Ada" }]);
  const { record } = await withRecord(handler, "github:7", {}, context);
  expect(run.calls).toEqual(["lookup", "create", "link", "editor"]);
  expect(record.assignment).toBeUndefined();
});

test("opening an existing remote branch instead of creating one does not assign", async () => {
  const commit = "b".repeat(40);
  const inspection = { name: "GH-7-fix", local: null,
    remotes: [{ remote: "origin", cached: commit, live: { kind: "present" as const, commit }, selectorSafe: true }] };
  const { run, context } = setup([]);
  const opened = createNewHandler({ ...createServiceDouble({
    discoverRepository: async () => repositoryFixture(), loadConfig: async () => config, resolveBase: async () => base,
    resolveGithubRepository: async () => ({ owner: "team", name: "project" }),
    resolveGithubTicket: async () => ({ key: "GH-7", title: "Fix", url: "https://github.com/team/project/issues/7", assignees: [] }),
    readTrackerUser: async () => me, inspectNewBranchCollision: async () => inspection,
  }), openExisting: async () => { run.calls.push(`open after: ${run.stdout}`); return 0; } });
  await opened("github:7", { assign: true }, { ...context, choose: async () => "origin" });
  // The notice comes before open, which may run the agent in this terminal.
  expect(run.calls).toEqual(["open after: GH-7 was not assigned: timber new opened an existing branch instead of creating one.\n"]);

  // Cancelling the chooser cancels the command; the assignment was never attempted.
  const cancelled = createNewHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture({ commonGitDir: tmpdir() }), loadConfig: async () => config, resolveBase: async () => base,
    resolveGithubRepository: async () => ({ owner: "team", name: "project" }),
    resolveGithubTicket: async () => ({ key: "GH-7", title: "Fix", url: "https://github.com/team/project/issues/7", assignees: [] }),
    readTrackerUser: async () => me, inspectNewBranchCollision: async () => inspection,
  }));
  const { record } = await withRecord(cancelled, "github:7", { assign: true }, { ...context, choose: async () => null });
  expect(record).toMatchObject({ outcome: "cancelled", exitCode: 0, materialized: false, assignment: { result: "not-attempted" } });
});

test("the CLI passes --assign and --reassign to new", async () => {
  const received: NewOptions[] = [];
  const handlers = { new: async (_input: string, options: NewOptions) => { received.push(options); },
    setup: async () => {}, open: async () => {}, list: async () => {}, done: async () => {} };
  const io = { stdout() {}, stderr() {} };
  await createCli({ context: { cwd: "/repo", io }, handlers }).parseAsync(["new", "github:7", "--assign"], { from: "user" });
  await createCli({ context: { cwd: "/repo", io }, handlers }).parseAsync(["new", "github:7", "--reassign"], { from: "user" });
  expect(received).toEqual([{ assign: true }, { reassign: true }]);
});
