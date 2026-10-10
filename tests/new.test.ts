import { expect, test } from "bun:test";
import { createNewHandler } from "../src/commands/new";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CommandContext } from "../src/services";
import type { RepositoryConfig, ValidatedBase } from "../src/types";

const config: RepositoryConfig = {
  baseBranch: "trunk", remote: null, worktreeDir: null, editor: null, agent: null,
};
const base: ValidatedBase = { ref: "refs/heads/other", commit: "a".repeat(40), source: "explicit" };

function context() {
  let stdout = "";
  const value: CommandContext = {
    cwd: "/repo/nested",
    io: { stdout: text => { stdout += text; }, stderr: () => { throw new Error("unexpected stderr"); } },
  };
  return { value, output: () => stdout };
}

test("new passes explicit base and disabled editor through ordered services", async () => {
  const calls: string[] = [];
  const repository = repositoryFixture();
  const tree = worktreeFixture({ path: "/repo-worktrees/feature-one", branch: "feature/one", isPrimary: false });
  const h = context();
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async cwd => { expect(cwd).toBe(h.value.cwd); calls.push("discover"); return repository; },
    loadConfig: async received => { expect(received).toBe(repository); calls.push("config"); return config; },
    resolveBase: async (received, selectedConfig, explicit) => {
      expect([received, selectedConfig, explicit]).toEqual([repository, config, "other"]);
      calls.push("base");
      return base;
    },
    createWorktree: async (received, request, selectedConfig) => {
      expect([received, request, selectedConfig]).toEqual([
        repository, { kind: "new", branch: "feature/one", base }, config,
      ]);
      calls.push("create");
      return tree;
    },
    launchEditor: async (received, selectedConfig, disabled) => {
      expect([received, selectedConfig, disabled]).toEqual([tree, config, true]);
      expect(h.output()).toBe("Created feature/one at /repo-worktrees/feature-one\n");
      calls.push("editor");
      return { kind: "skipped" };
    },
  }));

  await handler("feature/one", { base: "other", editor: false }, h.value);
  expect(calls).toEqual(["discover", "config", "base", "create", "editor"]);
});

test("new resolves a configured ticket after base selection and creates from its canonical key", async () => {
  const calls: string[] = [];
  const repository = repositoryFixture();
  const jiraConfig = { siteUrl: "https://example.atlassian.net" };
  const configured: RepositoryConfig = { ...config, jira: jiraConfig, hooks: { postCreate: ["setup"] } };
  const ticket = {
    key: "ABU-835", title: "Fix café / login!", url: "https://example.atlassian.net/browse/ABU-835",
  };
  const branch = "ABU-835-fix-cafe-login";
  const tree = worktreeFixture({ path: "/repo-worktrees/ABU-835-fix-cafe-login", branch, isPrimary: false });
  const h = context();
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => { calls.push("discover"); return repository; },
    loadConfig: async () => { calls.push("config"); return configured; },
    resolveBase: async (received, selectedConfig, explicit) => {
      expect([received, selectedConfig, explicit]).toEqual([repository, configured, "trunk"]);
      calls.push("base");
      return base;
    },
    resolveJiraTicket: async (received, key) => {
      expect([received, key]).toEqual([jiraConfig, "ABU-834"]);
      calls.push("jira");
      return ticket;
    },
    createWorktree: async (received, request, selectedConfig) => {
      expect([received, request, selectedConfig]).toEqual([
        repository, { kind: "new", branch, base }, configured,
      ]);
      calls.push("create");
      return tree;
    },
    runSetup: async (received, worktree, selectedConfig, io) => {
      expect([received, worktree, selectedConfig, io]).toEqual([repository, tree, configured, h.value.io]);
      expect(h.output()).toBe(
        `Created ${branch} at ${tree.path}\nJira: ${ticket.url}\n`,
      );
      calls.push("setup");
    },
    launchEditor: async (worktree, selectedConfig, disabled) => {
      expect([worktree, selectedConfig, disabled]).toEqual([tree, configured, true]);
      calls.push("editor");
      return { kind: "skipped" };
    },
  }));

  await handler("ABU-834", { base: "trunk", editor: false }, h.value);
  expect(calls).toEqual(["discover", "config", "base", "jira", "create", "setup", "editor"]);
  expect(h.output()).toBe(`Created ${branch} at ${tree.path}\nJira: ${ticket.url}\n`);
});

