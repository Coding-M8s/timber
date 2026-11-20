import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { createListHandler } from "../src/commands/list";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import { readBaseAssociation, writeBaseAssociation } from "../src/git/base-metadata";
import { resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { IssueLinkConflict, readIssueLink, writeIssueLink, type IssueLink } from "../src/git/issue-link";
import { resolveOpenTarget } from "../src/git/open-target";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees, worktreeGitDirectory } from "../src/git/worktrees";
import type { RepositoryConfig, Worktree } from "../src/types";
import { createServiceDouble } from "./helpers/services";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, ...args], {
  cwd, reject: false, timeout: 30_000, env: { CI: "true" },
});
const io = { stdout() {}, stderr() {} };

function config(directory: string, extra: Partial<RepositoryConfig> = {}): RepositoryConfig {
  return { baseBranch: "trunk", remote: null, worktreeDir: join(directory, "trees"), editor: null, agent: null,
    jira: { siteUrl: "https://example.atlassian.net" }, ...extra };
}

const githubUrl = (number: number) => `https://github.com/team/project/issues/${number}`;
const jiraUrl = (key: string) => `https://example.atlassian.net/browse/${key}`;
const linearUrl = (key: string) => `https://linear.app/team/issue/${key.toLowerCase()}/synthetic-title`;

/** Real Git and metadata services; trackers are synthetic and record every lookup. */
function services(settings: RepositoryConfig, lookups: string[] = []) {
  return createServiceDouble({
    discoverRepository, loadConfig: async () => settings, resolveBase, resolveOpenTarget, createWorktree,
    writeBaseAssociation, readIssueLink, writeIssueLink,
    launchEditor: async () => ({ kind: "skipped" }),
    resolveGithubRepository: async () => ({ owner: "team", name: "project" }),
    resolveGithubTicket: async (_repository, number) => {
      lookups.push(`github:${number}`);
      return { key: `GH-${number}`, title: "Synthetic issue", url: githubUrl(number) };
    },
    resolveJiraTicket: async (_config, key) => {
      lookups.push(`jira:${key}`);
      return { key, title: "Synthetic issue", url: jiraUrl(key) };
    },
    resolveLinearTicket: async key => {
      lookups.push(`linear:${key}`);
      return { key, title: "Synthetic issue", url: linearUrl(key) };
    },
  });
}

async function tree(primary: string, path: string): Promise<Worktree> {
  const repository = await discoverRepository(primary);
  const found = (await listWorktrees(repository)).find(item => item.path === path);
  if (!found) throw new Error(`missing worktree ${path}`);
  return found;
}

async function issueFile(primary: string, path: string): Promise<string> {
  const repository = await discoverRepository(primary);
  return join(await worktreeGitDirectory(repository, await tree(primary, path)), "timber", "issue.json");
}

async function listed(primary: string) {
  const result = await cli(primary, "ls", "--json");
  expect(result.exitCode).toBe(0);
  return { result, rows: JSON.parse(result.stdout).worktrees as { path: string; branch: string | null; issue: unknown }[] };
}

const snapshot = async (primary: string) => ({
  refs: await git(primary, "for-each-ref", "--format=%(refname)%00%(objectname)"),
  trees: await git(primary, "worktree", "list", "--porcelain", "-z"),
});

