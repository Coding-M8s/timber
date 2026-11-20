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
  const configured: RepositoryConfig = { ...config, defaultTracker: "jira" as const, jira: jiraConfig, hooks: { postCreate: ["setup"] } };
  const ticket = {
    key: "ENG-835", title: "Fix café / login!", url: "https://example.atlassian.net/browse/ENG-835",
  };
  const branch = "ENG-835-fix-cafe-login";
  const tree = worktreeFixture({ path: "/repo-worktrees/ENG-835-fix-cafe-login", branch, isPrimary: false });
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
      expect([received, key]).toEqual([jiraConfig, "ENG-834"]);
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
        `Created ${branch} at ${tree.path}\nJira: ${ticket.url}\n${ticket.key} - ${ticket.title}\n`,
      );
      calls.push("setup");
    },
    launchEditor: async (worktree, selectedConfig, disabled) => {
      expect([worktree, selectedConfig, disabled]).toEqual([tree, configured, true]);
      calls.push("editor");
      return { kind: "skipped" };
    },
  }));

  await handler("ENG-834", { base: "trunk", editor: false }, h.value);
  expect(calls).toEqual(["discover", "config", "base", "jira", "create", "setup", "editor"]);
  expect(h.output()).toBe(`Created ${branch} at ${tree.path}\nJira: ${ticket.url}\n${ticket.key} - ${ticket.title}\n`);
});

test("new skips Jira lookup for unconfigured IDs and configured literal branches", async () => {
  for (const scenario of [
    { input: "ENG-834", selectedConfig: config },
    { input: "feature/ENG-834", selectedConfig: { ...config, defaultTracker: "jira" as const, jira: { siteUrl: "https://example.atlassian.net" } } },
    { input: "ENG-834-fix", selectedConfig: { ...config, defaultTracker: "jira" as const, jira: { siteUrl: "https://example.atlassian.net" } } },
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
    defaultTracker: "jira" as const, jira: { siteUrl: "https://example.atlassian.net" },
  };
  let lookups = 0;
  const h = context();
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repository,
    loadConfig: async () => configured,
    resolveBase: async () => base,
    resolveJiraTicket: async () => { lookups++; throw new Error("unexpected Jira lookup"); },
    createWorktree: async (_received, request) => {
      expect(request).toEqual({ kind: "new", branch: "eng-834", base });
      return worktreeFixture({ path: "/repo-worktrees/eng-834", branch: "eng-834", isPrimary: false });
    },
    launchEditor: async () => ({ kind: "skipped" }),
  }));

  await handler(" ENG-834 ", { editor: false }, h.value);
  expect(lookups).toBe(0);
  expect(h.output()).toContain("Created eng-834 at /repo-worktrees/eng-834");
});

test("new lookup failure stops before creation, setup, editor, and success output", async () => {
  const calls: string[] = [];
  const h = context();
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => { calls.push("discover"); return repositoryFixture(); },
    loadConfig: async () => ({ ...config, defaultTracker: "jira" as const, jira: { siteUrl: "https://example.atlassian.net" } }),
    resolveBase: async () => { calls.push("base"); return base; },
    resolveJiraTicket: async () => { calls.push("jira"); throw new Error("Jira returned unavailable."); },
  }));

  await expect(handler("ENG-834", {}, h.value)).rejects.toThrow("Jira returned unavailable.");
  expect(calls).toEqual(["discover", "base", "jira"]);
  expect(h.output()).toBe("");
});

test("new emits ticket details only after worktree creation succeeds", async () => {
  const h = context();
  const ticket = { key: "ENG-834", title: "Fix login", url: "https://example.atlassian.net/browse/ENG-834" };
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => ({ ...config, defaultTracker: "jira" as const, jira: { siteUrl: "https://example.atlassian.net" } }),
    resolveBase: async () => base,
    resolveJiraTicket: async () => ticket,
    createWorktree: async () => { throw new Error("branch collision"); },
  }));

  await expect(handler("ENG-834", {}, h.value)).rejects.toThrow("branch collision");
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
    loadConfig: async () => ({ ...config, defaultTracker: "jira" as const, jira: { siteUrl: "https://example.atlassian.net" } }),
    resolveBase: async () => { calls.push("base"); throw new Error("base ambiguous"); },
    resolveJiraTicket: async () => { calls.push("jira"); throw new Error("lookup must not happen"); },
  }));
  await expect(handler("ENG-834", {}, h.value)).rejects.toThrow("base ambiguous");
  expect(calls).toEqual(["base"]);
  expect(h.output()).toBe("");
});

