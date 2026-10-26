import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOpenHandler } from "../src/commands/open";
import { createListHandler } from "../src/commands/list";
import { loadRepositoryConfig } from "../src/config";
import { listBranches, resolveBase } from "../src/git/branches";
import { readBaseAssociation, writeBaseAssociation } from "../src/git/base-metadata";
import { createWorktree } from "../src/git/create-worktree";
import { resolveOpenTarget } from "../src/git/open-target";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import { readWorkflowAssociation, writeWorkflowAssociation } from "../src/git/workflow-metadata";
import type { CommandContext } from "../src/services";
import { createServiceDouble } from "./helpers/services";
import { git, withRepository } from "./helpers/git";

const services = {
  ...createServiceDouble(), discoverRepository, loadConfig: loadRepositoryConfig,
  listBranches, resolveBase, readBaseAssociation, writeBaseAssociation,
  createWorktree, resolveOpenTarget, listWorktrees, readWorkflowAssociation, writeWorkflowAssociation,
  launchEditor: async () => ({ kind: "skipped" as const }),
};

test.each(["unassigned", "refs/heads/ABU-100", "refs/remotes/origin/master"])(
  "open records %s without changing files or refs, and ls displays it", async selection => {
    await withRepository(async (primary, directory) => {
      await git(primary, "branch", "ABU-100");
      await git(primary, "remote", "add", "origin", join(directory, "offline.git"));
      await git(primary, "update-ref", "refs/remotes/origin/master", "HEAD");
      const linked = join(directory, "feature");
      await git(primary, "worktree", "add", "-b", "feature", linked);
      await writeFile(join(linked, "tracked.txt"), "local work\n");
      await writeFile(join(linked, "untracked.txt"), "keep me\n");
      const repository = await discoverRepository(primary);
      const tree = (await listWorktrees(repository)).find(tree => tree.branch === "feature")!;
      const refs = await git(primary, "show-ref");
      const indexPath = join(await git(linked, "rev-parse", "--absolute-git-dir"), "index");
      const index = await readFile(indexPath);
      let prompts = 0;
      let stdout = "";
      const context: CommandContext = { cwd: primary, interactive: true,
        io: { stdout: text => { stdout += text; }, stderr: () => {} },
        choose: async (_message, choices) => {
          prompts++;
          expect(choices.find(choice => choice.default)?.value).toBe("unassigned");
          expect(choices.some(choice => choice.value === selection)).toBe(true);
          return selection;
        } };
      await createOpenHandler(services)("feature", {}, context);
      expect(await readBaseAssociation(repository, tree)).toEqual(selection === "unassigned"
        ? { kind: "unassigned" } : { kind: "assigned", ref: selection });
      if (selection !== "unassigned") {
        await createOpenHandler(services)("feature", {}, context);
        expect(prompts).toBe(1);
      }
      stdout = "";
      await createListHandler(services)(context);
      const row = stdout.split("\n").find(line => line.includes(linked))!;
      expect(row).toContain(selection === "unassigned" ? "-" : selection.replace("refs/remotes/", ""));
      expect(await git(primary, "show-ref")).toBe(refs);
      expect(await readFile(indexPath)).toEqual(index);
      expect(await readFile(join(linked, "tracked.txt"), "utf8")).toBe("local work\n");
      expect(await readFile(join(linked, "untracked.txt"), "utf8")).toBe("keep me\n");
    });
  },
);

test("base cancellation leaves an unchecked branch without a worktree", async () => {
  await withRepository(async primary => {
    await git(primary, "branch", "feature");
    const refs = await git(primary, "show-ref");
    const worktrees = await git(primary, "worktree", "list", "--porcelain");
    await createOpenHandler(services)("feature", {}, { cwd: primary, interactive: true,
      io: { stdout: () => {}, stderr: () => {} }, choose: async () => null });
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(worktrees);
  });
});

test("base save failure retains the newly created worktree, refs and files", async () => {
  await withRepository(async primary => {
    await git(primary, "branch", "feature");
    const refs = await git(primary, "show-ref");
    let retainedPath = "";
    const open = createOpenHandler({ ...services, createWorktree: async (...args) => {
      const tree = await createWorktree(...args);
      retainedPath = tree.path;
      const admin = await git(tree.path, "rev-parse", "--absolute-git-dir");
      await mkdir(join(admin, "timber"), { mode: 0o755 });
      return tree;
    } });
    await expect(open("feature", {}, { cwd: primary, interactive: true,
      io: { stdout: () => {}, stderr: () => {} }, choose: async () => "refs/heads/trunk" }))
      .rejects.toThrow("Base metadata directory is unsafe");
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(retainedPath, "branch", "--show-current")).toBe("feature");
    expect(await readFile(join(retainedPath, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await git(primary, "worktree", "list", "--porcelain")).toContain(retainedPath);
  });
});
