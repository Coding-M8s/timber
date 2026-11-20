import { createServiceDouble } from "./helpers/services";
import { readBaseAssociation, writeBaseAssociation } from "../src/git/base-metadata";
import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import { loadRepositoryConfig } from "../src/config";
import { listBranches, resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { discoverRepository } from "../src/git/repository";
import { resolveOpenTarget } from "../src/git/open-target";
import { listWorktrees } from "../src/git/worktrees";
import { createEditorTerminalLauncher } from "../src/editor-terminals/launch";
import { createTerminalRequest } from "../src/editor-terminals/request";
import type { EditorTerminalLaunch } from "../src/services";
import { withRepository, git } from "./helpers/git";

test.each([false, true])("real Git creation retains setup edits, workflow and refs after editor-terminal setup failure, dependent=%s", async dependent => {
  await withRepository(async (primary) => {
    await writeFile(join(primary, ".timber.toml"), `[editor]\ncommand = "orca-ide"\nenabled = true\nintegration = "orca"\n` +
      `[agent]\ncommand = "/bin/sh"\nargs = ["-c", "printf started > agent-started"]\nenabled = true\nwait_for_setup = ${dependent}\n` +
      '[hooks]\npost_create = ["printf ordinary > setup-edits; sleep 0.1"]\n' +
      '[workflows.review]\npost_create = ["printf workflow >> setup-edits; exit 7", "touch NEVER"]\n');
    const commands: Promise<unknown>[] = [];
    const launchEditorTerminals = createEditorTerminalLauncher({ self: { executable: process.execPath, entry: resolve("src/index.ts") },
      ready: async (_editor, tree) => ({
        create: async (_title, bootstrap) => {
          expect(tree.path).not.toBe(primary);
          expect(bootstrap).toMatch(/^\/tmp\/timber-launch-/);
          commands.push(execa("/bin/sh", ["-c", bootstrap!], { reject: false }));
          return `term_${commands.length}`;
        }, select: async () => {} }) });
    const services = { ...createServiceDouble(), discoverRepository, loadConfig: loadRepositoryConfig, resolveBase, createWorktree, writeBaseAssociation,
      resolveOpenTarget, listBranches, readBaseAssociation,
      resolveJiraTicket: async () => { throw new Error("unexpected Jira"); },
      runSetup: async () => { throw new Error("foreground fallback"); },
      launchEditor: async () => { throw new Error("generic fallback"); },
      launchAgent: async () => { throw new Error("foreground fallback"); }, launchEditorTerminals };
    const ctx = { cwd: primary, interactive: true, io: { stdout: () => {}, stderr: () => {} } };
    try {
      await expect(createNewHandler(services)("review", { base: "trunk", workflow: "review" }, ctx))
        .rejects.toThrow(/step 2.*--editor --setup --no-agent/);
      await Promise.all(commands);
      const repository = await discoverRepository(primary);
      const tree = (await listWorktrees(repository)).find(t => t.branch === "review")!;
      expect(await readFile(join(tree.path, "setup-edits"), "utf8")).toBe("ordinaryworkflow");
      expect(await Bun.file(join(tree.path, "NEVER")).exists()).toBe(false);
      expect(await Bun.file(join(tree.path, "agent-started")).exists()).toBe(!dependent);
      expect(await git(primary, "show-ref", "--verify", "refs/heads/review")).toContain("refs/heads/review");
      expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("original\n");
      let observed: EditorTerminalLaunch | undefined;
      await createOpenHandler({ ...services, launchEditorTerminals: async launch => { observed = launch; } })("review", { workflow: "review" }, ctx);
      expect(observed).toMatchObject({ setup: false, agent: null, workflowName: "review" });
      await writeFile(join(tree.path, "user-untracked"), "preserve me\n");
      await expect(createOpenHandler({ ...services, launchEditorTerminals: async () => { throw new Error("readiness failed"); } })
        ("review", { setup: true, agent: false, workflow: "review" }, ctx)).rejects.toThrow(/readiness/);
      expect(await readFile(join(tree.path, "user-untracked"), "utf8")).toBe("preserve me\n");
      expect(await readFile(join(tree.path, "setup-edits"), "utf8")).toBe("ordinaryworkflow");
      expect(await git(primary, "show-ref", "--verify", "refs/heads/review")).toContain("refs/heads/review");
    } finally { await Promise.all(commands); }
  });
});

test("claimed runner death is detected while its editor shell remains alive", async () => {
  await withRepository(async primary => {
    const request = await createTerminalRequest({ kind: "setup", cwd: primary, repositoryRoot: primary, branch: "trunk",
      hooks: ['kill -KILL "$PPID"'], workflowHooks: [] }, { executable: process.execPath, entry: resolve("src/index.ts") });
    // The shell is deliberately alive after runner death: terminal-exit-only polling would hang.
    const terminal = execa("/bin/sh", ["-c", `${request.bootstrap}; sleep 2`], { reject: false });
    let exited = false;
    void terminal.then(() => { exited = true; });
    try {
      await request.waitStarted(3000);
      await expect(request.waitSetup()).rejects.toThrow(/runner exited without completion/);
      expect(exited).toBe(false);
    } finally { terminal.kill("SIGKILL"); await terminal; await request.cleanup(); }
  });
});

test("lost create response after actual agent spawn never recreates it and still awaits setup", async () => {
  await withRepository(async primary => {
    const requests: Awaited<ReturnType<typeof createTerminalRequest>>[] = [];
    const children: Promise<unknown>[] = [];
    let creates = 0;
    const launch = createEditorTerminalLauncher({ self: { executable: process.execPath, entry: resolve("src/index.ts") },
      request: async (task, self) => { const request = await createTerminalRequest(task, self); requests.push(request); return request; },
      ready: async () => ({ create: async (title, bootstrap) => {
        creates++;
        children.push(execa("/bin/sh", ["-c", bootstrap!], { reject: false }));
        if (title === "Timber agent") {
          await requests[1]!.waitStarted(3000);
          throw new Error("lost response after actual spawn");
        }
        return "term_setup";
      }, select: async () => {} }) });
    try {
      const repository = await discoverRepository(primary);
      const tree = (await listWorktrees(repository))[0]!;
      const error = await launch({ repository, worktree: tree, setup: true,
        config: { baseBranch: null, remote: null, worktreeDir: null, agent: null,
          editor: { command: "orca-ide", args: [], enabled: true, integration: "orca" },
          hooks: { postCreate: ['sleep 0.3; printf complete > setup-complete'] } },
        agent: { command: "/bin/sh", args: ["-c", "printf 'started\\n' >> agent-starts"] } },
      { stdout: () => {}, stderr: () => {} }).catch(e => e);
      await Promise.all(children);
      expect(creates).toBe(2);
      expect(await readFile(join(primary, "setup-complete"), "utf8")).toBe("complete");
      expect(await readFile(join(primary, "agent-starts"), "utf8")).toBe("started\n");
      expect(error.message).toMatch(/uncertain.*inspect/);
      expect(error.message).not.toContain("timber open");
    } finally { await Promise.all(children); for (const request of requests) await request.cleanup(); }
  });
});

test("a completed setup failure is still reported when its terminal creation response is lost", async () => {
  await withRepository(async primary => {
    let request!: Awaited<ReturnType<typeof createTerminalRequest>>;
    let child: Promise<unknown> | undefined;
    const launch = createEditorTerminalLauncher({ self: { executable: process.execPath, entry: resolve("src/index.ts") },
      request: async (task, self) => request = await createTerminalRequest(task, self),
      ready: async () => ({ create: async (_title, bootstrap) => {
        child = execa("/bin/sh", ["-c", bootstrap!], { reject: false });
        await request.waitStarted(3000);
        await request.waitSetup();
        throw new Error("lost terminal creation response");
      }, select: async () => {} }) });
    try {
      const repository = await discoverRepository(primary);
      const tree = (await listWorktrees(repository))[0]!;
      await expect(launch({ repository, worktree: tree, setup: true, agent: null,
        config: { baseBranch: null, remote: null, worktreeDir: null, agent: null,
          editor: { command: "orca-ide", args: [], enabled: true, integration: "orca" },
          hooks: { postCreate: ["exit 7"] } } }, { stdout: () => {}, stderr: () => {} }))
        .rejects.toThrow(/step 1 failed \(exit code 7\)/);
    } finally { await child; if (request) await request.cleanup(); }
  });
});
