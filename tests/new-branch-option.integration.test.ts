import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { placeholderHandlers, runCli } from "../src/cli";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import { writeBaseAssociation } from "../src/git/base-metadata";
import { resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { readIssueLink, writeIssueLink } from "../src/git/issue-link";
import { inspectNewBranchCollision } from "../src/git/new-collision";
import { resolveOpenTarget } from "../src/git/open-target";
import { discoverRepository } from "../src/git/repository";
import { GithubLookupFailure } from "../src/github/client";
import { JiraLookupFailure } from "../src/jira/client";
import { LinearLookupFailure } from "../src/linear/client";
import type { CommandContext } from "../src/services";
import type { RepositoryConfig } from "../src/types";
import { createServiceDouble } from "./helpers/services";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, ...args], {
  cwd, reject: false, timeout: 30_000, env: { CI: "true" },
});
const author = ["-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid"];

const githubUrl = (number: number) => `https://github.com/team/project/issues/${number}`;
const jiraUrl = (key: string) => `https://example.atlassian.net/browse/${key}`;
const linearUrl = (key: string) => `https://linear.app/team/issue/${key.toLowerCase()}/synthetic-title`;

function config(directory: string, extra: Partial<RepositoryConfig> = {}): RepositoryConfig {
  return { baseBranch: "trunk", remote: null, worktreeDir: join(directory, "trees"), editor: null, agent: null,
    jira: { siteUrl: "https://example.atlassian.net" }, ...extra };
}

interface Trackers {
  lookups: string[];
  /** Canonical key returned by Linear, which may differ from the typed key for a moved issue. */
  linearKey?: string;
  missing?: boolean;
}

/** Real Git, metadata and collision services; trackers are synthetic and record every lookup. */
function handlers(settings: RepositoryConfig, trackers: Trackers = { lookups: [] }) {
  const shared = {
    discoverRepository, loadConfig: async () => settings, createWorktree, readIssueLink, writeIssueLink,
    launchEditor: async () => ({ kind: "skipped" } as const),
    launchAgent: async () => ({ kind: "skipped" } as const),
    resolveGithubRepository: async () => ({ owner: "team", name: "project" }),
    resolveGithubTicket: async (_repository: unknown, number: number) => {
      trackers.lookups.push(`github:${number}`);
      if (trackers.missing) throw new GithubLookupFailure("GitHub issue was not found.", "not-found");
      return { key: `GH-${number}`, title: "Synthetic issue", url: githubUrl(number) };
    },
    resolveJiraTicket: async (_config: unknown, key: string) => {
      trackers.lookups.push(`jira:${key}`);
      if (trackers.missing) throw new JiraLookupFailure("Jira issue was not found.", "not-found");
      return { key, title: "Synthetic issue", url: jiraUrl(key) };
    },
    resolveLinearTicket: async (key: string) => {
      trackers.lookups.push(`linear:${key}`);
      if (trackers.missing) throw new LinearLookupFailure("Linear issue was not found.", "not-found");
      const canonical = trackers.linearKey ?? key;
      return { key: canonical, title: "Synthetic issue", url: linearUrl(canonical) };
    },
  };
  const open = createOpenHandler(createServiceDouble({ ...shared, resolveOpenTarget }));
  return {
    ...placeholderHandlers,
    new: createNewHandler({
      ...createServiceDouble({ ...shared, resolveBase, writeBaseAssociation, inspectNewBranchCollision }), openExisting: open,
    }),
    open,
  };
}

async function run(cwd: string, settings: RepositoryConfig, args: string[], trackers?: Trackers,
  extra: Partial<CommandContext> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["new", ...args], {
    handlers: handlers(settings, trackers),
    context: { cwd, io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, ...extra },
  });
  return { code, stdout, stderr };
}

async function listed(primary: string) {
  const result = await cli(primary, "ls", "--json");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout).worktrees as { path: string; branch: string | null; issue: unknown }[];
}

async function snapshot(primary: string, directory: string) {
  return {
    refs: await git(primary, "for-each-ref", "--format=%(refname)%00%(objectname)"),
    trees: await git(primary, "worktree", "list", "--porcelain", "-z"),
    entries: (await readdir(directory)).sort(),
  };
}

test.each([
  ["jira:ENG-42", "ENG-42-short", { tracker: "jira", key: "ENG-42", url: jiraUrl("ENG-42") }],
  ["github:42", "GH-42-short", { tracker: "github", key: "42", url: githubUrl(42) }],
  ["linear:ENG-42", "ENG-42-short", { tracker: "linear", key: "ENG-42", url: linearUrl("ENG-42") }],
] as const)("new %s --branch %s creates that branch and saves the link ls --json reports", async (input, name, link) => {
  await withRepository(async (primary, directory) => {
    const trackers: Trackers = { lookups: [] };
    const result = await run(primary, config(directory), [input, "--branch", name, "--no-editor", "--no-agent"], trackers);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(`Created ${name} at `);
    expect(trackers.lookups).toEqual([`${link.tracker}:${link.key}`]);
    const created = (await listed(primary)).find(row => row.branch === name);
    expect(created?.issue).toEqual({ kind: "linked", ...link });
  });
}, 30_000);

