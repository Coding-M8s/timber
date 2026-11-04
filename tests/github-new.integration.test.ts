import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNewHandler } from "../src/commands/new";
import { resolveGithubRepository } from "../src/github/repository";
import { resolveGithubTicket } from "../src/github/client";
import { discoverRepository } from "../src/git/repository";
import { resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { writeBaseAssociation } from "../src/git/base-metadata";
import { resolveOpenTarget } from "../src/git/open-target";
import { taskEnvironment } from "../src/hooks";
import { createServiceDouble } from "./helpers/services";
import { git, withRepository } from "./helpers/git";

test.each(["open", "closed"])("GitHub real worktree creation uses upstream issues with pinned local base and offline open, state=%s", async state => {
  await withRepository(async primary => {
    await git(primary, "remote", "add", "origin", "https://github.com/fork/project.git");
    await git(primary, "remote", "add", "upstream", "git@github.com:team/project.git");
    const config = { baseBranch: "trunk", remote: null, worktreeDir: null, editor: null, agent: null };
    const before = await git(primary, "rev-parse", "trunk");
    const handler = createNewHandler(createServiceDouble({
      discoverRepository, loadConfig: async () => config, resolveBase, resolveGithubRepository,
      resolveGithubTicket: async (repo, number, closed) => {
        expect(repo).toEqual({ owner: "team", name: "project" });
        return resolveGithubTicket(repo, number, closed, { token: async () => "synthetic", timeoutMs: 100,
          fetch: async () => new Response(JSON.stringify({ number: 123, title: "Fix login", state })) });
      },
      createWorktree, writeBaseAssociation, launchEditor: async () => ({ kind: "skipped" }),
    }));
    await handler("github:123", { base: "trunk", remote: "upstream", allowClosed: state === "closed" }, { cwd: primary, io: { stdout() {}, stderr() {} } });
    expect(await git(primary, "rev-parse", "GH-123-fix-login")).toBe(before);
    const repository = await discoverRepository(primary);
    const opened = await resolveOpenTarget(repository, "GH-123", config);
    expect(opened.kind).toBe("found");
    expect(taskEnvironment({ cwd: primary, repositoryRoot: primary, branch: "GH-123-fix-login" }).TIMBER_TASK_ID).toBe("GH-123");
  });
}, 30_000);

test("GitHub lookup refusals preserve real refs, dirty files and worktree registrations", async () => {
  await withRepository(async primary => {
    await git(primary, "remote", "add", "origin", "https://github.com/team/project.git");
    await writeFile(join(primary, "tracked.txt"), "local changes\n");
    await writeFile(join(primary, "untracked.txt"), "preserve\n");
    const beforeRefs = await git(primary, "show-ref");
    const beforeTrees = await git(primary, "worktree", "list", "--porcelain");
    const config = { baseBranch: "trunk", remote: null, worktreeDir: null, editor: null, agent: null };
    for (const reason of ["closed", "missing-login", "network"]) {
      const handler = createNewHandler(createServiceDouble({
        discoverRepository, loadConfig: async () => config, resolveBase, resolveGithubRepository,
        resolveGithubTicket: async (repo, number, closed) => resolveGithubTicket(repo, number, closed, {
          timeoutMs: 100, token: async () => { if (reason === "missing-login") throw new Error("Login unavailable"); return "synthetic"; },
          fetch: async () => { if (reason === "network") throw new Error("synthetic transport"); return new Response(JSON.stringify({ number: 123, title: "Fix", state: "closed" })); },
        }),
      }));
      await expect(handler("github:123", {}, { cwd: primary, io: { stdout() {}, stderr() {} } })).rejects.toThrow();
      expect(await git(primary, "show-ref")).toBe(beforeRefs);
      expect(await git(primary, "worktree", "list", "--porcelain")).toBe(beforeTrees);
      expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("local changes\n");
      expect(await readFile(join(primary, "untracked.txt"), "utf8")).toBe("preserve\n");
    }
  });
}, 30_000);
