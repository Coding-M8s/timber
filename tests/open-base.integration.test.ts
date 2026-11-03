import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOpenHandler } from "../src/commands/open";
import { loadRepositoryConfig } from "../src/config";
import { readBaseAssociation, writeBaseAssociation } from "../src/git/base-metadata";
import { createWorktree } from "../src/git/create-worktree";
import { resolveOpenTarget } from "../src/git/open-target";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import { createServiceDouble } from "./helpers/services";
import { git, withRepository } from "./helpers/git";

const services = {
  ...createServiceDouble(), discoverRepository, loadConfig: loadRepositoryConfig,
  createWorktree, resolveOpenTarget,
  launchEditor: async () => ({ kind: "skipped" as const }),
};

test.each(["unassigned", "refs/heads/trunk"])(
  "open preserves %s base, dirty files, index and refs without prompting", async base => {
    await withRepository(async (primary, directory) => {
      const linked = join(directory, "feature");
      await git(primary, "worktree", "add", "-b", "feature", linked);
      await writeFile(join(linked, "tracked.txt"), "local work\n");
      await writeFile(join(linked, "untracked.txt"), "keep me\n");
      const repository = await discoverRepository(primary);
      const tree = (await listWorktrees(repository)).find(tree => tree.branch === "feature")!;
      if (base !== "unassigned") await writeBaseAssociation(repository, tree, base);
      const association = await readBaseAssociation(repository, tree);
      const refs = await git(primary, "show-ref");
      const inventory = await git(primary, "worktree", "list", "--porcelain");
      const indexPath = join(await git(linked, "rev-parse", "--absolute-git-dir"), "index");
      const index = await readFile(indexPath);
      await createOpenHandler(services)("feature", {}, { cwd: primary, interactive: true,
        io: { stdout: () => {}, stderr: () => {} },
        choose: async () => { throw new Error("Unexpected prompt"); } });
      expect(await readBaseAssociation(repository, tree)).toEqual(association);
      expect(await git(primary, "show-ref")).toBe(refs);
      expect(await git(primary, "worktree", "list", "--porcelain")).toBe(inventory);
      expect(await readFile(indexPath)).toEqual(index);
      expect(await readFile(join(linked, "tracked.txt"), "utf8")).toBe("local work\n");
      expect(await readFile(join(linked, "untracked.txt"), "utf8")).toBe("keep me\n");
    });
  },
);

test("open materializes an unchecked branch with no saved base or prompt", async () => {
  await withRepository(async primary => {
    await git(primary, "branch", "feature");
    const refs = await git(primary, "show-ref");
    await createOpenHandler(services)("feature", {}, { cwd: primary, interactive: true,
      io: { stdout: () => {}, stderr: () => {} },
      choose: async () => { throw new Error("Unexpected prompt"); } });
    const repository = await discoverRepository(primary);
    const tree = (await listWorktrees(repository)).find(tree => tree.branch === "feature")!;
    expect(tree).toBeDefined();
    expect(await readBaseAssociation(repository, tree)).toEqual({ kind: "unassigned" });
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await readFile(join(tree.path, "tracked.txt"), "utf8")).toBe("original\n");
  });
});
