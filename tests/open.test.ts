import { expect, test } from "bun:test";
import { runCli, placeholderHandlers } from "../src/cli";
import { createOpenHandler } from "../src/commands/open";
import type { CommandContext, CommandServices, OpenOptions } from "../src/services";
import type { CreateWorktreeRequest, EditorResult, OpenTarget, RepositoryConfig, RepositoryContext, Worktree } from "../src/types";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";

const config = (overrides: Partial<RepositoryConfig> = {}): RepositoryConfig => ({
  baseBranch: null, remote: null, worktreeDir: null, editor: null,
  agent: { enabled: true, command: "agent", args: ["--interactive"] },
  ...overrides,
});

async function invoke(services: CommandServices, args = ["open", "feature/one"]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    context: {
      cwd: "/repo-worktrees/current/nested",
      io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
    },
    handlers: { ...placeholderHandlers, open: createOpenHandler(services) },
  });
  return { exitCode, stdout, stderr };
}

test("opening a registered worktree reuses it and passes repository/config identity in service order", async () => {
  const order: string[] = [];
  const repository = repositoryFixture({ currentWorktreeRoot: "/repo-worktrees/current" });
  const loaded = config({ editor: { command: "editor", args: ["--wait"] } });
  const tree = worktreeFixture({ path: "/repo-worktrees/feature", branch: "feature/one", isPrimary: false });
  const services = createServiceDouble({
    discoverRepository: async cwd => {
      order.push("discover");
      expect(cwd).toBe("/repo-worktrees/current/nested");
      return repository;
    },
    loadConfig: async actual => {
      order.push("config");
      expect(actual).toBe(repository);
      return loaded;
    },
    resolveOpenTarget: async (actual, input, actualConfig) => {
      order.push("resolve");
      expect(actual).toBe(repository);
      expect(input).toBe("feature/one");
      expect(actualConfig).toBe(loaded);
      return { kind: "found", value: { kind: "worktree", worktree: tree } };
    },
    createWorktree: async () => { order.push("create"); throw new Error("reuse must not create"); },
    launchEditor: async (actualTree, actualConfig, disabled) => {
      order.push("editor");
      expect(actualTree).toBe(tree);
      expect(actualConfig).toBe(loaded);
      expect(disabled).toBe(false);
      return { kind: "launched" };
    },
  });
  const result = await invoke(services);
  expect(order).toEqual(["discover", "config", "resolve", "editor"]);
  expect(result).toEqual({ exitCode: 0, stdout: "Opened existing worktree at /repo-worktrees/feature\n", stderr: "" });
});