test("new saves the resolved base before setup and retains creation when saving fails", async () => {
  for (const fails of [false, true]) {
    const calls: string[] = [];
    const repository = repositoryFixture();
    const tree = worktreeFixture({ path: "/repo-worktrees/feature", branch: "feature", isPrimary: false });
    const handler = createNewHandler(createServiceDouble({
      discoverRepository: async () => repository,
      loadConfig: async () => ({ ...config, hooks: { postCreate: ["setup"] } }),
      resolveBase: async () => base,
      createWorktree: async () => { calls.push("create"); return tree; },
      writeBaseAssociation: async (repo, created, ref) => {
        expect([repo, created, ref]).toEqual([repository, tree, "refs/heads/other"]);
        calls.push("save");
        if (fails) throw new Error("Cannot save base; worktree retained");
      },
      runSetup: async () => { calls.push("setup"); },
      launchEditor: async () => { calls.push("editor"); return { kind: "skipped" }; },
    }));
    if (fails) await expect(handler("feature", {}, context().value)).rejects.toThrow(/worktree retained.*\/repo-worktrees\/feature.*timber rebase/s);
    else await handler("feature", {}, context().value);
    expect(calls).toEqual(fails ? ["create", "save"] : ["create", "save", "setup", "editor"]);
  }
});

// Existing-branch guard (GH-53). Doubles drive each decision path; nothing may be created on refusal.
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const present = (commit: string) => ({ kind: "present" as const, commit });
const remoteState = (remote: string, cached: string | null, live: import("../src/git/new-collision").RemoteHeadState, selectorSafe = true) =>
  ({ remote, cached, live, selectorSafe });

function guarded(options: {
  inspections: import("../src/git/new-collision").NewBranchInspection[];
  choose?: (message: string, choices: readonly { value: string; label: string; default?: boolean }[]) => Promise<string | null>;
  name?: string;
  repositoryRemotes?: string[];
  config?: RepositoryConfig;
  services?: Partial<import("../src/commands/new").NewServices>;
}) {
  const calls: string[] = [];
  const opened: Array<[string, unknown]> = [];
  const seen: string[] = [];
  const queue = [...options.inspections];
  const h = context(options.choose as never);
  const services = createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => options.config ?? config,
    resolveBase: async () => base,
    ...options.services,
    inspectNewBranchCollision: async (_repository, name) => {
      seen.push(name);
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
    createWorktree: async () => { calls.push("create"); throw new Error("must not create"); },
    writeBaseAssociation: async () => { calls.push("base-association"); },
    runSetup: async () => { calls.push("setup"); },
    launchEditor: async () => { calls.push("editor"); return { kind: "skipped" }; },
    launchAgent: async () => { calls.push("agent"); return { kind: "skipped" }; },
  });
  const handler = createNewHandler({
    ...services,
    openExisting: async (input, openOptions) => { opened.push([input, openOptions]); },
  });
  return { handler, h, calls, opened, seen };
}

const remoteInspection = (name: string, remotes: ReturnType<typeof remoteState>[]) =>
  ({ name, local: null, remotes });

test("new guard receives the final resolved name for sentence, Jira and shortened inputs", async () => {
  const repository = repositoryFixture();
  const seen: string[] = [];
  const make = (configured: RepositoryConfig, extra = {}) => createNewHandler(createServiceDouble({
    discoverRepository: async () => repository,
    loadConfig: async () => configured,
    resolveBase: async () => base,
    inspectNewBranchCollision: async (_r, name) => { seen.push(name); return { name, local: null, remotes: [] }; },
    createWorktree: async () => worktreeFixture({ path: "/w", isPrimary: false }),
    launchEditor: async () => ({ kind: "skipped" }),
    ...extra,
  }));
  await make(config)("Fix Login", {}, context().value);
  const jira = { ...config, defaultTracker: "jira" as const, jira: { siteUrl: "https://example.atlassian.net" } };
  await make(jira, { resolveJiraTicket: async () => ({ key: "ENG-9", title: "Fix Login!", url: "https://x" }) })("ENG-9", {}, context().value);
  expect(seen).toEqual(["fix-login", "ENG-9-fix-login"]);
});

test("new creates normally when the guard finds nothing, including repositories without remotes", async () => {
  const g = guarded({ inspections: [{ name: "feature/example", local: null, remotes: [] }] });
  g.h.value.io.stdout = () => {};
  // createWorktree double throws, so reaching it proves the guard allowed creation.
  await expect(g.handler("feature/example", { base: undefined } as never, g.h.value)).rejects.toThrow("must not create");
  expect(g.seen).toEqual(["feature/example"]);
  const missing = guarded({ inspections: [remoteInspection("feature/example", [remoteState("origin", null, { kind: "missing" })])] });
  await expect(missing.handler("feature/example", {}, missing.h.value)).rejects.toThrow("must not create");
});

