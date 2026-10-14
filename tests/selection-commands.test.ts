import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { placeholderHandlers, runCli } from "../src/cli";
import { createDoneHandler } from "../src/commands/done";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import { JiraLookupFailure } from "../src/jira/client";
import { createTerminalChooser } from "../src/selection";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { RepositoryConfig } from "../src/types";

for (const command of ["open", "done", "new"] as const) {
  test.each(["select", "cancel", "confirmation-cancel"] as const)(
    `${command} uses the padded shared chooser for %s without extra service calls`, async action => {
      const calls: string[] = [];
      const trees = Array.from({ length: 10 }, (_, index) => worktreeFixture({
        path: `/tree-${String(index + 1).padStart(2, "0")}`, branch: `TIM-42-${index + 1}`, isPrimary: false,
      }));
      const tickets = trees.map((_, index) => ({
        key: `TIM-42${String(index + 1).padStart(2, "0")}`, title: `Suggestion ${index + 1}`,
        url: `https://example.atlassian.net/browse/TIM-42${String(index + 1).padStart(2, "0")}`,
      }));
      const config: RepositoryConfig = {
        baseBranch: "main", remote: null, worktreeDir: null, editor: null, agent: null,
        ...(command === "new" ? { jira: { siteUrl: "https://example.atlassian.net" } } : {}),
      };
      const services = createServiceDouble({
        discoverRepository: async () => { calls.push("discover"); return repositoryFixture(); },
        loadConfig: async () => { calls.push("config"); return config; },
        resolveOpenTarget: async (_repo, input) => {
          calls.push(`resolve:${input}`);
          if (input === "TIM-42") return { kind: "ambiguous", candidates: trees.map(worktree => ({ kind: "worktree", worktree })) };
          expect(input).toBe("/tree-10");
          return { kind: "found", value: { kind: "worktree", worktree: trees[9]! } };
        },
        resolveBase: async () => {
          calls.push("base");
          return { ref: "refs/heads/main", commit: "a".repeat(40), source: "explicit" };
        },
        resolveJiraTicket: async (_config, key) => {
          calls.push(`jira:${key}`);
          if (key === "TIM-42") throw new JiraLookupFailure("Jira issue unavailable", "not-found");
          expect(key).toBe("TIM-4210");
          return tickets[9]!;
        },
        findJiraSuggestions: async () => { calls.push("suggestions"); return tickets; },
        createWorktree: async (_repo, request) => {
          expect(request.kind).toBe("new");
          if (request.kind === "new") expect(request.branch).toBe("TIM-4210-suggestion-10");
          calls.push("create");
          return trees[9]!;
        },
        launchEditor: async tree => { expect(tree).toBe(trees[9]!); calls.push("editor"); return { kind: "skipped" }; },
        cleanupWorktree: async (_repo, tree) => {
          expect(tree).toBe(trees[9]!);
          calls.push("cleanup");
          return { removedWorktreePath: tree.path, deletedLocalBranch: tree.branch, retainedLocalBranch: null };
        },
      });
      let screen = "";
      let stdout = "";
      let stderr = "";
      const input = new PassThrough();
      const output = new Writable({ write(chunk, _encoding, callback) { screen += chunk.toString(); callback(); } });
      const terminalChooser = createTerminalChooser(input, output);
      const exitCode = await runCli([command, "TIM-42"], {
        handlers: { ...placeholderHandlers,
          open: createOpenHandler(services), done: createDoneHandler(services), new: createNewHandler(services) },
        context: {
          cwd: "/repo", io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
          choose: async (message, choices) => {
            const pending = terminalChooser(message, choices);
            input.end(action === "select" ? "6\na\ny\n10\n" : action === "cancel" ? "q\n" : "a\nq\n");
            return pending;
          },
        },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(screen).toContain(" a) Show all 10 matches\n q) Cancel\n");
      const menu = screen.replace(/Choose [^\n]+: |This will display all \d+ matches\. Continue\? \[y\/N\] /gu, "\n")
        .split("\n").filter(line => /^ *(?:\d+|[aq])\) /u.test(line));
      for (const line of menu) expect(line.indexOf(") ") + 2).toBe(4);
      const initialCalls = command === "new"
        ? ["discover", "config", "base", "jira:TIM-42", "suggestions"]
        : ["discover", "config", "resolve:TIM-42"];
      if (action === "select") {
        expect(screen).toContain("Invalid choice.");
        expect(menu.some(line => line.startsWith("10) "))).toBe(true);
        expect(calls).toEqual([...initialCalls, ...(command === "new"
          ? ["jira:TIM-4210", "create", "editor"] : ["resolve:/tree-10", command === "done" ? "cleanup" : "editor"])]);
        expect(stdout).toContain(command === "done" ? "Removed worktree at /tree-10" : command === "open"
          ? "Opened existing worktree at /tree-10" : "Created TIM-4210-suggestion-10 at /tree-10");
      } else {
        expect(stdout).toBe("Cancelled.\n");
        expect(calls).toEqual(initialCalls);
      }
    },
  );
}
