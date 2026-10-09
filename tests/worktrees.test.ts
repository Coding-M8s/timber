import { expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import { git, withRepository } from "./helpers/git";

test("reads all Git worktrees, counts filenames once, and preserves stale entries and repository state", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "primary repo-worktrees", "feature");
    const detached = join(directory, "manual detached");
    const stale = join(directory, "stale tree");
    await git(primary, "worktree", "add", "-b", "feature/ticket", linked);
    await git(primary, "worktree", "add", "--detach", detached);
    await git(primary, "worktree", "add", "-b", "stale", stale);
    await git(primary, "worktree", "lock", linked, "--reason", "in use");
    await rm(stale, { recursive: true });
    await writeFile(join(linked, "tracked.txt"), "staged\n");
    await git(linked, "add", "tracked.txt");
    await writeFile(join(linked, "tracked.txt"), "unstaged\n");
    await git(linked, "mv", "old name.txt", "new\nname.txt");
    await writeFile(join(linked, "untracked\tfile.txt"), "keep\n");
    await writeFile(join(linked, ".env"), "fixture only\n");

    const repository = await discoverRepository(linked);
    const inventoryBefore = await git(primary, "worktree", "list", "--porcelain", "-z");
    const refsBefore = await git(primary, "show-ref");
    const indexPath = (await git(linked, "rev-parse", "--absolute-git-dir")) + "/index";
    const indexBefore = await readFile(indexPath);
    const worktrees = await listWorktrees(repository);

    expect(worktrees).toHaveLength(4);
    expect(worktrees.find(tree => tree.isPrimary)).toMatchObject({
      path: primary, branch: "trunk", pathExists: true,
      status: { kind: "known", modified: [], untracked: [], ignored: [] },
    });
    expect(worktrees.find(tree => tree.path === linked)).toMatchObject({
      branch: "feature/ticket", isPrimary: false, locked: { reason: "in use" },
      status: { kind: "known", modified: ["new\nname.txt", "tracked.txt"], untracked: ["untracked\tfile.txt"], ignored: [".env"] },
    });
    expect(worktrees.find(tree => tree.path === detached)).toMatchObject({ branch: null, pathExists: true });
    expect(worktrees.find(tree => tree.path === stale)).toMatchObject({
      branch: "stale", pathExists: false, status: { kind: "unknown" },
    });
    expect(worktrees.find(tree => tree.path === stale)?.prunable).not.toBeNull();
    expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(inventoryBefore);
    expect(await git(primary, "show-ref")).toBe(refsBefore);
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(await readFile(join(linked, "tracked.txt"), "utf8")).toBe("unstaged\n");
    expect(await readFile(join(linked, "untracked\tfile.txt"), "utf8")).toBe("keep\n");
    expect(await readFile(join(linked, ".env"), "utf8")).toBe("fixture only\n");
  });
});

test("a stale path replaced by an unrelated repository has unknown status", async () => {
  await withRepository(async (primary, directory) => {
    const replaced = join(directory, "replaced");
    await git(primary, "worktree", "add", "-b", "replaced", replaced);
    await rm(replaced, { recursive: true });
    await mkdir(replaced);
    await git(replaced, "init", "-b", "unrelated");
    const worktrees = await listWorktrees(await discoverRepository(primary));
    expect(worktrees).toHaveLength(2);
    expect(worktrees.find(tree => tree.path === replaced)).toMatchObject({
      branch: "replaced", pathExists: true, status: { kind: "unknown" },
    });
    expect(worktrees.find(tree => tree.isPrimary)?.status.kind).toBe("known");
  });
});

for (const replacement of ["symlink", "copied gitfile"] as const) {
  test(`a stale path redirected to a sibling worktree via ${replacement} never adopts its clean status`, async () => {
    await withRepository(async (primary, directory) => {
      const stale = join(directory, "stale");
      const healthy = join(directory, "healthy");
      await git(primary, "worktree", "add", "-b", "stale", stale);
      await git(primary, "worktree", "add", "-b", "healthy", healthy);
      await rm(stale, { recursive: true });
      if (replacement === "symlink") await symlink(healthy, stale);
      else {
        await mkdir(stale);
        await writeFile(join(stale, ".git"), await readFile(join(healthy, ".git")));
        await git(stale, "checkout-index", "--all");
      }
      const worktrees = await listWorktrees(await discoverRepository(primary));
      expect(worktrees.find(tree => tree.path === stale)).toMatchObject({
        branch: "stale", pathExists: true, status: { kind: "unknown" },
      });
      expect(worktrees.find(tree => tree.path === healthy)).toMatchObject({
        branch: "healthy", status: { kind: "known", modified: [], untracked: [] },
      });
    });
  });
}

for (const option of ["status.renames", "diff.renames"] as const) {
  test(`renames count once even when ${option} is disabled in user configuration`, async () => {
    await withRepository(async (primary) => {
      await git(primary, "config", option, "false");
      await git(primary, "mv", "old name.txt", "new name.txt");
      const worktrees = await listWorktrees(await discoverRepository(primary));
      expect(worktrees[0]?.status).toEqual({
        kind: "known", modified: ["new name.txt"], untracked: [], ignored: [],
      });
      expect(await git(primary, "config", option)).toBe("false");
    });
  });
}

test("one unreadable Git status leaves a useful unknown row without losing healthy rows", async () => {
  await withRepository(async (primary, directory) => {
    const broken = join(directory, "broken");
    await git(primary, "worktree", "add", "-b", "broken", broken);
    const indexPath = (await git(broken, "rev-parse", "--absolute-git-dir")) + "/index";
    await writeFile(indexPath, "invalid index fixture");
    const worktrees = await listWorktrees(await discoverRepository(primary));
    expect(worktrees.find(tree => tree.path === broken)?.status.kind).toBe("unknown");
    expect(worktrees.find(tree => tree.isPrimary)?.status.kind).toBe("known");
    expect(await readFile(indexPath, "utf8")).toBe("invalid index fixture");
  });
});

test("unborn HEAD has a named branch, null commit, and real untracked counts", async () => {
  await withRepository(async (_primary, directory) => {
    const unborn = join(directory, "unborn");
    await mkdir(unborn);
    await git(unborn, "init", "-b", "waiting");
    await writeFile(join(unborn, "new.txt"), "new\n");
    expect(await listWorktrees(await discoverRepository(unborn))).toMatchObject([{
      path: unborn, branch: "waiting", head: null, isPrimary: true,
      status: { kind: "known", modified: [], untracked: ["new.txt"], ignored: [] },
    }]);
  });
});

test("NUL-delimited inventory retains control characters in paths and lock reasons", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "linked\nwith\ttabs");
    await git(primary, "worktree", "add", "-b", "controls", linked);
    await git(primary, "worktree", "lock", linked, "--reason", "line one\nline two");
    const worktrees = await listWorktrees(await discoverRepository(primary));
    expect(worktrees.find(tree => tree.path === linked)).toMatchObject({
      pathExists: true, locked: { reason: "line one\nline two" }, status: { kind: "known" },
    });
  });
});

test("separate Git metadata still marks and inspects the primary working files", async () => {
  await withRepository(async (_primary, directory) => {
    const primary = join(directory, "separate primary");
    await mkdir(primary);
    await git(primary, "init", "-b", "separate", "--separate-git-dir", join(directory, "metadata.git"));
    await writeFile(join(primary, "untracked.txt"), "fixture\n");
    expect(await listWorktrees(await discoverRepository(primary))).toMatchObject([{
      path: primary, branch: "separate", isPrimary: true,
      status: { kind: "known", untracked: ["untracked.txt"] },
    }]);
  });
});
