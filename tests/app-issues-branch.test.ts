import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAppIssues } from "../src/app-issues/read";
import type { AppIssuesServices } from "../src/app-issues/read";
import { createNewHandler } from "../src/commands/new";
import { loadRepositoryConfig } from "../src/config";
import { resolveGithubTicket } from "../src/github/client";
import { resolveGithubRepository } from "../src/github/repository";
import { resolveBase } from "../src/git/branches";
import { readIssueLink } from "../src/git/issue-link";
import { discoverRepository } from "../src/git/repository";
import { listWorktreeInventory } from "../src/git/worktrees";
import { generateTicketBranch, predictTicketBranch } from "../src/jira/branch";
import type { LinkedTracker } from "../src/git/issue-link";
import { createServiceDouble } from "./helpers/services";
import { git, withRepository } from "./helpers/git";

const io = { stdout() {}, stderr() {} };
const keys: Record<LinkedTracker, string> = { github: "123", jira: "ENG-123", linear: "LIN-123" };
const longWord = "a".repeat(130);
const titles = ["Fix café login", "Fix the login page so that it keeps the session after a refresh", "修復 🔧", longWord, "   "];

function settings(maximum: number | undefined): string {
  return `base_branch = "trunk"\n${maximum === undefined ? "" : `max_generated_branch_name_length = ${maximum}\n`}`
    + `[jira]\nsite_url = "https://acme.atlassian.net"\nproject = "ENG"\n[linear]\nteam = "LIN"\n`;
}

/** One open issue with `title` from each tracker; no login is real. */
function listServices(directory: string, title: string): AppIssuesServices {
  const env = { XDG_CONFIG_HOME: join(directory, "config"), JIRA_EMAIL: "person@example.invalid", JIRA_API_TOKEN: "token" };
  return {
    discoverRepository: cwd => discoverRepository(cwd),
    loadConfig: repository => loadRepositoryConfig(repository, env),
    listWorktreeInventory: repository => listWorktreeInventory(repository),
    readIssueLink: (repository, tree) => readIssueLink(repository, tree),
    githubRepository: (repository, config) => resolveGithubRepository(repository, config),
    timeoutMs: 5_000,
    now: () => new Date(2026, 10, 20, 12),
    trackers: {
      env,
      fetch: async url => {
        const address = new URL(url);
        if (address.host === "api.github.com") {
          if (address.pathname === "/graphql") return Response.json({ data: {} });
          return Response.json([{ number: 123, state: "open", title, html_url: "https://github.com/acme/widgets/issues/123", assignee: null }]);
        }
        if (address.host === "acme.atlassian.net") {
          return Response.json({ issues: [{ key: "ENG-123", fields: { summary: title, status: { name: "To Do", statusCategory: { key: "new" } }, assignee: null } }] });
        }
        return Response.json({ data: { issues: { pageInfo: { hasNextPage: false }, nodes: [{ id: "id-LIN-123", identifier: "LIN-123",
          url: "https://linear.app/acme/issue/LIN-123/x", title, state: { name: "Todo", type: "unstarted" }, assignee: null }] } } });
      },
      githubToken: async () => "token",
      linearToken: async () => "token",
      jiraCredentials: async () => null,
    },
  };
}

/** What `timber new` does with the same issue: the branch it would create, that it asked, or that it failed. */
async function runNew(primary: string, directory: string, tracker: LinkedTracker, title: string):
Promise<{ kind: "created"; branch: string } | { kind: "asked" } | { kind: "failed" }> {
  const env = { HOME: directory, XDG_CONFIG_HOME: join(directory, "config") };
  const created = new Error("created");
  let branch: string | undefined;
  let asked = false;
  const handler = createNewHandler(createServiceDouble({
    discoverRepository,
    loadConfig: repository => loadRepositoryConfig(repository, env),
    resolveBase,
    resolveGithubRepository: async () => ({ owner: "acme", name: "widgets" }),
    // The real GitHub lookup, so the GH- key comes from the code new uses.
    resolveGithubTicket: (repo, number, allowClosed) => resolveGithubTicket(repo, number, allowClosed, { token: async () => "token",
      fetch: async () => Response.json({ number, title, state: "open" }), timeoutMs: 5_000 }),
    resolveJiraTicket: async (_config, key) => ({ key, title, url: `https://acme.atlassian.net/browse/${key}` }),
    resolveLinearTicket: async key => ({ key, title, url: `https://linear.app/acme/issue/${key}/x` }),
    createWorktree: async (_repository, target) => {
      if (target.kind === "new") branch = target.branch;
      throw created;
    },
  }));
  try {
    await handler(`${tracker}:${keys[tracker]}`, {}, { cwd: primary, io, choose: async () => { asked = true; return null; }, ask: async () => null });
  } catch (error) {
    if (error !== created) return { kind: "failed" };
  }
  if (branch !== undefined) return { kind: "created", branch };
  return asked ? { kind: "asked" } : { kind: "failed" };
}

test.each([undefined, 30])("the listed branch is what timber new creates, or null when new would ask or fail (max %p)", async maximum => {
  await withRepository(async (primary, directory) => {
    await git(primary, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    await writeFile(join(primary, ".timber.toml"), settings(maximum));
    const outcomes: Record<string, string[]> = {};
    for (const title of titles) {
      for (const tracker of ["github", "jira", "linear"] as const) {
        const record = await readAppIssues(primary, "open", undefined, { tracker }, listServices(directory, title));
        expect(record.outcome).toBe("found");
        const listed = record.issues[0]!.branch;
        const created = await runNew(primary, directory, tracker, title);
        if (listed === null) expect(created.kind).not.toBe("created");
        else expect(created).toEqual({ kind: "created", branch: listed });
        (outcomes[tracker] ??= []).push(created.kind);
      }
    }
    // Every tracker saw names new creates, a blank title new refuses, and with a limit, names new asks about.
    const expected = maximum === undefined ? ["created", "created", "created", "created", "failed"]
      : ["created", "asked", "created", "asked", "failed"];
    expect(outcomes).toEqual({ github: expected, jira: expected, linear: expected });
  });
}, 60_000);

test.each([
  ["GH-123", "Fix café login", undefined, "GH-123-fix-cafe-login"],
  ["ENG-123", "Fix café login", 30, "ENG-123-fix-cafe-login"],
  ["LIN-123", "Fix café login", undefined, "LIN-123-fix-cafe-login"],
  // A title with no slug characters gets the same fallback new uses.
  ["ENG-123", "修復 🔧", undefined, "ENG-123-issue"],
  // The default limit cuts without asking, so the cut name is the prediction.
  ["GH-123", longWord, undefined, `GH-123-${"a".repeat(113)}`],
  // A configured limit that shortens the name makes new ask, so there is no prediction.
  ["ENG-123", "Fix the login page so that it keeps the session", 30, null],
  ["ENG-123", longWord, 30, null],
  // New refuses a blank title and a key too long for the limit.
  ["ENG-123", "   ", undefined, null],
  ["ENG-123", "Fix", 8, null],
] as const)("predictTicketBranch(%p, %p, %p) is %p", (key, title, maximum, expected) => {
  expect(predictTicketBranch(key, title, maximum)).toBe(expected);
  if (expected !== null) expect(generateTicketBranch(key, title, maximum).name).toBe(expected);
});

test("the default cut keeps 120 characters", () => {
  expect(predictTicketBranch("GH-123", longWord)).toHaveLength(120);
});
