import { expect, test } from "bun:test";
import { createNewHandler } from "../src/commands/new";
import { createCli } from "../src/cli";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { NewOptions } from "../src/services";

const config = { baseBranch: "main", remote: null, worktreeDir: null, editor: null, agent: null };
const base = { ref: "refs/heads/main", commit: "a".repeat(40), source: "explicit" as const };
const io = { stdout() {}, stderr() {} };

test("GitHub new keeps selected issue repository independent of base and uses ordinary creation", async () => {
  const calls: string[] = [];
  let output = "";
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(), loadConfig: async () => config,
    resolveBase: async (_repository, _config, explicit) => { expect(explicit).toBe("main"); calls.push("base"); return base; },
    resolveGithubRepository: async (_repository, _config, remote) => { expect(remote).toBe("upstream"); calls.push("repository"); return { owner: "team", name: "project" }; },
    resolveGithubTicket: async (repo, number, allowClosed) => {
      expect([repo, number, allowClosed]).toEqual([{ owner: "team", name: "project" }, 123, true]);
      calls.push("lookup"); return { key: "GH-123", title: "Fix cafe login", url: "https://github.com/team/project/issues/123" };
    },
    createWorktree: async (_repo, request) => { expect(request).toEqual({ kind: "new", branch: "GH-123-fix-cafe-login", base }); calls.push("create"); return worktreeFixture(); },
    writeBaseAssociation: async () => { calls.push("metadata"); },
    launchEditor: async () => { calls.push("editor"); return { kind: "skipped" }; },
  }));
  await handler("github:123", { base: "main", remote: "upstream", allowClosed: true }, { cwd: "/repo", io: { ...io, stdout: text => { output += text; } } });
  expect(calls).toEqual(["base", "repository", "lookup", "create", "metadata", "editor"]);
  expect(output).toContain("GitHub: https://github.com/team/project/issues/123");
});

test("issue-only flags refuse literal routing and malformed selectors refuse before lookup", async () => {
  const handler = createNewHandler(createServiceDouble({ discoverRepository: async () => repositoryFixture(), loadConfig: async () => config }));
  for (const [input, options] of [["feature", { allowClosed: true }], ["ABU-123", { remote: "origin" }], ["github:123 extra", {}]] as const) {
    await expect(handler(input, options, { cwd: "/repo", io })).rejects.toThrow(/issue selector/u);
  }
});

test("lookup failure and invalid base never create workspaces or launch tools", async () => {
  for (const failBase of [true, false]) {
    const calls: string[] = [];
    const handler = createNewHandler(createServiceDouble({
      discoverRepository: async () => repositoryFixture(), loadConfig: async () => config,
      resolveBase: async () => { if (failBase) throw new Error("bad base"); return base; },
      resolveGithubRepository: async () => ({ owner: "team", name: "project" }),
      resolveGithubTicket: async () => { calls.push("lookup"); throw new Error("issue closed"); },
    }));
    await expect(handler("github:123", {}, { cwd: "/repo", io })).rejects.toThrow(failBase ? "bad base" : "issue closed");
    expect(calls).toEqual(failBase ? [] : ["lookup"]);
  }
});

test("CLI dispatch combines -c with workflow, remote and base options", async () => {
  let received: NewOptions | undefined;
  const handlers = { new: async (_input: string, options: NewOptions) => { received = options; },
    setup: async () => {}, open: async () => {}, list: async () => {}, done: async () => {} };
  await createCli({ context: { cwd: "/repo", io }, handlers }).parseAsync(["new", "github:123", "-c", "--remote", "upstream", "-w", "example", "--base", "main"], { from: "user" });
  expect(received).toEqual({ allowClosed: true, remote: "upstream", workflow: "example", base: "main" });
});