test("new offers Open existing branch with Cancel as default and delegates to open", async () => {
  const prompts: Array<{ message: string; choices: readonly { value: string; label: string; default?: boolean }[] }> = [];
  const inspection = remoteInspection("feature/example", [remoteState("origin", commitA, present(commitA))]);
  const g = guarded({
    inspections: [inspection],
    choose: async (message, choices) => { prompts.push({ message, choices }); return "origin"; },
  });
  await g.handler("feature/example", { workflow: undefined, setup: false } as never, g.h.value);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]!.message).toBe("Branch already exists on origin. Did you mean timber open?");
  expect(prompts[0]!.choices.map(choice => choice.label)).toEqual(["Open existing branch", "Cancel"]);
  expect(prompts[0]!.choices.filter(choice => choice.default).map(choice => choice.label)).toEqual(["Cancel"]);
  expect(g.opened).toEqual([["origin/feature/example", { setup: false }]]);
  expect(g.calls).toEqual([]);
  expect(g.seen).toEqual(["feature/example", "feature/example"]);
});

test("new cancel, q and end of input leave everything untouched", async () => {
  const inspection = remoteInspection("feature/example", [remoteState("origin", commitA, present(commitA))]);
  for (const answer of [null, "\u0000cancel"]) {
    const g = guarded({ inspections: [inspection], choose: async () => answer });
    await g.handler("feature/example", {}, g.h.value);
    expect(g.h.output()).toBe("Cancelled.\n");
    expect(g.opened).toEqual([]);
    expect(g.calls).toEqual([]);
  }
});

test("new refuses noninteractively with a safely quoted open command", async () => {
  for (const name of ["feature/example", "feature/it's"]) {
    const g = guarded({ inspections: [remoteInspection(name, [remoteState("origin", commitA, present(commitA))])] });
    await expect(g.handler(name, {}, g.h.value)).rejects.toThrow(
      `Branch ${name} already exists on origin. Did you mean timber open? No worktree was created.`);
    await expect(g.handler(name, {}, g.h.value)).rejects.toThrow(
      `timber open -- '${("origin/" + name).replaceAll("'", "'\\''")}'`);
    expect(g.opened).toEqual([]);
    expect(g.calls).toEqual([]);
  }
});

test("new surfaces cached and live disagreement with commit ids or missing", async () => {
  for (const [cached, expected] of [[null, "missing"], [commitB, commitB.slice(0, 12)]] as const) {
    const prompts: string[] = [];
    const g = guarded({
      inspections: [remoteInspection("feature/example", [remoteState("origin", cached, present(commitA))])],
      choose: async message => { prompts.push(message); return "\u0000cancel"; },
    });
    await g.handler("feature/example", {}, g.h.value);
    expect(prompts[0]).toContain(`Cached origin/feature/example: ${expected}; live: ${commitA.slice(0, 12)}`);
  }
});

test("new refuses a deleted upstream and unknown remote state in every mode without prompting", async () => {
  let prompted = false;
  const choose = async () => { prompted = true; return "origin"; };
  const deleted = guarded({
    inspections: [remoteInspection("feature/example", [remoteState("origin", commitA, { kind: "missing" })])], choose,
  });
  await expect(deleted.handler("feature/example", {}, deleted.h.value)).rejects.toThrow(
    `Remote-tracking ref origin/feature/example is at ${commitA.slice(0, 12)}, but the branch is missing on origin. No worktree was created.`.split(". ")[0]!);
  const unknown = guarded({
    inspections: [remoteInspection("feature/example", [remoteState("origin", null, { kind: "unknown", reason: "lookup failed" })])], choose,
  });
  const failure = await unknown.handler("feature/example", {}, unknown.h.value).then(() => new Error("did not throw"), error => error as Error);
  expect(failure.message).toContain("Could not verify whether feature/example exists on origin; its state is unknown.");
  expect(failure.message).not.toContain("does not exist");
  expect(prompted).toBe(false);
  expect(unknown.calls).toEqual([]);
});

test("new asks which remote to open when two remotes match and never picks silently", async () => {
  const inspection = remoteInspection("feature/example", [
    remoteState("origin", commitA, present(commitA)), remoteState("upstream", null, present(commitB)),
  ]);
  const prompts: Array<readonly { value: string; label: string }[]> = [];
  const g = guarded({
    inspections: [inspection],
    choose: async (_message, choices) => { prompts.push(choices); return "upstream"; },
  });
  await g.handler("feature/example", {}, g.h.value);
  expect(prompts[0]!.map(choice => choice.label)).toEqual([
    `Open existing branch origin/feature/example (${commitA.slice(0, 12)})`,
    `Open existing branch upstream/feature/example (${commitB.slice(0, 12)})`,
    "Cancel",
  ]);
  expect(g.opened.map(([input]) => input)).toEqual(["upstream/feature/example"]);
  const unattended = guarded({ inspections: [inspection] });
  const failure = await unattended.handler("feature/example", {}, unattended.h.value).then(() => new Error("did not throw"), error => error as Error);
  expect(failure.message).toContain("timber open -- 'origin/feature/example'");
  expect(failure.message).toContain("timber open -- 'upstream/feature/example'");
  expect(unattended.opened).toEqual([]);
});

