import { createServiceDouble } from "./helpers/services";
import { readBaseAssociation, writeBaseAssociation } from "../src/git/base-metadata";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { createNewHandler } from "../src/commands/new";
import { loadRepositoryConfig } from "../src/config";
import { listBranches, resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { discoverRepository } from "../src/git/repository";
import { resolveOpenTarget } from "../src/git/open-target";
import { listWorktrees } from "../src/git/worktrees";
import { createEditorTerminalLauncher } from "../src/editor-terminals/launch";
import { createVscodeSession } from "../src/editor-terminals/vscode";
import { createBridge } from "../vscode-extension/src/bridge";
import { withRepository, git } from "./helpers/git";

test.each([false, true])("real VS Code bridge runs setup and agent terminals with literal argv and retains work on setup failure, dependent=%s", async dependent => {
  await withRepository(async primary => {
    await writeFile(join(primary, ".timber.toml"), `[editor]\ncommand = "code"\nargs = ["--new-window"]\nenabled = true\nintegration = "vscode"\n` +
      `[agent]\ncommand = "/bin/sh"\nargs = ["-c", "printf started > agent-started"]\nenabled = true\nwait_for_setup = ${dependent}\n` +
      '[hooks]\npost_create = ["printf ordinary > setup-edits; sleep 0.1"]\n' +
      '[workflows.review]\npost_create = ["printf workflow >> setup-edits; exit 7", "touch NEVER"]\n');
    const spool = await mkdtemp("/tmp/timber-vscode-integration-");
    const folders: string[] = [];
    const terminals: { shellPath: string; shellArgs: string[] }[] = [];
    const children: Promise<unknown>[] = [];
    const bridge = createBridge({ spool, uid: process.getuid!(), windowId: "0123456789abcdef", extensionVersion: "0.1.0",
      vscodeVersion: "1.146.0", isLocal: () => true, folders: () => folders,
      createTerminal: async ({ cwd, shellPath, shellArgs }) => {
        terminals.push({ shellPath, shellArgs });
        // No shell: the editor starts the runner from literal argv.
        const child = execa(shellPath, shellArgs, { cwd, reject: false, stdin: "ignore" });
        children.push(child);
        return { processId: child.pid };
      } });
    let watching = true;
    const watcher = (async () => { while (watching) { await bridge.scanPending(); await Bun.sleep(10); } })();
    const launchEditorTerminals = createEditorTerminalLauncher({ self: { executable: process.execPath, entry: resolve("src/index.ts") },
      ready: (editor, tree) => createVscodeSession(editor, tree, { spool, pollMs: 10,
        run: async () => ({ exitCode: 0, stdout: "coding-m8s.timber-terminals@0.1.0\n" }),
        open: async path => { expect(path).not.toBe(primary); folders.push(path); } }) });
    const services = { ...createServiceDouble(), discoverRepository, loadConfig: loadRepositoryConfig, resolveBase, createWorktree, writeBaseAssociation,
      resolveOpenTarget, listBranches, readBaseAssociation,
      resolveJiraTicket: async () => { throw new Error("unexpected Jira"); }, findJiraSuggestions: async () => [],
      runSetup: async () => { throw new Error("foreground fallback"); },
      launchEditor: async () => { throw new Error("generic fallback"); },
      launchAgent: async () => { throw new Error("foreground fallback"); }, launchEditorTerminals };
    const ctx = { cwd: primary, interactive: true, io: { stdout: () => {}, stderr: () => {} } };
    try {
      await expect(createNewHandler(services)("review", { base: "trunk", workflow: "review" }, ctx))
        .rejects.toThrow(/step 2.*--editor --setup --no-agent/);
      await Promise.all(children);
      const repository = await discoverRepository(primary);
      const tree = (await listWorktrees(repository)).find(t => t.branch === "review")!;
      expect(folders).toEqual([tree.path]);
      expect(terminals).toHaveLength(dependent ? 1 : 2);
      for (const { shellPath, shellArgs } of terminals) {
        const directory = shellPath.slice(0, -"/runtime".length);
        expect(directory).toMatch(/^\/tmp\/timber-launch-[a-zA-Z0-9]+$/);
        expect(shellArgs).toEqual(["--no-env-file", `${directory}/entry.ts`, "__editor-task", directory]);
      }
      expect(await readFile(join(tree.path, "setup-edits"), "utf8")).toBe("ordinaryworkflow");
      expect(await Bun.file(join(tree.path, "NEVER")).exists()).toBe(false);
      expect(await Bun.file(join(tree.path, "agent-started")).exists()).toBe(!dependent);
      expect(await git(primary, "show-ref", "--verify", "refs/heads/review")).toContain("refs/heads/review");
      expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("original\n");
      expect(await readdir(spool)).toEqual([]);
    } finally {
      watching = false;
      await watcher;
      await Promise.all(children);
      await rm(spool, { recursive: true, force: true });
    }
  });
});