test("primary, detached, locked, and dirty worktrees can be opened without creation", async () => {
  const cases: Worktree[] = [
    worktreeFixture(),
    worktreeFixture({ path: "/manual detached", branch: null, isPrimary: false }),
    worktreeFixture({ path: "/locked", isPrimary: false, locked: { reason: "operator lock" } }),
    worktreeFixture({ path: "/dirty", branch: "feature/one", isPrimary: false,
      status: { kind: "known", modified: ["tracked"], untracked: ["new"], ignored: [".env"] } }),
  ];
  for (const tree of cases) {
    let created = false;
    const result = await invoke(createServiceDouble({
      discoverRepository: async () => repositoryFixture(),
      loadConfig: async () => config(),
      resolveOpenTarget: async () => ({ kind: "found", value: { kind: "worktree", worktree: tree } }),
      createWorktree: async () => { created = true; throw new Error("unexpected creation"); },
      launchEditor: async actual => { expect(actual).toBe(tree); return { kind: "skipped" }; },
    }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`Opened existing worktree at ${tree.path}\n`);
    expect(result.stderr).toBe("");
    expect(created).toBe(false);
  }
});

test.each([
  ["local", { kind: "local", name: "feature/one", ref: "refs/heads/feature/one", upstream: null },
    { kind: "local", branch: { kind: "local", name: "feature/one", ref: "refs/heads/feature/one", upstream: null } }],
  ["remote", { kind: "remote", remote: "upstream", name: "feature/one", ref: "refs/remotes/upstream/feature/one" },
    { kind: "remote", branch: { kind: "remote", remote: "upstream", name: "feature/one", ref: "refs/remotes/upstream/feature/one" } }],
] as const)("materializing a %s branch passes the exact create request", async (_name, branch, expected) => {
  const repository = repositoryFixture();
  const loaded = config();
  const tree = worktreeFixture({ path: "/repo-worktrees/feature-one", branch: "feature/one", isPrimary: false });
  let actualRequest: CreateWorktreeRequest | undefined;
  const result = await invoke(createServiceDouble({
    discoverRepository: async () => repository,
    loadConfig: async actual => { expect(actual).toBe(repository); return loaded; },
    resolveOpenTarget: async (actual, _input, actualConfig) => {
      expect(actual).toBe(repository);
      expect(actualConfig).toBe(loaded);
      return { kind: "found", value: { kind: "branch", branch } as OpenTarget };
    },
    createWorktree: async (actual, request, actualConfig) => {
      expect(actual).toBe(repository);
      expect(actualConfig).toBe(loaded);
      actualRequest = request;
      return tree;
    },
    launchEditor: async (actual, actualConfig) => {
      expect(actual).toBe(tree);
      expect(actualConfig).toBe(loaded);
      return { kind: "skipped" };
    },
  }));
  expect(actualRequest).toEqual(expected);
  expect(result).toEqual({ exitCode: 0, stdout: "Created worktree at /repo-worktrees/feature-one\n", stderr: "" });
});

test("blank input rejects before repository services while preserving literal nonblank input", async () => {
  const services = createServiceDouble();
  expect(await invoke(services, ["open", " \t "])).toEqual({
    exitCode: 1, stdout: "", stderr: "error: Provide an existing branch or worktree path to open.\n",
  });

  let received = "";
  const result = await invoke(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => config(),
    resolveOpenTarget: async (_repository, input) => { received = input; return { kind: "not-found" }; },
  }), ["open", " feature/one "]);
  expect(received).toBe(" feature/one ");
  expect(result.exitCode).toBe(1);
});

test("not-found targets explain that open only accepts an existing branch or worktree", async () => {
  expect(await invoke(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => config(),
    resolveOpenTarget: async () => ({ kind: "not-found" }),
  }))).toEqual({
    exitCode: 1, stdout: "", stderr: "error: No existing branch or worktree matches \"feature/one\". Check the exact branch or absolute worktree path.\n",
  });
});

test("ambiguous targets print every exact selector in stable order and do not create or launch", async () => {
  const paths = ["/z tree", "/a tree"];
  const branches = [
    { kind: "remote" as const, remote: "origin", name: "ABU-4-two", ref: "refs/remotes/origin/ABU-4-two" },
    { kind: "local" as const, name: "ABU-4-one", ref: "refs/heads/ABU-4-one", upstream: null },
  ];
  const targets: OpenTarget[] = [
    { kind: "branch", branch: branches[0]! }, { kind: "worktree", worktree: worktreeFixture({ path: paths[0]!, isPrimary: false }) },
    { kind: "branch", branch: branches[1]! }, { kind: "worktree", worktree: worktreeFixture({ path: paths[1]!, isPrimary: false }) },
  ];
  let sideEffects = 0;
  const result = await invoke(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => config(),
    resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: targets }),
    createWorktree: async () => { sideEffects++; throw new Error("must not create"); },
    launchEditor: async () => { sideEffects++; return { kind: "launched" }; },
  }));
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("error: Input \"feature/one\" matches multiple targets. Choose an exact branch or worktree path:\n" +
    "  /a tree\n  /z tree\n  ABU-4-one\n  origin/ABU-4-two\n");
  expect(sideEffects).toBe(0);
});

