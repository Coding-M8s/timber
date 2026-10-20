import { expect, test } from "bun:test";
import { createNewHandler } from "../src/commands/new";
import { JiraLookupFailure } from "../src/jira/client";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CommandContext } from "../src/services";
import type { RepositoryConfig, ValidatedBase } from "../src/types";

const config: RepositoryConfig = {
  baseBranch: "trunk", remote: null, worktreeDir: null, editor: null, agent: null,
};
const base: ValidatedBase = { ref: "refs/heads/other", commit: "a".repeat(40), source: "explicit" };

function context(choose?: (message: string, choices: readonly { value: string; label: string }[]) => Promise<string | null>) {
  let stdout = "";
  const value: CommandContext & { choose?: typeof choose } = {
    cwd: "/repo/nested",
    io: { stdout: text => { stdout += text; }, stderr: () => { throw new Error("unexpected stderr"); } },
    ...(choose === undefined ? {} : { choose }),
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

test("new normalizes only literal-space sentence inputs and preserves single-token branches", async () => {
  const repository = repositoryFixture();
  for (const scenario of [
    { input: "   Investigate  SLOW API usage page   ", expected: "investigate-slow-api-usage-page" },
    { input: "feature/API-fix", expected: "feature/API-fix" },
    { input: "TIM-19", expected: "TIM-19" },
  ]) {
    const h = context();
    const handler = createNewHandler(createServiceDouble({
      discoverRepository: async () => repository,
      loadConfig: async () => config,
      resolveBase: async () => base,
      createWorktree: async (_received, request) => {
        expect(request).toEqual({ kind: "new", branch: scenario.expected, base });
        return worktreeFixture({ path: `/repo-worktrees/${scenario.expected}`, branch: scenario.expected, isPrimary: false });
      },
      launchEditor: async () => ({ kind: "skipped" }),
    }));

    await handler(scenario.input, { editor: false }, h.value);
    expect(h.output()).toContain(`Created ${scenario.expected} at `);
  }
});

test("new rejects blank and control-character names before worktree creation", async () => {
  const repository = repositoryFixture();
  let creations = 0;
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repository,
    loadConfig: async () => config,
    resolveBase: async () => base,
    createWorktree: async () => {
      creations++;
      return worktreeFixture({ isPrimary: false });
    },
    launchEditor: async () => ({ kind: "skipped" }),
  }));

  for (const input of ["", "   ", "bad\u001b[2J\nbranch", "tab\tbranch"]) {
    const h = context();
    let failure: unknown;
    try { await handler(input, { editor: false }, h.value); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Invalid branch name");
    expect(creations).toBe(0);
    if (input.includes("\u001b")) {
      expect((failure as Error).message).toContain("\\u001b");
      expect((failure as Error).message).toContain("\\n");
    }
  }
});

test("new keeps exact Jira matching on the raw whole input before sentence normalization", async () => {
  const repository = repositoryFixture();
  const configured: RepositoryConfig = {
    ...config,
    jira: { siteUrl: "https://example.atlassian.net" },
  };
  let lookups = 0;
  const h = context();
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repository,
    loadConfig: async () => configured,
    resolveBase: async () => base,
    resolveJiraTicket: async () => { lookups++; throw new Error("unexpected Jira lookup"); },
    createWorktree: async (_received, request) => {
      expect(request).toEqual({ kind: "new", branch: "abu-834", base });
      return worktreeFixture({ path: "/repo-worktrees/abu-834", branch: "abu-834", isPrimary: false });
    },
    launchEditor: async () => ({ kind: "skipped" }),
  }));

  await handler(" ABU-834 ", { editor: false }, h.value);
  expect(lookups).toBe(0);
  expect(h.output()).toContain("Created abu-834 at /repo-worktrees/abu-834");
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