test.each([
  ["github:7", {}, { tracker: "github", key: "7", url: githubUrl(7) }],
  ["7", { defaultTracker: "github" as const }, { tracker: "github", key: "7", url: githubUrl(7) }],
  ["jira:ENG-12", {}, { tracker: "jira", key: "ENG-12", url: jiraUrl("ENG-12") }],
  ["ENG-12", { defaultTracker: "jira" as const }, { tracker: "jira", key: "ENG-12", url: jiraUrl("ENG-12") }],
  ["jira:eng-12", {}, { tracker: "jira", key: "ENG-12", url: jiraUrl("ENG-12") }],
  ["eng-12", { defaultTracker: "jira" as const }, { tracker: "jira", key: "ENG-12", url: jiraUrl("ENG-12") }],
  ["linear:Eng-12", {}, { tracker: "linear", key: "ENG-12", url: linearUrl("ENG-12") }],
  ["eng-12", { defaultTracker: "linear" as const }, { tracker: "linear", key: "ENG-12", url: linearUrl("ENG-12") }],
  ["linear:ENG-12", {}, { tracker: "linear", key: "ENG-12", url: linearUrl("ENG-12") }],
  ["ENG-12", { defaultTracker: "linear" as const }, { tracker: "linear", key: "ENG-12", url: linearUrl("ENG-12") }],
])("new from %p with %p saves the issue link and ls --json reports it", async (input, extra, expected) => {
  await withRepository(async (primary, directory) => {
    const lookups: string[] = [];
    await createNewHandler(services(config(directory, extra), lookups))(input, {}, { cwd: primary, io });
    expect(lookups).toEqual([`${expected.tracker}:${expected.key}`]);
    const { rows } = await listed(primary);
    const created = rows.find(row => !row.path.endsWith("primary repo"))!;
    expect(created.issue).toEqual({ kind: "linked", ...expected });
    expect(created.branch).toBe(expected.tracker === "github" ? `GH-${expected.key}-synthetic-issue` : `${expected.key}-synthetic-issue`);
    expect(rows.find(row => row.path.endsWith("primary repo"))!.issue).toEqual({ kind: "none" });
  });
}, 30_000);

test("new from a branch name or sentence reports no issue, and ls never contacts a tracker", async () => {
  await withRepository(async (primary, directory) => {
    const settings = config(directory, { defaultTracker: "none" });
    await createNewHandler(services(settings))("plain-branch", {}, { cwd: primary, io });
    await createNewHandler(services(settings))("fix the login page", {}, { cwd: primary, io });
    const before = await snapshot(primary);
    const { rows } = await listed(primary);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.issue).toEqual({ kind: "none" });
    // The listing services expose no tracker lookups; any lookup would throw.
    const output: string[] = [];
    await createListHandler(createServiceDouble({ discoverRepository, listWorktrees, loadConfig: async () => settings,
      readBaseAssociation, readIssueLink }))({ cwd: primary, io: { stdout: text => { output.push(text); }, stderr: text => { output.push(text); } } });
    expect(output.join("")).not.toContain("warning");
    expect(await snapshot(primary)).toEqual(before);
  });
}, 30_000);

test("open --issue attaches a link, keeps a matching link, and refuses a conflict without changing anything", async () => {
  await withRepository(async (primary, directory) => {
    const settings = config(directory);
    const path = join(directory, "manual tree");
    await git(primary, "worktree", "add", "-b", "manual", path);
    const lookups: string[] = [];
    const open = createOpenHandler(services(settings, lookups));
    const output: string[] = [];
    const context = { cwd: primary, io: { stdout: (text: string) => { output.push(text); }, stderr() {} } };

    // The key may be typed in any case; the lookup and the saved link use it uppercase.
    await open(path, { issue: "jira:eng-5", editor: false, agent: false }, context);
    expect(lookups).toEqual(["jira:ENG-5"]);
    expect(output.join("")).toContain(`Linked jira:ENG-5: ${jiraUrl("ENG-5")}`);
    const linked = { kind: "linked", tracker: "jira", key: "ENG-5", url: jiraUrl("ENG-5") } as const;
    expect(await readIssueLink(await discoverRepository(primary), await tree(primary, path))).toEqual(linked);

    for (const issue of ["jira:ENG-5", "jira:Eng-5"]) {
      await open(path, { issue, editor: false, agent: false }, context);
      expect(lookups).toEqual(["jira:ENG-5"]);
      expect(output.join("")).toContain("Already linked to jira:ENG-5");
    }

    const file = await issueFile(primary, path);
    const bytes = await readFile(file, "utf8");
    const before = await snapshot(primary);
    const refused = open(path, { issue: "github:9", editor: false, agent: false }, context);
    await expect(refused).rejects.toBeInstanceOf(IssueLinkConflict);
    await expect(refused).rejects.toThrow("already linked to jira:ENG-5; nothing was changed");
    expect(lookups).toEqual(["jira:ENG-5"]);
    expect(await readFile(file, "utf8")).toBe(bytes);
    expect(await snapshot(primary)).toEqual(before);

    await open(path, { issue: "github:9", replaceIssue: true, editor: false, agent: false }, context);
    expect(lookups).toEqual(["jira:ENG-5", "github:9"]);
    const { rows } = await listed(primary);
    expect(rows.find(row => row.path === path)!.issue).toEqual({ kind: "linked", tracker: "github", key: "9", url: githubUrl(9) });
  });
}, 30_000);