test("ambiguous branch identities stay distinct when a local name is shadowed by a remote prefix", async () => {
  const repository = repositoryFixture({ remotes: [{ name: "TIM-42", defaultBranchRef: null }] });
  const local = { kind: "local" as const, name: "TIM-42/TIM-42-one", ref: "refs/heads/TIM-42/TIM-42-one", upstream: null };
  const remote = { kind: "remote" as const, remote: "TIM-42", name: "TIM-42-one", ref: "refs/remotes/TIM-42/TIM-42-one" };
  let sideEffects = 0;
  const result = await invoke(createServiceDouble({
    discoverRepository: async () => repository,
    loadConfig: async () => config({ remote: "TIM-42" }),
    resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: [
      { kind: "branch", branch: remote }, { kind: "branch", branch: local },
    ] }),
    createWorktree: async () => { sideEffects++; throw new Error("must not create"); },
    launchEditor: async () => { sideEffects++; return { kind: "launched" }; },
  }), ["open", "TIM-42"]);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Local branch TIM-42/TIM-42-one");
  expect(result.stderr).toContain("refs/heads/TIM-42/TIM-42-one");
  expect(result.stderr).toContain("Remote branch TIM-42/TIM-42-one");
  expect(result.stderr).toContain("refs/remotes/TIM-42/TIM-42-one");
  expect(result.stderr).toContain("shadowed by known remote prefix TIM-42");
  expect(result.stderr).toContain("create a Git worktree");
  expect(result.stderr).toContain("absolute-worktree-path");
  expect(result.stderr).toContain("Exact selector: TIM-42/TIM-42-one");
  expect(sideEffects).toBe(0);
});

test("a shadowed local branch is explained even when its shortened name has no collision", async () => {
  const repository = repositoryFixture({ remotes: [{ name: "TIM-42", defaultBranchRef: null }] });
  const local = { kind: "local" as const, name: "TIM-42/TIM-42-one", ref: "refs/heads/TIM-42/TIM-42-one", upstream: null };
  const other = { kind: "local" as const, name: "TIM-42-two", ref: "refs/heads/TIM-42-two", upstream: null };
  const result = await invoke(createServiceDouble({
    discoverRepository: async () => repository,
    loadConfig: async () => config({ remote: "TIM-42" }),
    resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: [
      { kind: "branch", branch: local }, { kind: "branch", branch: other },
    ] }),
  }), ["open", "TIM-42"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("TIM-42/TIM-42-one");
  expect(result.stderr).toContain("shadowed by known remote prefix TIM-42");
  expect(result.stderr).toContain("Local branch TIM-42/TIM-42-one");
  expect(result.stderr).toContain("TIM-42-two");
});