test("new offers a same-project prefix choice after an exact missing ticket, then re-fetches its current title", async () => {
  const calls: string[] = [];
  const repository = repositoryFixture();
  const jiraConfig = { siteUrl: "https://example.atlassian.net" };
  const configured: RepositoryConfig = { ...config, jira: jiraConfig };
  const staleSuggestion = {
    key: "ABU-40", title: "Old title", url: "https://example.atlassian.net/browse/ABU-40",
  };
  const freshTicket = {
    key: "ABU-40", title: "Fresh café summary", url: "https://example.atlassian.net/browse/ABU-40",
  };
  const branch = "ABU-40-fresh-cafe-summary";
  const tree = worktreeFixture({ path: `/repo-worktrees/${branch}`, branch, isPrimary: false });
  const h = context(async (message, choices) => {
    calls.push("choose");
    expect(message).toMatch(/unavailable or not visible[\s\S]*Did you mean/i);
    expect(message).toEndWith("\nDid you mean one of these?");
    expect(choices).toEqual([{ value: "ABU-40", label: "ABU-40 - Old title" }]);
    return "ABU-40";
  });
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => { calls.push("discover"); return repository; },
    loadConfig: async () => configured,
    resolveBase: async () => { calls.push("base"); return base; },
    resolveJiraTicket: async (_config, key) => {
      calls.push(`jira:${key}`);
      if (key === "ABU-4") throw new JiraLookupFailure("Jira issue is unavailable or not visible (404); check the key and access.", "not-found");
      expect(key).toBe("ABU-40");
      return freshTicket;
    },
    findJiraSuggestions: async (_config, key) => {
      expect(key).toBe("ABU-4");
      calls.push("suggestions");
      return [staleSuggestion];
    },
    createWorktree: async (_repository, request) => {
      calls.push("create");
      expect(request).toEqual({ kind: "new", branch, base });
      return tree;
    },
    launchEditor: async () => { calls.push("editor"); return { kind: "skipped" }; },
  }));

  await handler("ABU-4", { editor: false }, h.value);

  expect(calls).toEqual([
    "discover", "base", "jira:ABU-4", "suggestions", "choose", "jira:ABU-40", "create", "editor",
  ]);
  expect(h.output()).toBe(`Created ${branch} at ${tree.path}\nJira: ${freshTicket.url}\n`);
});

test("new offers exactly one suggestion through the chooser and cancellation stops before mutation", async () => {
  for (const selected of ["ABU-40", null]) {
    const calls: string[] = [];
    const h = context(async (_message, choices) => {
      calls.push("choose");
      expect(choices).toHaveLength(1);
      return selected;
    });
    const handler = createNewHandler(createServiceDouble({
      discoverRepository: async () => repositoryFixture(),
      loadConfig: async () => ({ ...config, jira: { siteUrl: "https://example.atlassian.net" } }),
      resolveBase: async () => base,
      resolveJiraTicket: async (_config, key) => {
        calls.push(`jira:${key}`);
        if (key === "ABU-4") throw new JiraLookupFailure("Jira issue is unavailable or not visible (404); check the key and access.", "not-found");
        return { key, title: "Selected issue", url: `https://example.atlassian.net/browse/${key}` };
      },
      findJiraSuggestions: async () => [{
        key: "ABU-40", title: "Selected issue", url: "https://example.atlassian.net/browse/ABU-40",
      }],
      createWorktree: async () => { calls.push("create"); return worktreeFixture({ path: "/tree", branch: "ABU-40-selected-issue" }); },
      launchEditor: async () => ({ kind: "skipped" }),
    }));

    if (selected === null) {
      await handler("ABU-4", {}, h.value);
      expect(calls).toEqual(["jira:ABU-4", "choose"]);
      expect(h.output()).toBe("Cancelled.\n");
    } else {
      await handler("ABU-4", {}, h.value);
      expect(calls).toEqual(["jira:ABU-4", "choose", "jira:ABU-40", "create"]);
    }
  }
});

test("new stops when the selected suggestion became done without suggesting again", async () => {
  for (const chosenFailure of [
    { reason: "done" as const, message: "Jira issue ABU-40 is complete; refusing to create a branch." },
    { reason: "not-found" as const, message: "Jira issue is unavailable or not visible (404); check the key and access." },
  ]) {
    const calls: string[] = [];
    const h = context(async () => "ABU-40");
    const handler = createNewHandler(createServiceDouble({
      discoverRepository: async () => repositoryFixture(),
      loadConfig: async () => ({ ...config, jira: { siteUrl: "https://example.atlassian.net" } }),
      resolveBase: async () => base,
      resolveJiraTicket: async (_config, key) => {
        calls.push(`jira:${key}`);
        if (key === "ABU-4") throw new JiraLookupFailure("Jira issue ABU-4 is complete; refusing to create a branch.", "done");
        throw new JiraLookupFailure(chosenFailure.message, chosenFailure.reason);
      },
      findJiraSuggestions: async () => { calls.push("suggestions"); return [{
        key: "ABU-40", title: "Fresh candidate", url: "https://example.atlassian.net/browse/ABU-40",
      }]; },
      createWorktree: async () => { calls.push("create"); return worktreeFixture(); },
    }));

    await expect(handler("ABU-4", {}, h.value)).rejects.toThrow(chosenFailure.message);
    expect(calls).toEqual(["jira:ABU-4", "suggestions", "jira:ABU-40"]);
    expect(h.output()).toBe("");
  }
});

