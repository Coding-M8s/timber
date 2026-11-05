import { expect, test } from "bun:test";
import { createNewHandler } from "../src/commands/new";
import { GithubLookupFailure } from "../src/github/client";
import { LinearLookupFailure } from "../src/linear/client";
import { JiraLookupFailure } from "../src/jira/client";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CommandServices, NewOptions } from "../src/services";
import type { IssueTracker, RepositoryConfig } from "../src/types";

const base = { ref: "refs/heads/main", commit: "a".repeat(40), source: "explicit" as const };
const config: RepositoryConfig = { baseBranch: "main", remote: null, worktreeDir: null, editor: null, agent: null,
  jira: { siteUrl: "https://example.atlassian.net" }, hooks: { postCreate: ["setup"] } };
const ticket = { key: "ENG-123", title: "Fix login", url: "https://linear.app/w/issue/ENG-123" };

function harness(defaultTracker?: IssueTracker, overrides: Partial<CommandServices> = {}) {
  const calls: string[] = []; let output = ""; let created = "";
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => ({ ...config, ...(defaultTracker ? { defaultTracker } : {}) }),
    resolveBase: async () => { calls.push("base"); return base; },
    resolveGithubRepository: async () => ({ owner: "team", name: "repo" }),
    resolveGithubTicket: async () => { calls.push("github"); return { ...ticket, key: "GH-97" }; },
    resolveLinearTicket: async () => { calls.push("linear"); return ticket; },
    resolveJiraTicket: async () => { calls.push("jira"); return ticket; },
    createWorktree: async (_repo, request) => { calls.push("create"); if (request.kind !== "new") throw new Error("expected new"); created = request.branch; return worktreeFixture(); },
    runSetup: async () => { calls.push("setup"); },
    launchEditor: async () => ({ kind: "skipped" }),
    ...overrides,
  }));
  return { calls, output: () => output, branch: () => created,
    run: (input: string, options: NewOptions = {}) => handler(input, options, { cwd: "/repo", io: { stdout: text => { output += text; }, stderr() {} } }) };
}

for (const [provider, raw, expected] of [["github", "97", "GH-97-fix-login"], ["linear", "ENG-123", "ENG-123-fix-login"], ["jira", "ENG-123", "ENG-123-fix-login"]] as const) {
  test(`default ${provider} names from its issue and displays details before setup`, async () => {
    const h = harness(provider, { runSetup: async () => {
      expect(h.output()).toContain("Fix login"); expect(h.output()).toContain(ticket.url);
    } });
    await h.run(raw); expect(h.branch()).toBe(expected); expect(h.calls).toEqual(["base", provider, "create"]);
  });
  test(`explicit ${provider} overrides None and forwards -c`, async () => {
    let allowClosed = false;
    const lookup = async (...args: unknown[]) => { allowClosed = args.at(-1) === true; return ticket; };
    const h = harness("none", { [provider === "github" ? "resolveGithubTicket" : provider === "linear" ? "resolveLinearTicket" : "resolveJiraTicket"]: lookup });
    await h.run(`${provider}:${raw}`, { allowClosed: true }); expect(allowClosed).toBe(true); expect(h.branch()).toBe("ENG-123-fix-login");
  });
  const missing = provider === "github" ? new GithubLookupFailure("missing", "not-found")
    : provider === "linear" ? new LinearLookupFailure("missing", "not-found") : new JiraLookupFailure("missing", "not-found");
  const service = provider === "github" ? "resolveGithubTicket" : provider === "linear" ? "resolveLinearTicket" : "resolveJiraTicket";
  test(`${provider} missing falls back only under an explicit default`, async () => {
    const h = harness(provider, { [service]: async () => { throw missing; }, createWorktree: async (_repo, request) => {
      expect(request.branch).toBe(raw); expect(h.output()).toContain(`Creating literal branch ${raw}`); return worktreeFixture();
    } });
    await h.run(raw, { allowClosed: true });
    const explicit = harness(provider, { [service]: async () => { throw missing; } });
    await expect(explicit.run(`${provider}:${raw}`)).rejects.toThrow("missing"); expect(explicit.calls).toEqual(["base"]);
  });
  for (const reason of ["authentication", "permission denied", "network timeout", "closed", "invalid response", "deleted"]) {
    test(`${provider} ${reason} never creates or runs setup`, async () => {
      const h = harness(provider, { [service]: async () => { throw new Error(reason); } });
      await expect(h.run(raw)).rejects.toThrow(reason); expect(h.calls).toEqual(["base"]);
    });
  }
}

test("None suppresses inherited Jira routing; issue-only flags cannot turn literals into lookups", async () => {
  const h = harness("none"); await h.run("ENG-123"); expect(h.branch()).toBe("ENG-123"); expect(h.calls).toEqual(["base", "create", "setup"]);
  for (const options of [{ allowClosed: true }, { remote: "origin" }]) {
    const literal = harness("none"); await expect(literal.run("ENG-123", options)).rejects.toThrow(); expect(literal.calls).toEqual([]);
  }
});

test("bare default GitHub accepts --remote; non-GitHub routes refuse it", async () => {
  const h = harness("github", { resolveGithubRepository: async (_repo, _config, remote) => {
    expect(remote).toBe("upstream"); return { owner: "team", name: "repo" };
  } });
  await h.run("97", { remote: "upstream" }); expect(h.branch()).toBe("GH-97-fix-login");
  await expect(harness("linear").run("ENG-123", { remote: "origin" })).rejects.toThrow();
});

test("legacy Jira -c is exact and missing does not fall back or suggest", async () => {
  const h = harness(undefined, { resolveJiraTicket: async (_config, _key, allowClosed) => {
    expect(allowClosed).toBe(true); throw new JiraLookupFailure("missing", "not-found");
  } });
  await expect(h.run("ENG-123", { allowClosed: true })).rejects.toThrow("missing"); expect(h.calls).toEqual(["base"]);
});

test("explicit Jira without effective site settings fails before lookup or creation", async () => {
  const h = harness("none", { loadConfig: async () => { const { jira: _jira, ...withoutJira } = config; return withoutJira; } });
  await expect(h.run("jira:ENG-123")).rejects.toThrow(/Jira.*setup/u); expect(h.calls).not.toContain("create");
});

test("Git creation failure never retries literally or runs setup", async () => {
  const h = harness("linear", { createWorktree: async () => { throw new Error("branch exists"); } });
  await expect(h.run("ENG-123")).rejects.toThrow("branch exists"); expect(h.calls).toEqual(["base", "linear"]);
});