test("not-found inputs and service diagnostics escape terminal controls", async () => {
  const unsafeInput = "missing-\u001b[2J\nROW\u007f\u0085\u009b\u2028\u2029";
  const notFound = await invoke(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => config(),
    resolveOpenTarget: async () => ({ kind: "not-found" }),
  }), ["open", unsafeInput]);
  expect(notFound.exitCode).toBe(1);
  expect(notFound.stderr).toContain("missing-\\u001b[2J\\nROW\\u007f\\u0085\\u009b\\u2028\\u2029");
  expect(notFound.stderr.slice(0, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);

  const unsafeMessage = "service-\u001b[2J\nROW\u007f\u0085\u009b\u2028\u2029";
  for (const service of ["discoverRepository", "loadConfig", "resolveOpenTarget", "createWorktree", "launchEditor"] as const) {
    const overrides: Partial<CommandServices> = {
      discoverRepository: async () => repositoryFixture(),
      loadConfig: async () => config(),
      resolveOpenTarget: async () => ({ kind: "found", value: service === "createWorktree"
        ? { kind: "branch", branch: { kind: "local", name: "feature/one", ref: "refs/heads/feature/one", upstream: null } }
        : { kind: "worktree", worktree: worktreeFixture() } }),
      createWorktree: async () => worktreeFixture({ path: "/new", isPrimary: false }),
      launchEditor: async () => ({ kind: "skipped" }),
      [service]: async () => { throw new Error(unsafeMessage); },
    };
    const result = await invoke(createServiceDouble(overrides));
    if (result.exitCode !== 1) throw new Error(`${service} returned ${JSON.stringify(result)}`);
    expect(result.stderr).toContain("service-\\u001b[2J\\nROW\\u007f\\u0085\\u009b\\u2028\\u2029");
    expect(result.stderr.slice(0, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
  }
});

test("editor failure message and retry text are escaped for display", async () => {
  const unsafePath = "/repo/linked-\u001b[2J\nROW\u007f\u009b\u2028\u2029";
  const retryCommand = `timber open -- '${unsafePath}'`;
  const message = `Could not start editor for ${unsafePath}. Retry with: ${retryCommand}`;
  const result = await invoke(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => config(),
    resolveOpenTarget: async () => ({ kind: "found", value: { kind: "worktree", worktree: worktreeFixture({ path: unsafePath, isPrimary: false }) } }),
    launchEditor: async () => ({ kind: "failed", message, retryCommand }),
  }));

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('"/repo/linked-\\u001b[2J\\nROW\\u007f\\u009b\\u2028\\u2029"');
  expect(result.stderr).toContain("Could not start editor for /repo/linked-\\u001b[2J\\nROW\\u007f\\u009b\\u2028\\u2029");
  expect(result.stderr).toContain("Bash retry command: timber open -- $'/repo/linked-\\033[2J\\nROW\\177\\302\\233\\342\\200\\250\\342\\200\\251'");
  expect(result.stdout.slice(0, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
  expect(result.stderr.slice(0, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
});

test.each(["discoverRepository", "loadConfig", "resolveOpenTarget", "createWorktree"] as const)(
  "%s failures appear once on stderr and prevent editor startup", async service => {
    const failure = new Error(`failed ${service}`);
    const overrides: Partial<CommandServices> = {
      discoverRepository: async () => repositoryFixture(),
      loadConfig: async () => config(),
      resolveOpenTarget: async () => ({ kind: "found", value: { kind: "branch", branch: { kind: "local", name: "feature/one", ref: "refs/heads/feature/one", upstream: null } } }),
      createWorktree: async () => worktreeFixture({ path: "/new", isPrimary: false }),
      launchEditor: async () => { throw new Error("editor should not run"); },
      [service]: async () => { throw failure; },
    };
    const result = await invoke(createServiceDouble(overrides));
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: `error: failed ${service}\n` });
  },
);

test.each([
  ["default", undefined, false],
  ["explicit --no-editor", { editor: false }, true],
] as const)("editor disabled state follows %s and agent config is retained", async (_name, options, disabled) => {
  const repository: RepositoryContext = repositoryFixture();
  const loaded = config({ editor: { command: "editor", args: ["--wait"] } });
  const tree = worktreeFixture({ path: "/reused", isPrimary: false });
  let receivedDisabled: boolean | undefined;
  let receivedConfig: RepositoryConfig | undefined;
  const handler = createOpenHandler(createServiceDouble({
    discoverRepository: async () => repository,
    loadConfig: async () => loaded,
    resolveOpenTarget: async () => ({ kind: "found", value: { kind: "worktree", worktree: tree } }),
    launchEditor: async (_tree, actualConfig, actualDisabled) => {
      receivedDisabled = actualDisabled;
      receivedConfig = actualConfig;
      return { kind: "skipped" };
    },
  }));
  const context: CommandContext = { cwd: "/repo", io: { stdout: () => {}, stderr: () => {} } };
  await handler("feature/one", options as OpenOptions ?? {}, context);
  expect(receivedDisabled).toBe(disabled);
  expect(receivedConfig?.agent).toEqual({ enabled: true, command: "agent", args: ["--interactive"] });
});

test.each([
  [{ kind: "skipped" }, ""],
  [{ kind: "launched" }, ""],
] as const)("successful editor outcomes retain successful open output", async (editorResult: EditorResult, _unused) => {
  const tree = worktreeFixture({ path: "/reused", isPrimary: false });
  const result = await invoke(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => config(),
    resolveOpenTarget: async () => ({ kind: "found", value: { kind: "worktree", worktree: tree } }),
    launchEditor: async () => editorResult,
  }));
  expect(result).toEqual({ exitCode: 0, stdout: "Opened existing worktree at /reused\n", stderr: "" });
});

test("editor startup failure reports retry once, retains path output, and returns success", async () => {
  const tree = worktreeFixture({ path: "/repo/worktrees/linked tree", isPrimary: false });
  const message = "Could not start editor. Retry with: timber open -- '/repo/worktrees/linked tree'";
  const result = await invoke(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => config(),
    resolveOpenTarget: async () => ({ kind: "found", value: { kind: "worktree", worktree: tree } }),
    launchEditor: async () => ({ kind: "failed", message, retryCommand: "timber open -- '/repo/worktrees/linked tree'" }),
  }));
  expect(result).toEqual({ exitCode: 0, stdout: "Opened existing worktree at /repo/worktrees/linked tree\n", stderr: `error: ${message}\n` });
  expect(result.stderr.match(/timber open/g)).toHaveLength(1);
});