test("new refuses --base with a remote or local collision without prompting", async () => {
  let prompted = false;
  const remote = guarded({
    inspections: [remoteInspection("feature/example", [remoteState("origin", commitA, present(commitA))])],
    choose: async () => { prompted = true; return "origin"; },
  });
  await expect(remote.handler("feature/example", { base: "other" }, remote.h.value)).rejects.toThrow(
    "--base other cannot be applied: branch feature/example already exists on origin.");
  const local = guarded({ inspections: [{ name: "feature/example", local: { commit: commitA, checkedOutAt: null }, remotes: [] }] });
  const failure = await local.handler("feature/example", { base: "other" }, local.h.value).then(() => new Error("did not throw"), error => error as Error);
  expect(failure.message).toContain("Branch feature/example already exists. Use timber open instead.");
  expect(failure.message).toContain("timber open -- 'feature/example'");
  expect(failure.message).toContain("--base cannot be applied to an existing branch.");
  expect(prompted).toBe(false);
  expect(remote.calls.concat(local.calls)).toEqual([]);
});

test("new revalidation refuses a changed, disappeared, unknown or newly local target and never creates", async () => {
  const first = remoteInspection("feature/example", [remoteState("origin", commitA, present(commitA))]);
  const later: Array<import("../src/git/new-collision").NewBranchInspection> = [
    remoteInspection("feature/example", [remoteState("origin", commitA, present(commitB))]),
    remoteInspection("feature/example", [remoteState("origin", commitA, { kind: "missing" })]),
    remoteInspection("feature/example", [remoteState("origin", commitA, { kind: "unknown", reason: "x" })]),
    { name: "feature/example", local: { commit: commitA, checkedOutAt: null }, remotes: [] },
  ];
  for (const second of later) {
    const g = guarded({ inspections: [first, second], choose: async () => "origin" });
    await expect(g.handler("feature/example", {}, g.h.value)).rejects.toThrow(
      "origin/feature/example changed or disappeared after selection. No worktree was created.");
    expect(g.opened).toEqual([]);
    expect(g.calls).toEqual([]);
  }
});

test("new propagates an open failure without falling back to creation", async () => {
  const calls: string[] = [];
  const handler = createNewHandler({
    ...createServiceDouble({
      discoverRepository: async () => repositoryFixture(),
      loadConfig: async () => config,
      resolveBase: async () => base,
      inspectNewBranchCollision: async (_r, name) => remoteInspection(name, [remoteState("origin", commitA, present(commitA))]),
      createWorktree: async () => { calls.push("create"); throw new Error("must not create"); },
    }),
    openExisting: async () => { throw new Error("Could not refresh remote branch origin/feature/example."); },
  });
  const h = context(async () => "origin");
  await expect(handler("feature/example", {}, h.value)).rejects.toThrow("Could not refresh remote branch");
  expect(calls).toEqual([]);
});

test("new carries a resolved ticket into open as its issue link", async () => {
  const name = "ENG-9-fix-login";
  const jira = { ...config, defaultTracker: "jira" as const, jira: { siteUrl: "https://example.atlassian.net" } };
  const g = guarded({
    inspections: [remoteInspection(name, [remoteState("origin", commitA, present(commitA))])],
    choose: async () => "origin",
    config: jira,
    services: { resolveJiraTicket: async () => ({ key: "ENG-9", title: "Fix Login", url: "https://x" }) },
  });
  await g.handler("ENG-9", { setup: false }, g.h.value);
  expect(g.opened).toEqual([[`origin/${name}`, { issue: "jira:ENG-9", setup: false }]]);
  expect(g.calls).toEqual([]);
});

test("new does not pass a GitHub ticket chosen with --remote to open and says so", async () => {
  const name = "GH-12-fix-login";
  const output: string[] = [];
  const g = guarded({
    inspections: [remoteInspection(name, [remoteState("origin", commitA, present(commitA))])],
    choose: async () => "origin",
    services: {
      resolveGithubRepository: async () => ({ owner: "acme", name: "tracker" }) as never,
      resolveGithubTicket: async () => ({ key: "GH-12", title: "Fix Login", url: "https://x" }),
    },
  });
  g.h.value.io.stdout = text => { output.push(text); };
  await g.handler("github:12", { remote: "upstream" } as never, g.h.value);
  expect(g.opened).toEqual([[`origin/${name}`, {}]]);
  expect(output.join("")).toContain("Issue github:12 was not linked");
});