test.each([
  ["jira:ENG-42", "ENG-42-short"],
  ["github:42", "GH-42-short"],
  ["linear:ENG-42", "ENG-42-short"],
])("new %s --branch %s --result-file records the chosen branch", async (input, name) => {
  await withRepository(async (primary, directory) => {
    const output = join(directory, "result.json");
    const result = await run(primary, config(directory),
      [input, "--branch", name, "--no-editor", "--no-agent", "--result-file", output]);
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ outcome: "succeeded", materialized: true,
      worktree: { branch: name } });
    expect(await git(primary, "rev-parse", "--verify", `refs/heads/${name}`)).toBe(await git(primary, "rev-parse", "trunk"));
    expect((await listed(primary)).find(row => row.branch === name)?.issue).toMatchObject({ kind: "linked" });
  });
}, 30_000);

test("a default tracker input takes --branch, and the limit for generated names does not apply", async () => {
  await withRepository(async (primary, directory) => {
    // Smaller than the key plus a suffix: generation would refuse, an explicit name does not.
    const settings = config(directory, { defaultTracker: "jira", maxGeneratedBranchNameLength: 3 });
    const name = "ENG-42-a-much-longer-name-than-the-limit";
    const prompts: string[] = [];
    const result = await run(primary, settings, ["eng-42", "--branch", name, "--no-editor", "--no-agent"], undefined, {
      interactive: true,
      choose: async message => { prompts.push(message); return null; },
      ask: async message => { prompts.push(message); return null; },
    });
    expect(result.code).toBe(0);
    expect(prompts).toEqual([]);
    expect((await listed(primary)).find(row => row.branch === name)?.issue)
      .toEqual({ kind: "linked", tracker: "jira", key: "ENG-42", url: jiraUrl("ENG-42") });
  });
}, 30_000);

test("--branch works with --base and -c", async () => {
  await withRepository(async (primary, directory) => {
    const result = await run(primary, config(directory),
      ["github:7", "--branch", "GH-7-from-trunk", "--base", "refs/heads/trunk", "-c", "--no-editor", "--no-agent"]);
    expect(result.code).toBe(0);
    expect(await git(primary, "rev-parse", "refs/heads/GH-7-from-trunk")).toBe(await git(primary, "rev-parse", "trunk"));
  });
}, 30_000);

test("--branch accepts the issue ID and separator alone, as the prompt does", async () => {
  await withRepository(async (primary, directory) => {
    expect((await run(primary, config(directory), ["jira:ENG-42", "--branch", "ENG-42-", "--no-editor", "--no-agent"])).code)
      .toBe(0);
    expect(await git(primary, "branch", "--list", "ENG-42-")).toContain("ENG-42-");
  });
}, 30_000);

