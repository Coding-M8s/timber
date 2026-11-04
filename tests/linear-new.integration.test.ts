import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNewHandler } from "../src/commands/new";
import { resolveLinearTicket } from "../src/linear/client";
import { discoverRepository } from "../src/git/repository";
import { resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { writeBaseAssociation } from "../src/git/base-metadata";
import { resolveOpenTarget } from "../src/git/open-target";
import { taskEnvironment } from "../src/hooks";
import { createServiceDouble } from "./helpers/services";
import { git, withRepository } from "./helpers/git";

test("Linear real creation uses pinned base, saved metadata and offline ticket matching", async () => {
  await withRepository(async primary => {
    const config = { baseBranch: "trunk", remote: null, worktreeDir: null, editor: null, agent: null };
    const before = await git(primary, "rev-parse", "trunk");
    const handler = createNewHandler(createServiceDouble({
      discoverRepository, loadConfig: async () => config, resolveBase,
      resolveLinearTicket: key => resolveLinearTicket(key, { token: async () => "synthetic", timeoutMs: 100,
        fetch: async () => new Response(JSON.stringify({ data: { issue: { trashed: null, identifier: "ENG-123", title: "Fix login", state: { type: "started" }, url: "https://linear.app/w/issue/ENG-123" } } })) }),
      createWorktree, writeBaseAssociation, launchEditor: async () => ({ kind: "skipped" }),
    }));
    await handler("linear:ENG-123", { base: "trunk" }, { cwd: primary, io: { stdout() {}, stderr() {} } });
    expect(await git(primary, "rev-parse", "ENG-123-fix-login")).toBe(before);
    const repository = await discoverRepository(primary);
    const opened = await resolveOpenTarget(repository, "ENG-123", config);
    expect(opened.kind).toBe("found");
    expect(taskEnvironment({ cwd: primary, repositoryRoot: primary, branch: "ENG-123-fix-login" }).TIMBER_TASK_ID).toBe("ENG-123");
  });
}, 30_000);

test("Linear lookup refusals preserve real refs, dirty files and worktree registrations", async () => {
  await withRepository(async primary => {
    await writeFile(join(primary, "tracked.txt"), "local changes\n");
    await writeFile(join(primary, "untracked.txt"), "preserve\n");
    const beforeRefs = await git(primary, "show-ref");
    const index = await readFile(join(primary, ".git/index"));
    const beforeTrees = await git(primary, "worktree", "list", "--porcelain");
    const config = { baseBranch: "trunk", remote: null, worktreeDir: null, editor: null, agent: null };
    for (const reason of ["closed", "missing-login", "network"]) {
      const handler = createNewHandler(createServiceDouble({
        discoverRepository, loadConfig: async () => config, resolveBase,
        resolveLinearTicket: key => resolveLinearTicket(key, {
          timeoutMs: 100, token: async () => { if (reason === "missing-login") throw new Error("Login unavailable"); return "synthetic"; },
          fetch: async () => { if (reason === "network") throw new Error("synthetic transport"); return new Response(JSON.stringify({ data: { issue: { trashed: null, identifier: "ENG-123", title: "Fix", state: { type: "completed" }, url: "https://linear.app/w/issue/ENG-123" } } })); },
        }),
      }));
      await expect(handler("linear:ENG-123", {}, { cwd: primary, io: { stdout() {}, stderr() {} } })).rejects.toThrow();
      expect(await readFile(join(primary, ".git/index"))).toEqual(index);
      expect(await git(primary, "show-ref")).toBe(beforeRefs);
      expect(await git(primary, "worktree", "list", "--porcelain")).toBe(beforeTrees);
      expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("local changes\n");
      expect(await readFile(join(primary, "untracked.txt"), "utf8")).toBe("preserve\n");
    }
  });
}, 30_000);