test("open --issue on a branch links the created worktree; failed lookups and the primary worktree change nothing", async () => {
  await withRepository(async (primary, directory) => {
    const settings = config(directory);
    await git(primary, "branch", "later");
    await createOpenHandler(services(settings))("later", { issue: "linear:OPS-3", editor: false, agent: false }, { cwd: primary, io });
    const { rows } = await listed(primary);
    expect(rows.find(row => row.branch === "later")!.issue).toEqual({ kind: "linked", tracker: "linear", key: "OPS-3", url: linearUrl("OPS-3") });

    await git(primary, "branch", "unlinked");
    const before = await snapshot(primary);
    const failing = createOpenHandler({ ...services(settings), resolveGithubTicket: async () => { throw new Error("synthetic outage"); } });
    await expect(failing("unlinked", { issue: "github:4", editor: false, agent: false }, { cwd: primary, io })).rejects.toThrow("synthetic outage");
    await expect(createOpenHandler(services(settings))(primary, { issue: "github:4", editor: false, agent: false }, { cwd: primary, io }))
      .rejects.toThrow("primary worktree cannot be linked");
    await expect(createOpenHandler(services(settings))("unlinked", { issue: "not a selector", editor: false, agent: false }, { cwd: primary, io }))
      .rejects.toThrow("Invalid issue selector");
    expect(await snapshot(primary)).toEqual(before);
  });
}, 30_000);

test("damaged links are reported as invalid with a reason without failing the list or changing files", async () => {
  await withRepository(async (primary, directory) => {
    const settings = config(directory);
    const paths: Record<string, string> = {};
    for (const name of ["garbage", "shape", "folder", "stale", "healthy"]) {
      paths[name] = join(directory, `tree ${name}`);
      await git(primary, "worktree", "add", "-b", name, paths[name]!);
    }
    const repository = await discoverRepository(primary);
    const link: IssueLink = { tracker: "github", key: "3", url: githubUrl(3) };
    for (const name of ["shape", "stale", "healthy"]) await writeIssueLink(repository, await tree(primary, paths[name]!), link);
    const garbage = await issueFile(primary, paths.garbage!);
    await mkdir(dirname(garbage), { mode: 0o700 });
    await writeFile(garbage, "{not json", { mode: 0o600 });
    const shapeFile = await issueFile(primary, paths.shape!);
    const shaped = JSON.parse(await readFile(shapeFile, "utf8"));
    await writeFile(shapeFile, JSON.stringify({ ...shaped, url: "javascript:alert(1)" }));
    const folder = await issueFile(primary, paths.folder!);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const staleFile = await issueFile(primary, paths.stale!);
    const stale = JSON.parse(await readFile(staleFile, "utf8"));
    await writeFile(staleFile, JSON.stringify({ ...stale, worktreePath: join(directory, "elsewhere") }));

    const before = await snapshot(primary);
    const files = await Promise.all(["garbage", "shape", "stale"].map(async name => readFile(await issueFile(primary, paths[name]!), "utf8")));
    const { result, rows } = await listed(primary);
    const issue = (name: string) => rows.find(row => row.path === paths[name])!.issue;
    expect(rows).toHaveLength(6);
    expect(issue("garbage")).toEqual({ kind: "invalid", reason: "malformed" });
    expect(issue("shape")).toEqual({ kind: "invalid", reason: "malformed" });
    expect(issue("folder")).toEqual({ kind: "invalid", reason: "malformed" });
    expect(issue("stale")).toEqual({ kind: "invalid", reason: "stale" });
    expect(issue("healthy")).toEqual({ kind: "linked", ...link });
    expect(result.stderr).toContain(`Cannot read issue link for ${paths.garbage} (malformed); Git worktree remains listed.`);
    expect((await cli(primary, "ls")).exitCode).toBe(0);
    expect(await snapshot(primary)).toEqual(before);
    expect(await Promise.all(["garbage", "shape", "stale"].map(async name => readFile(await issueFile(primary, paths[name]!), "utf8")))).toEqual(files);

    // Damaged metadata is never overwritten; a stale identity can be replaced.
    const open = createOpenHandler(services(settings));
    await expect(open(paths.garbage!, { issue: "github:3", replaceIssue: true, editor: false, agent: false }, { cwd: primary, io }))
      .rejects.toThrow("is malformed; nothing was changed");
    await open(paths.stale!, { issue: "github:4", editor: false, agent: false }, { cwd: primary, io });
    expect(await readIssueLink(repository, await tree(primary, paths.stale!))).toEqual({ kind: "linked", tracker: "github", key: "4", url: githubUrl(4) });
    // Base metadata beside the link is unaffected.
    expect(await readBaseAssociation(repository, await tree(primary, paths.healthy!))).toEqual({ kind: "unassigned" });
  });
}, 30_000);