test("new skips Jira lookup for unconfigured IDs and configured literal branches", async () => {
  for (const scenario of [
    { input: "ABU-834", selectedConfig: config },
    { input: "feature/ABU-834", selectedConfig: { ...config, jira: { siteUrl: "https://example.atlassian.net" } } },
    { input: "ABU-834-fix", selectedConfig: { ...config, jira: { siteUrl: "https://example.atlassian.net" } } },
  ]) {
    const h = context();
    const tree = worktreeFixture({ path: "/repo-worktrees/literal", branch: scenario.input, isPrimary: false });
    const handler = createNewHandler(createServiceDouble({
      discoverRepository: async () => repositoryFixture(),
      loadConfig: async () => scenario.selectedConfig,
      resolveBase: async () => base,
      createWorktree: async (_repository, request) => {
        expect(request).toEqual({ kind: "new", branch: scenario.input, base });
        return tree;
      },
      launchEditor: async () => ({ kind: "skipped" }),
    }));

    await handler(scenario.input, {}, h.value);
    expect(h.output()).toBe(`Created ${scenario.input} at ${tree.path}\n`);
  }
});

test("new lookup failure stops before creation, setup, editor, and success output", async () => {
  const calls: string[] = [];
  const h = context();
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => { calls.push("discover"); return repositoryFixture(); },
    loadConfig: async () => ({ ...config, jira: { siteUrl: "https://example.atlassian.net" } }),
    resolveBase: async () => { calls.push("base"); return base; },
    resolveJiraTicket: async () => { calls.push("jira"); throw new Error("Jira returned unavailable."); },
  }));

  await expect(handler("ABU-834", {}, h.value)).rejects.toThrow("Jira returned unavailable.");
  expect(calls).toEqual(["discover", "base", "jira"]);
  expect(h.output()).toBe("");
});

test("new emits ticket details only after worktree creation succeeds", async () => {
  const h = context();
  const ticket = { key: "ABU-834", title: "Fix login", url: "https://example.atlassian.net/browse/ABU-834" };
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => ({ ...config, jira: { siteUrl: "https://example.atlassian.net" } }),
    resolveBase: async () => base,
    resolveJiraTicket: async () => ticket,
    createWorktree: async () => { throw new Error("branch collision"); },
  }));

  await expect(handler("ABU-834", {}, h.value)).rejects.toThrow("branch collision");
  expect(h.output()).toBe("");
});

test("new keeps reported workspace when editor startup fails", async () => {
  const h = context();
  const tree = worktreeFixture({ path: "/repo-worktrees/feature", branch: "feature", isPrimary: false });
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => config,
    resolveBase: async () => base,
    createWorktree: async () => tree,
    launchEditor: async () => ({
      kind: "failed", message: "editor failed; retry: timber open -- '/repo-worktrees/feature'",
      retryCommand: "timber open -- '/repo-worktrees/feature'",
    }),
  }));

  await expect(handler("feature", {}, h.value)).rejects.toThrow("editor failed; retry:");
  expect(h.output()).toBe("Created feature at /repo-worktrees/feature\n");
});

test("new stops before creation and editor when base selection fails", async () => {
  const h = context();
  const calls: string[] = [];
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => ({ ...config, jira: { siteUrl: "https://example.atlassian.net" } }),
    resolveBase: async () => { calls.push("base"); throw new Error("base ambiguous"); },
    resolveJiraTicket: async () => { calls.push("jira"); throw new Error("lookup must not happen"); },
  }));
  await expect(handler("ABU-834", {}, h.value)).rejects.toThrow("base ambiguous");
  expect(calls).toEqual(["base"]);
  expect(h.output()).toBe("");
});
