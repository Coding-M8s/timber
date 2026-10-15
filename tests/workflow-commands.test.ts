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

test("new saves association before setup, then opens workflow editor and initial agent", async () => {
  const events: string[] = [];
  const services = createServiceDouble({
    discoverRepository: async () => repository, loadConfig: async () => config,
    resolveBase: async () => ({ ref: "refs/heads/main", commit: "a".repeat(40), source: "config" }),
    createWorktree: async () => { events.push("create"); return tree; },
    writeWorkflowAssociation: async (_repo, _tree, name) => { events.push(`save:${name}`); },
    runSetup: async (_repo, _tree, effective, _io, workflowName, workflowScripts) => {
      events.push(`setup:${effective.hooks?.postCreate.join(",")}:${workflowName}:${workflowScripts?.join(",")}`);
    },
    launchEditor: async (_tree, effective) => { events.push(`editor:${effective.editor?.command}`); return { kind: "launched" }; },
    launchAgent: async (_tree, command) => { events.push(`agent:${command?.command}`); return { kind: "exited", exitCode: 0, signal: null }; },
  });
  await createNewHandler(services)("review", { workflow: "review" }, context);
  expect(events).toEqual(["create", "save:review", "setup:ordinary-step:review:review-step", "editor:review-editor", "agent:review-agent"]);
});

test("materializing open runs creation actions once; later opens retain editor only", async () => {
  const events: string[] = [];
  let created = false;
  let saved: string | null = null;
  const services = createServiceDouble({
    discoverRepository: async () => repository, loadConfig: async () => config,
    resolveOpenTarget: async () => created
      ? { kind: "found", value: { kind: "worktree", worktree: tree } }
      : { kind: "found", value: { kind: "branch", branch: { kind: "local", name: "review", ref: "refs/heads/review", upstream: null } } },
    createWorktree: async () => { created = true; events.push("create"); return tree; },
    readWorkflowAssociation: async () => saved ? { kind: "assigned", name: saved } : { kind: "unassigned" },
    writeWorkflowAssociation: async (_repo, _tree, name) => { saved = name; events.push(`save:${name}`); },
    runSetup: async () => { events.push("setup"); },
    launchEditor: async (_tree, effective) => { events.push(`editor:${effective.editor?.command}`); return { kind: "launched" }; },
    launchAgent: async (_tree, command) => { events.push(`agent:${command?.command}`); return { kind: "exited", exitCode: 0, signal: null }; },
  });
  const open = createOpenHandler(services);
  await open("review", { workflow: "review" }, context);
  await open("review", {}, context);
  await open("review", { workflow: "review" }, context);
  expect(events).toEqual(["create", "save:review", "setup", "editor:review-editor", "agent:review-agent",
    "editor:review-editor", "editor:review-editor"]);
});

test("unknown workflow fails before creation", async () => {
  const services = createServiceDouble({ discoverRepository: async () => repository, loadConfig: async () => config,
    resolveBase: async () => ({ ref: "refs/heads/main", commit: "a".repeat(40), source: "config" }) });
  await expect(createNewHandler(services)("review", { workflow: "absent" }, context)).rejects.toThrow(/Unknown workflow/);
});

test("existing worktree reassignment changes its editor without replaying setup or agent", async () => {
  const events: string[] = [];
  let name = "review";
  const configured: RepositoryConfig = { ...config, workflows: { ...config.workflows,
    develop: { postCreate: ["develop-step"], editor: { command: "develop-editor", args: [] } } } };
  const services = createServiceDouble({ discoverRepository: async () => repository,
    loadConfig: async () => configured,
    resolveOpenTarget: async () => ({ kind: "found", value: { kind: "worktree", worktree: tree } }),
    readWorkflowAssociation: async () => ({ kind: "assigned", name }),
    writeWorkflowAssociation: async (_repo, _tree, selected) => { name = selected; events.push(`save:${selected}`); },
    launchEditor: async (_tree, effective) => { events.push(`editor:${effective.editor?.command}`); return { kind: "launched" }; },
  });
  const open = createOpenHandler(services);
  await open("review", { workflow: "develop" }, context);
  await open("review", {}, context);
  expect(events).toEqual(["save:develop", "editor:develop-editor", "editor:develop-editor"]);
});

test("missing saved definition fails closed until a valid workflow is assigned", async () => {
  const events: string[] = [];
  const services = createServiceDouble({ discoverRepository: async () => repository,
    loadConfig: async () => config,
    resolveOpenTarget: async () => ({ kind: "found", value: { kind: "worktree", worktree: tree } }),
    readWorkflowAssociation: async () => ({ kind: "assigned", name: "deleted" }),
    writeWorkflowAssociation: async (_repo, _tree, name) => { events.push(`save:${name}`); },
    launchEditor: async () => { events.push("editor"); return { kind: "launched" }; },
  });
  const open = createOpenHandler(services);
  await expect(open("review", {}, context)).rejects.toThrow(/Unknown workflow/);
  expect(events).toEqual([]);
  await open("review", { workflow: "review" }, context);
  expect(events).toEqual(["save:review", "editor"]);
});

test("editor and agent failures retain the workflow and do not replay on ordinary reopen", async () => {
  for (const failure of ["editor", "agent"] as const) {
    const events: string[] = [];
    let created = false;
    let saved: string | null = null;
    const services = createServiceDouble({ discoverRepository: async () => repository, loadConfig: async () => config,
      resolveOpenTarget: async () => created
        ? { kind: "found", value: { kind: "worktree", worktree: tree } }
        : { kind: "found", value: { kind: "branch", branch: { kind: "local", name: "review", ref: "refs/heads/review", upstream: null } } },
      createWorktree: async () => { created = true; return tree; },
      readWorkflowAssociation: async () => saved ? { kind: "assigned", name: saved } : { kind: "unassigned" },
      writeWorkflowAssociation: async (_repo, _tree, name) => { saved = name; events.push("save"); },
      runSetup: async () => { events.push("setup"); },
      launchEditor: async () => { events.push("editor"); return failure === "editor" && events.filter(e => e === "editor").length === 1
        ? { kind: "failed", message: "editor failed", retryCommand: "timber open -- '/repo-worktrees/review'" }
        : { kind: "launched" }; },
      launchAgent: async () => { events.push("agent"); return failure === "agent"
        ? { kind: "failed", message: "agent failed", retryCommand: "timber open --agent --no-editor -- '/repo-worktrees/review'" }
        : { kind: "exited", exitCode: 0, signal: null }; },
    });
    const open = createOpenHandler(services);
    await open("review", { workflow: "review" }, context);
    await open("review", {}, context);
    expect(events).toEqual(failure === "editor"
      ? ["save", "setup", "editor", "editor"]
      : ["save", "setup", "editor", "agent", "editor"]);
  }
});