test("new preserves exact lookup failure when suggestions fail", async () => {
  const h = context(async () => { throw new Error("should not choose after failed search"); });
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => ({ ...config, jira: { siteUrl: "https://example.atlassian.net" } }),
    resolveBase: async () => base,
    resolveJiraTicket: async () => { throw new JiraLookupFailure("Jira issue is unavailable or not visible (404); check the key and access.", "not-found"); },
    findJiraSuggestions: async () => { throw new JiraLookupFailure("Jira suggestions could not be loaded completely; retry when service is reachable."); },
  }));

  await expect(handler("ABU-4", {}, h.value)).rejects.toThrow(/unavailable or not visible \(404\).*suggestions could not be loaded/i);
  expect(h.output()).toBe("");
});

test("new shows at most five suggestions and the total when no interactive chooser is available", async () => {
  const suggestions = Array.from({ length: 8 }, (_, index) => ({
    key: `ABU-${40 + index}`, title: index === 4
      ? "Candidate title 5\u001b[2J" : `Candidate title ${index + 1}`,
    url: `https://example.atlassian.net/browse/ABU-${40 + index}`,
  }));
  const h = context();
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => ({ ...config, jira: { siteUrl: "https://example.atlassian.net" } }),
    resolveBase: async () => base,
    resolveJiraTicket: async () => { throw new JiraLookupFailure("Jira issue is unavailable or not visible (404); check the key and access.", "not-found"); },
    findJiraSuggestions: async () => suggestions,
    createWorktree: async () => { throw new Error("must not mutate"); },
  }));

  const failure = await handler("ABU-4", {}, h.value).then(() => null, error => error as Error);
  expect(failure?.message).toMatch(/8 unfinished Jira prefix matches.*showing 5/);
  expect(failure?.message).toContain("Candidate title 5\\u001b[2J");
  expect(failure?.message).not.toContain("Candidate title 6");
  expect(failure?.message).toContain("Run `timber new <candidate-key>` explicitly");
  expect(failure?.message.replace(/\n/gu, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
  expect(h.output()).toBe("");
});

test("new rejects a chooser value outside the exact suggestions", async () => {
  const calls: string[] = [];
  const h = context(async () => "ABU-41");
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => ({ ...config, jira: { siteUrl: "https://example.atlassian.net" } }),
    resolveBase: async () => base,
    resolveJiraTicket: async (_config, key) => {
      calls.push(`jira:${key}`);
      throw new JiraLookupFailure("Jira issue is unavailable or not visible (404); check the key and access.", "not-found");
    },
    findJiraSuggestions: async () => [{
      key: "ABU-40", title: "Candidate", url: "https://example.atlassian.net/browse/ABU-40",
    }],
    createWorktree: async () => { calls.push("create"); return worktreeFixture(); },
  }));

  await expect(handler("ABU-4", {}, h.value)).rejects.toThrow(/unknown suggestion/i);
  expect(calls).toEqual(["jira:ABU-4"]);
  expect(h.output()).toBe("");
});

test("new does not search after authentication or untyped failures", async () => {
  for (const failure of [
    new JiraLookupFailure("Jira authentication rejected (401); check the email and token."),
    new Error("unexpected failure"),
  ]) {
    const calls: string[] = [];
    const handler = createNewHandler(createServiceDouble({
      discoverRepository: async () => repositoryFixture(),
      loadConfig: async () => ({ ...config, jira: { siteUrl: "https://example.atlassian.net" } }),
      resolveBase: async () => base,
      resolveJiraTicket: async () => { throw failure; },
      findJiraSuggestions: async () => { calls.push("suggestions"); return []; },
    }));
    await expect(handler("ABU-4", {}, context().value)).rejects.toThrow(failure.message);
    expect(calls).toEqual([]);
  }
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
