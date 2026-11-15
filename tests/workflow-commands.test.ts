import { expect, test } from "bun:test";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import type { CommandContext } from "../src/services";
import type { RepositoryConfig } from "../src/types";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";

const repository = repositoryFixture();
const tree = worktreeFixture({ path: "/repo-worktrees/review", branch: "review", isPrimary: false });
const config: RepositoryConfig = {
  baseBranch: "main", remote: null, worktreeDir: null,
  editor: { command: "ordinary-editor", args: [], enabled: false },
  agent: { command: "ordinary-agent", args: [], enabled: true },
  hooks: { postCreate: ["ordinary-step"] },
  workflows: { review: { postCreate: ["review-step"], editor: { command: "review-editor", args: [] },
    agent: { command: "review-agent", args: ["review-prompt"] } } },
};
const context: CommandContext = { cwd: "/repo", interactive: true, io: { stdout: () => {}, stderr: () => {} } };

const launchers = (events: string[]) => ({
  launchEditor: async (_tree: unknown, effective: RepositoryConfig) => {
    events.push(`editor:${effective.editor?.command}`); return { kind: "launched" as const };
  },
  launchAgent: async (_tree: unknown, command: { command: string } | null) => {
    events.push(`agent:${command?.command}`); return { kind: "exited" as const, exitCode: 0, signal: null };
  },
});
const existing = async () => ({ kind: "found" as const, value: { kind: "worktree" as const, worktree: tree } });
const branch = { kind: "found" as const, value: { kind: "branch" as const,
  branch: { kind: "local" as const, name: "review", ref: "refs/heads/review", upstream: null } } };

test("new runs workflow setup, then opens workflow editor and initial agent, saving nothing", async () => {
  const events: string[] = [];
  const services = createServiceDouble({
    discoverRepository: async () => repository, loadConfig: async () => config,
    resolveBase: async () => ({ ref: "refs/heads/main", commit: "a".repeat(40), source: "config" }),
    createWorktree: async () => { events.push("create"); return tree; },
    writeBaseAssociation: async () => { events.push("save-base"); },
    runSetup: async (_repo, _tree, effective, _io, workflowName, workflowScripts) => {
      events.push(`setup:${effective.hooks?.postCreate.join(",")}:${workflowName}:${workflowScripts?.join(",")}`);
    },
    ...launchers(events),
  });
  await createNewHandler(services)("review", { workflow: "review" }, context);
  expect(events).toEqual(["create", "save-base", "setup:ordinary-step:review:review-step", "editor:review-editor", "agent:review-agent"]);
});

test("a workflow applies to one open; later opens use ordinary settings unless it is named again", async () => {
  const events: string[] = [];
  let created = false;
  const services = createServiceDouble({
    discoverRepository: async () => repository, loadConfig: async () => config,
    resolveOpenTarget: async () => created ? existing() : branch,
    createWorktree: async () => { created = true; events.push("create"); return tree; },
    runSetup: async (_repo, _tree, _config, _io, workflowName) => { events.push(`setup:${workflowName}`); },
    ...launchers(events),
  });
  const open = createOpenHandler(services);
  await open("review", { workflow: "review" }, context);
  expect(events.splice(0)).toEqual(["create", "setup:review", "editor:review-editor", "agent:review-agent"]);
  await open("review", {}, context);
  expect(events.splice(0)).toEqual(["editor:ordinary-editor", "agent:ordinary-agent"]);
  await open("review", { setup: true }, context);
  expect(events.splice(0)).toEqual(["setup:undefined", "editor:ordinary-editor", "agent:ordinary-agent"]);
  await open("review", { workflow: "review" }, context);
  expect(events.splice(0)).toEqual(["editor:review-editor"]);
  await open("review", { workflow: "review", setup: true, agent: true }, context);
  expect(events.splice(0)).toEqual(["setup:review", "editor:review-editor", "agent:review-agent"]);
});

test("unknown workflow fails before creation", async () => {
  const services = createServiceDouble({ discoverRepository: async () => repository, loadConfig: async () => config,
    resolveBase: async () => ({ ref: "refs/heads/main", commit: "a".repeat(40), source: "config" }) });
  await expect(createNewHandler(services)("review", { workflow: "absent" }, context)).rejects.toThrow(/Unknown workflow/);
});

test("unknown workflow on an existing worktree fails before any launch", async () => {
  const events: string[] = [];
  const services = createServiceDouble({ discoverRepository: async () => repository,
    loadConfig: async () => config, resolveOpenTarget: existing, ...launchers(events) });
  await expect(createOpenHandler(services)("review", { workflow: "deleted" }, context)).rejects.toThrow(/Unknown workflow/);
  expect(events).toEqual([]);
});

test("editor and agent failures do not replay workflow setup on ordinary reopen", async () => {
  for (const failure of ["editor", "agent"] as const) {
    const events: string[] = [];
    let created = false;
    const services = createServiceDouble({ discoverRepository: async () => repository, loadConfig: async () => config,
      resolveOpenTarget: async () => created ? existing() : branch,
      createWorktree: async () => { created = true; return tree; },
      runSetup: async () => { events.push("setup"); },
      launchEditor: async () => { events.push("editor"); return failure === "editor" && events.filter(e => e === "editor").length === 1
        ? { kind: "failed", message: "editor failed", retryCommand: "timber open -- '/repo-worktrees/review'" }
        : { kind: "launched" }; },
      launchAgent: async () => { events.push("agent"); return failure === "agent" && events.filter(e => e === "agent").length === 1
        ? { kind: "failed", message: "agent failed", retryCommand: "timber open --agent --no-editor -- '/repo-worktrees/review'" }
        : { kind: "exited", exitCode: 0, signal: null }; },
    });
    const open = createOpenHandler(services);
    await open("review", { workflow: "review" }, context);
    await open("review", { agent: false }, context);
    expect(events).toEqual(failure === "editor"
      ? ["setup", "editor", "editor"]
      : ["setup", "editor", "agent", "editor"]);
  }
});

test("launch failure retries name the workflow again because it is not remembered", async () => {
  const path = "/repo-worktrees/review";
  let stderr = "";
  const services = createServiceDouble({ discoverRepository: async () => repository, loadConfig: async () => config,
    resolveOpenTarget: existing,
    launchEditor: async () => ({ kind: "failed", message: `editor failed; retry with: timber open --editor -- '${path}'`,
      retryCommand: `timber open --editor -- '${path}'` }),
    launchAgent: async () => ({ kind: "failed", message: "agent failed", retryCommand: `timber open --agent --no-editor -- '${path}'` }),
  });
  const io = { stdout: () => {}, stderr: (text: string) => { stderr += text; } };
  await createOpenHandler(services)("review", { workflow: "review" }, { ...context, io });
  expect(stderr).toBe(`error: editor failed; retry with: timber open --editor --workflow review -- '${path}'\n`);
  stderr = "";
  const working = { ...services, launchEditor: async () => ({ kind: "launched" as const }) };
  expect(await createOpenHandler(working)("review", { workflow: "review", agent: true }, { ...context, io })).toBe(1);
  expect(stderr).toBe(`error: agent failed Retry with: timber open --agent --no-editor --workflow review -- '${path}'\n`);
  stderr = "";
  expect(await createOpenHandler(working)("review", {}, { ...context, io })).toBe(1);
  expect(stderr).toBe(`error: agent failed Retry with: timber open --agent --no-editor -- '${path}'\n`);
});
