import { createServiceDouble } from "./helpers/services";
import { writeBaseAssociation } from "../src/git/base-metadata";
import { expect, test } from "bun:test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import { loadRepositoryConfig } from "../src/config";
import { resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { resolveOpenTarget } from "../src/git/open-target";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import { runSetup } from "../src/hooks";
import type { CommandContext } from "../src/services";
import { git, withRepository } from "./helpers/git";

function context(cwd: string): CommandContext {
  return { cwd, interactive: true, io: { stdout: () => {}, stderr: () => {} } };
}

function settings() {
  const ordinary = `printf 'ordinary:%s\\n' "$TIMBER_WORKFLOW" >> "$TIMBER_WORKTREE/steps.log"`;
  const review = `printf 'review:%s\\n' "$TIMBER_WORKFLOW" >> "$TIMBER_WORKTREE/steps.log"`;
  return `[hooks]\npost_create = [${JSON.stringify(ordinary)}]\n` +
    `[workflows.review]\npost_create = [${JSON.stringify(review)}]\n` +
    `[workflows.review.editor]\ncommand = "review-editor"\n` +
    `[workflows.review.agent]\ncommand = "review-agent"\nargs = ["initial prompt"]\n`;
}

test("new and repeated open apply a workflow only when it is named, with global agent defaults enabled", async () => {
  await withRepository(async (primary, directory) => {
    await mkdir(join(directory, "config", "timber"), { recursive: true });
    await writeFile(join(directory, "config", "timber", "config.toml"),
      '[agent]\ncommand = "global-agent"\nenabled = true\n');
    await writeFile(join(primary, ".timber.toml"), settings());
    const loadConfig = (repo: Awaited<ReturnType<typeof discoverRepository>>) =>
      loadRepositoryConfig(repo, { HOME: directory, XDG_CONFIG_HOME: join(directory, "config") });
    const editors: string[] = [];
    const agents: string[] = [];
    const shared = { discoverRepository, loadConfig, createWorktree, runSetup,
      launchEditor: async (_tree: unknown, config: Awaited<ReturnType<typeof loadConfig>>) => {
        editors.push(config.editor?.command ?? "off"); return { kind: "launched" as const };
      },
      launchAgent: async (_tree: unknown, command: { command: string } | null) => {
        agents.push(command?.command ?? "off"); return { kind: "exited" as const, exitCode: 0, signal: null };
      } };
    const create = createNewHandler({ ...createServiceDouble(), writeBaseAssociation, ...shared, resolveBase, resolveJiraTicket: async () => { throw new Error("unexpected Jira"); } });
    await create("review", { workflow: "review", base: "trunk" }, context(primary));
    const repository = await discoverRepository(primary);
    const tree = (await listWorktrees(repository)).find(item => item.branch === "review")!;
    expect(await readFile(join(tree.path, "steps.log"), "utf8")).toBe("ordinary:review\nreview:review\n");
    const nested = join(tree.path, "nested");
    await mkdir(nested);
    const open = createOpenHandler({ ...shared, resolveOpenTarget });
    await open("review", {}, context(nested));
    await open("review", { workflow: "review" }, context(primary));
    await writeFile(join(primary, ".timber.toml"), settings().replace('command = "review-editor"', 'command = "edited-editor"'));
    await open("review", { workflow: "review" }, context(primary));
    expect(await readFile(join(tree.path, "steps.log"), "utf8")).toBe("ordinary:review\nreview:review\n");
    // The plain open in between forgets the workflow and follows ordinary and global defaults.
    expect(editors).toEqual(["review-editor", "off", "review-editor", "edited-editor"]);
    expect(agents).toEqual(["review-agent", "global-agent"]);
    const saved = join(await git(tree.path, "rev-parse", "--absolute-git-dir"), "timber", "workflow.json");
    expect(await access(saved).then(() => true, () => false)).toBe(false);
    expect(await git(primary, "show-ref", "--verify", "refs/heads/review")).toContain("refs/heads/review");
  });
});

test("open materialization applies the workflow once and retries replay it only when it is named again", async () => {
  await withRepository(async (primary) => {
    await writeFile(join(primary, ".timber.toml"), settings());
    await git(primary, "branch", "coworkers-branch");
    const agents: string[] = [];
    const services = { discoverRepository, loadConfig: loadRepositoryConfig, resolveOpenTarget,
      createWorktree, runSetup,
      launchEditor: async () => ({ kind: "skipped" as const }),
      launchAgent: async (_tree: unknown, command: { command: string } | null) => {
        agents.push(command?.command ?? "off"); return { kind: "exited" as const, exitCode: 0, signal: null };
      } };
    const open = createOpenHandler({ ...services });
    await open("coworkers-branch", { workflow: "review" }, context(primary));
    const repository = await discoverRepository(primary);
    const tree = (await listWorktrees(repository)).find(item => item.branch === "coworkers-branch")!;
    expect(await readFile(join(tree.path, "steps.log"), "utf8")).toBe("ordinary:review\nreview:review\n");
    await open("coworkers-branch", {}, context(primary));
    expect(agents).toEqual(["review-agent"]);
    await open("coworkers-branch", { setup: true, agent: false }, context(primary));
    expect(await readFile(join(tree.path, "steps.log"), "utf8")).toBe("ordinary:review\nreview:review\nordinary:\n");
    await open("coworkers-branch", { setup: true, agent: false, workflow: "review" }, context(primary));
    expect(await readFile(join(tree.path, "steps.log"), "utf8")).toBe(
      "ordinary:review\nreview:review\nordinary:\nordinary:review\nreview:review\n");
    await open("coworkers-branch", { agent: true, workflow: "review" }, context(primary));
    expect(agents).toEqual(["review-agent", "review-agent"]);
  });
});

test("failed workflow setup retains refs and files; ordinary open never retries it", async () => {
  await withRepository(async (primary) => {
    const ordinary = `printf 'ordinary\\n' >> "$TIMBER_WORKTREE/steps.log"`;
    const workflow = `test -f "$TIMBER_WORKTREE/ready"`;
    await writeFile(join(primary, ".timber.toml"),
      `[hooks]\npost_create = [${JSON.stringify(ordinary)}]\n` +
      `[workflows.review]\npost_create = [${JSON.stringify(workflow)}]\n`);
    let editors = 0;
    const shared = { discoverRepository, loadConfig: loadRepositoryConfig, createWorktree, runSetup,
      launchEditor: async () => { editors++; return { kind: "launched" as const }; },
      launchAgent: async () => ({ kind: "skipped" as const }) };
    const create = createNewHandler({ ...createServiceDouble(), writeBaseAssociation, ...shared, resolveBase,
      resolveJiraTicket: async () => { throw new Error("unexpected Jira"); } });
    await expect(create("review", { base: "trunk", workflow: "review" }, context(primary)))
      .rejects.toThrow(/workflow post_create step 2 failed.*timber open --setup --workflow review -- '/s);
    const repository = await discoverRepository(primary);
    const tree = (await listWorktrees(repository)).find(item => item.branch === "review")!;
    expect(await readFile(join(tree.path, "steps.log"), "utf8")).toBe("ordinary\n");
    expect(editors).toBe(0);
    expect(await git(primary, "show-ref", "--verify", "refs/heads/review")).toContain("refs/heads/review");
    const open = createOpenHandler({ ...shared, resolveOpenTarget });
    await open("review", {}, context(primary));
    expect(await readFile(join(tree.path, "steps.log"), "utf8")).toBe("ordinary\n");
    await writeFile(join(tree.path, "ready"), "user content\n");
    await open("review", { setup: true }, context(primary));
    expect(await readFile(join(tree.path, "steps.log"), "utf8")).toBe("ordinary\nordinary\n");
    expect(await readFile(join(tree.path, "ready"), "utf8")).toBe("user content\n");
    expect(editors).toBe(2);
  });
});

test("workflow creation in CI skips implicit agent and explicit agent fails before Git mutation", async () => {
  await withRepository(async (primary) => {
    await writeFile(join(primary, ".timber.toml"), settings());
    let agentCalls = 0;
    const create = createNewHandler({ ...createServiceDouble(), writeBaseAssociation, discoverRepository, loadConfig: loadRepositoryConfig,
      resolveBase, createWorktree, runSetup,
      resolveJiraTicket: async () => { throw new Error("unexpected Jira"); },
      launchEditor: async () => ({ kind: "skipped" }),
      launchAgent: async () => { agentCalls++; return { kind: "skipped" }; } });
    const unattended = { ...context(primary), interactive: false };
    const refs = await git(primary, "show-ref");
    await expect(create("explicit-ci", { workflow: "review", agent: true, base: "trunk" }, unattended))
      .rejects.toThrow(/interactive/);
    expect(await git(primary, "show-ref")).toBe(refs);
    await create("implicit-ci", { workflow: "review", base: "trunk", editor: false }, unattended);
    expect(agentCalls).toBe(0);
    expect((await listWorktrees(await discoverRepository(primary))).some(tree => tree.branch === "implicit-ci")).toBe(true);
  });
});