test.each([
  ["jira:ENG-42", "", "Branch name must not be blank."],
  ["jira:ENG-42", "   ", "Branch name must not be blank."],
  ["jira:ENG-42", "ENG-42-a\tb", "Branch name must not contain control characters."],
  ["jira:ENG-42", "ENG-42-a..b", "Invalid branch name: ENG-42-a..b"],
  ["jira:ENG-42", "ENG-42-two words", "Invalid branch name: ENG-42-two words"],
  ["jira:ENG-42", "ENG-4-short", "Branch name must start with ENG-42-."],
  ["jira:ENG-42", "eng-42-short", "Branch name must start with ENG-42-."],
  ["jira:ENG-42", "ENG-42", "Branch name must start with ENG-42-."],
  ["github:7", "7-short", "Branch name must start with GH-7-."],
  ["github:7", "github-7-short", "Branch name must start with GH-7-."],
  ["linear:ENG-42", "ENG-43-short", "Branch name must start with ENG-42-."],
])("new %s --branch %p is refused with the reason and creates nothing", async (input, name, reason) => {
  await withRepository(async (primary, directory) => {
    const before = await snapshot(primary, directory);
    const output = join(directory, "refused.json");
    const result = await run(primary, config(directory),
      [input, "--branch", name, "--no-editor", "--no-agent", "--result-file", output]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${reason}\nNo worktree was created.`);
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ outcome: "failed", materialized: false, worktree: null });
    const after = await snapshot(primary, directory);
    expect(after.refs).toBe(before.refs);
    expect(after.trees).toBe(before.trees);
    expect(after.entries).toEqual([...before.entries, "refused.json"].sort());
  });
}, 30_000);

test("the prefix is the canonical key the tracker returns, not the typed key", async () => {
  await withRepository(async (primary, directory) => {
    const before = await snapshot(primary, directory);
    const moved = (): Trackers => ({ lookups: [], linearKey: "NEW-9" });
    const refused = await run(primary, config(directory), ["linear:OLD-3", "--branch", "OLD-3-x", "--no-editor", "--no-agent"], moved());
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("Branch name must start with NEW-9-.");
    expect(await snapshot(primary, directory)).toEqual(before);
    const accepted = await run(primary, config(directory), ["linear:OLD-3", "--branch", "NEW-9-x", "--no-editor", "--no-agent"], moved());
    expect(accepted.code).toBe(0);
    expect((await listed(primary)).find(row => row.branch === "NEW-9-x")?.issue)
      .toEqual({ kind: "linked", tracker: "linear", key: "NEW-9", url: linearUrl("NEW-9") });
  });
}, 30_000);

test("an existing local branch with the --branch name is refused and kept", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "branch", "ENG-42-taken", "trunk");
    const before = await snapshot(primary, directory);
    const result = await run(primary, config(directory), ["jira:ENG-42", "--branch", "ENG-42-taken", "--no-editor", "--no-agent"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ENG-42-taken");
    expect(await snapshot(primary, directory)).toEqual(before);
  });
}, 30_000);

async function pushedOnly(primary: string, directory: string, name: string) {
  const bare = join(directory, "origin.git");
  await git(directory, "init", "--bare", bare);
  await git(primary, "remote", "add", "origin", bare);
  await git(primary, "push", "origin", "trunk");
  await git(primary, "branch", name, "trunk");
  await git(primary, ...author, "commit", "--allow-empty", "-m", "advance trunk");
  await git(primary, "push", "origin", name);
  await git(primary, "branch", "-D", name);
  return bare;
}

test("a --branch name that exists only on a remote is refused without a terminal", async () => {
  await withRepository(async (primary, directory) => {
    const bare = await pushedOnly(primary, directory, "ENG-42-remote");
    const before = { ...await snapshot(primary, directory), remote: await git(bare, "show-ref") };
    const result = await run(primary, config(directory), ["jira:ENG-42", "--branch", "ENG-42-remote", "--no-editor", "--no-agent"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Branch ENG-42-remote already exists on origin. Did you mean timber open?");
    expect({ ...await snapshot(primary, directory), remote: await git(bare, "show-ref") }).toEqual(before);
  });
}, 30_000);

test("opening a remote --branch name from the prompt keeps the issue link", async () => {
  await withRepository(async (primary, directory) => {
    await pushedOnly(primary, directory, "ENG-42-remote");
    const result = await run(primary, config(directory), ["jira:ENG-42", "--branch", "ENG-42-remote", "--no-editor", "--no-agent"],
      undefined, { interactive: true, choose: async (_message, choices) => choices.find(choice => choice.value === "origin")!.value });
    expect(result.code).toBe(0);
    expect((await listed(primary)).find(row => row.branch === "ENG-42-remote")?.issue)
      .toEqual({ kind: "linked", tracker: "jira", key: "ENG-42", url: jiraUrl("ENG-42") });
  });
}, 30_000);

test.each([
  ["a branch name", ["plain-branch"], {}],
  ["a sentence", ["fix", "the", "login"], {}],
  ["a key with no default tracker", ["ENG-42"], { defaultTracker: "none" as const }],
])("--branch with %s is refused before any lookup", async (_label, input, extra) => {
  await withRepository(async (primary, directory) => {
    const before = await snapshot(primary, directory);
    const trackers: Trackers = { lookups: [] };
    const result = await run(primary, config(directory, extra), [...input, "--branch", "ENG-42-x", "--no-editor", "--no-agent"], trackers);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("The --branch option requires an issue selector");
    expect(trackers.lookups).toEqual([]);
    expect(await snapshot(primary, directory)).toEqual(before);
  });
}, 30_000);

test.each([
  ["7", { defaultTracker: "github" as const }, "GH-7-x", "GitHub issue was not found."],
  ["ENG-42", { defaultTracker: "jira" as const }, "ENG-42-x", "Jira issue was not found."],
  ["ENG-42", { defaultTracker: "linear" as const }, "ENG-42-x", "Linear issue was not found."],
])("a missing default tracker issue %s with --branch is refused instead of creating a literal branch", async (input, extra, name, reason) => {
  await withRepository(async (primary, directory) => {
    const before = await snapshot(primary, directory);
    const result = await run(primary, config(directory, extra), [input, "--branch", name, "--no-editor", "--no-agent"],
      { lookups: [], missing: true });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(reason);
    expect(result.stdout).not.toContain("Creating literal branch");
    expect(await snapshot(primary, directory)).toEqual(before);
  });
}, 30_000);