test("done removes the link with the worktree, and a reopened branch starts unlinked", async () => {
  await withRepository(async (primary, directory) => {
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n');
    const path = join(directory, "finished tree");
    await git(primary, "worktree", "add", "-b", "finished", path);
    const repository = await discoverRepository(primary);
    await writeIssueLink(repository, await tree(primary, path), { tracker: "jira", key: "ENG-1", url: jiraUrl("ENG-1") });
    const file = await issueFile(primary, path);
    const done = await cli(primary, "done", "--keep-branch", "--", path);
    expect(done.exitCode).toBe(0);
    await expect(readFile(file, "utf8")).rejects.toThrow();
    expect(await git(primary, "rev-parse", "--verify", "refs/heads/finished")).toBe(await git(primary, "rev-parse", "trunk"));
    const reopened = join(directory, "reopened tree");
    await git(primary, "worktree", "add", reopened, "finished");
    expect(await readIssueLink(repository, await tree(primary, reopened))).toEqual({ kind: "none" });
    await rm(reopened, { recursive: true, force: true });
  });
}, 30_000);

test("writeIssueLink validates links before saving anything", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "checked tree");
    await git(primary, "worktree", "add", "-b", "checked", path);
    const repository = await discoverRepository(primary);
    const target = await tree(primary, path);
    for (const link of [
      { tracker: "github", key: "0", url: githubUrl(0) },
      { tracker: "github", key: "5", url: githubUrl(6) },
      { tracker: "github", key: "5", url: "http://github.com/team/project/issues/5" },
      { tracker: "jira", key: "eng-1", url: jiraUrl("eng-1") },
      { tracker: "jira", key: "ENG-1", url: "https://user:secret@example.atlassian.net/browse/ENG-1" },
      { tracker: "linear", key: "ENG-1", url: "https://example.test/issue/ENG-1" },
      { tracker: "gitlab", key: "1", url: "https://gitlab.com/x" },
    ] as IssueLink[]) {
      await expect(writeIssueLink(repository, target, link)).rejects.toThrow("Invalid issue link");
    }
    expect(await readIssueLink(repository, target)).toEqual({ kind: "none" });
    await expect(writeIssueLink(repository, await tree(primary, primary), { tracker: "github", key: "1", url: githubUrl(1) }))
      .rejects.toThrow("primary worktree");
  });
}, 30_000);

test("new retains the worktree and skips setup when saving the link fails", async () => {
  await withRepository(async (primary, directory) => {
    const settings = config(directory, { hooks: { postCreate: ["touch setup-ran"] } });
    const handler = createNewHandler({ ...services(settings), runSetup: async () => { throw new Error("setup must not run"); },
      writeIssueLink: async () => { throw new Error("synthetic permission failure"); } });
    const failure = handler("github:8", {}, { cwd: primary, io });
    await expect(failure).rejects.toThrow("Could not save the issue link; created worktree retained");
    await expect(failure).rejects.toThrow("timber open --issue 'github:8' --no-editor --no-agent -- '");
    const created = join(directory, "trees", "GH-8-synthetic-issue");
    expect((await tree(primary, created)).branch).toBe("GH-8-synthetic-issue");
    expect(await readIssueLink(await discoverRepository(primary), await tree(primary, created))).toEqual({ kind: "none" });
  });
}, 30_000);
