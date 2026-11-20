import { expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverRepository } from "../src/git/repository";
import {
  assertOpenableWorktree, assertWorktreeIdentity, listWorktrees, mapWithLimit, WORKTREE_INSPECTION_LIMIT,
} from "../src/git/worktrees";
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

test("identity checks permit a dirty, locked linked worktree", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "locked dirty worktree");
    await git(primary, "worktree", "add", "-b", "locked-dirty", linked);
    await git(primary, "worktree", "lock", linked, "--reason", "keep open");
    await writeFile(join(linked, "tracked.txt"), "modified\n");
    await writeFile(join(linked, "keep.txt"), "untracked\n");

    const repository = await discoverRepository(primary);
    const tree = (await listWorktrees(repository)).find(candidate => candidate.path === linked)!;
    expect(tree).toMatchObject({
      locked: { reason: "keep open" },
      status: { kind: "known", modified: ["tracked.txt"], untracked: ["keep.txt"] },
    });
    await expect(assertWorktreeIdentity(repository, tree)).resolves.toBeUndefined();
    await expect(assertOpenableWorktree(repository, tree)).resolves.toBeUndefined();
  });
});

test("identity and openability checks reject missing prunable worktrees without changing Git state", async () => {
  await withRepository(async (primary, directory) => {
    const stale = join(directory, "missing stale worktree");
    await git(primary, "worktree", "add", "-b", "missing-stale", stale);
    await rm(stale, { recursive: true });

    const repository = await discoverRepository(primary);
    const tree = (await listWorktrees(repository)).find(candidate => candidate.path === stale)!;
    const inventoryBefore = await git(primary, "worktree", "list", "--porcelain", "-z");
    const refsBefore = await git(primary, "show-ref");
    expect(tree).toMatchObject({ pathExists: false, prunable: expect.anything() });
    await expect(assertWorktreeIdentity(repository, tree)).rejects.toThrow(stale);
    await expect(assertOpenableWorktree(repository, tree)).rejects.toThrow(stale);
    expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(inventoryBefore);
    expect(await git(primary, "show-ref")).toBe(refsBefore);
    expect(await readFile(primary + "/tracked.txt", "utf8")).toBe("original\n");
  });
});

for (const replacement of ["unrelated repository", "symlink", "copied gitfile", "file"] as const) {
  test(`identity and openability checks reject a stale path replaced by a ${replacement}`, async () => {
    await withRepository(async (primary, directory) => {
      const stale = join(directory, "stale target");
      const sibling = join(directory, "healthy sibling");
      await git(primary, "worktree", "add", "-b", "stale-target", stale);
      await git(primary, "worktree", "add", "-b", "healthy-sibling", sibling);
      const sentinel = join(sibling, "keep.txt");
      await writeFile(sentinel, "preserve sibling\n");
      await rm(stale, { recursive: true });
      if (replacement === "unrelated repository") {
        await mkdir(stale);
        await git(stale, "init", "-b", "unrelated");
        await writeFile(join(stale, "keep.txt"), "preserve replacement\n");
      } else if (replacement === "symlink") {
        await symlink(sibling, stale);
      } else if (replacement === "copied gitfile") {
        await mkdir(stale);
        await writeFile(join(stale, ".git"), await readFile(join(sibling, ".git")));
        await git(stale, "checkout-index", "--all");
      } else {
        await writeFile(stale, "preserve replacement\n");
      }

      const repository = await discoverRepository(primary);
      const tree = (await listWorktrees(repository)).find(candidate => candidate.path === stale)!;
      const inventoryBefore = await git(primary, "worktree", "list", "--porcelain", "-z");
      const refsBefore = await git(primary, "show-ref");
      const sentinelPath = replacement === "file" ? stale : join(
        replacement === "unrelated repository" ? stale : sibling, "keep.txt",
      );
      await expect(assertWorktreeIdentity(repository, tree)).rejects.toThrow(stale);
      await expect(assertWorktreeIdentity(repository, tree)).rejects.toThrow(/restore|repair/i);
      await expect(assertOpenableWorktree(repository, tree)).rejects.toThrow(stale);
      await expect(assertOpenableWorktree(repository, tree)).rejects.toThrow(/restore|repair|prune/i);
      expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(inventoryBefore);
      expect(await git(primary, "show-ref")).toBe(refsBefore);
      expect(await readFile(sentinelPath, "utf8")).toBe(
        replacement === "symlink" || replacement === "copied gitfile"
          ? "preserve sibling\n" : "preserve replacement\n",
      );
    });
  });
}

test("listing without ignored files reports the same modified and untracked files and skips ignored content", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "linked");
    await git(primary, "worktree", "add", "-b", "feature/listing", linked);
    await writeFile(join(linked, "tracked.txt"), "staged\n");
    await git(linked, "add", "tracked.txt");
    await writeFile(join(linked, "tracked.txt"), "staged and unstaged\n");
    await git(linked, "mv", "old name.txt", "renamed.txt");
    await writeFile(join(linked, "untracked.txt"), "keep\n");
    await mkdir(join(linked, "new folder", "deep"), { recursive: true });
    await writeFile(join(linked, "new folder", "deep", "file.txt"), "keep\n");
    await writeFile(join(linked, ".gitignore"), ".env\nnode_modules/\n");
    await mkdir(join(linked, "node_modules", "package"), { recursive: true });
    await writeFile(join(linked, "node_modules", "package", "index.js"), "ignored\n");
    await writeFile(join(linked, ".env"), "ignored\n");
    const repository = await discoverRepository(linked);

    const full = (await listWorktrees(repository)).find(tree => tree.path === linked)!;
    const listing = (await listWorktrees(repository, { includeIgnored: false })).find(tree => tree.path === linked)!;

    expect(full.status.kind).toBe("known");
    expect(listing.status.kind).toBe("known");
    if (full.status.kind !== "known" || listing.status.kind !== "known") return;
    expect([...full.status.ignored].sort()).toEqual([".env", "node_modules/package/index.js"]);
    expect(listing.status.ignored).toEqual([]);
    expect([...listing.status.modified].sort()).toEqual([".gitignore", "renamed.txt", "tracked.txt"]);
    expect([...listing.status.modified].sort()).toEqual([...full.status.modified].sort());
    expect([...listing.status.untracked].sort()).toEqual(["new folder/deep/file.txt", "untracked.txt"]);
    expect([...listing.status.untracked].sort()).toEqual([...full.status.untracked].sort());
  });
});

test("mapWithLimit keeps input order, never exceeds its limit, and passes failures on", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithLimit([5, 1, 4, 2, 3, 0, 6, 1, 2], 3, async delay => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(done => setTimeout(done, delay * 2));
    active--;
    return delay * 10;
  });
  expect(results).toEqual([50, 10, 40, 20, 30, 0, 60, 10, 20]);
  expect(peak).toBe(3);
  expect(await mapWithLimit([], 3, async () => 1)).toEqual([]);
  const started: number[] = [];
  await expect(mapWithLimit([1, 2, 3, 4], 1, async item => {
    started.push(item);
    if (item === 2) throw new Error("boom");
    return item;
  })).rejects.toThrow("boom");
  expect(started).toEqual([1, 2]);
  expect(() => mapWithLimit([1], 0, async item => item)).toThrow(RangeError);
});

test("listWorktrees inspects at most the fixed number of worktrees at once", async () => {
  expect(WORKTREE_INSPECTION_LIMIT).toBe(4);
  await withRepository(async (primary, directory) => {
    const log = join(directory, "status.log");
    // A slow clean filter on a file with stale times makes each status long enough to overlap.
    await writeFile(join(primary, ".gitattributes"), "tracked.txt filter=slow\n");
    await git(primary, "add", ".gitattributes");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "filter");
    await git(primary, "config", "filter.slow.clean", "sleep 0.3; cat");
    const trees = [primary];
    for (let i = 0; i < 8; i++) {
      trees.push(join(directory, `many-${i}`));
      await git(primary, "worktree", "add", "-b", `many-${i}`, trees.at(-1)!);
    }
    const later = new Date(Date.now() + 60_000);
    for (const tree of trees) await utimes(join(tree, "tracked.txt"), later, later);
    const repository = await discoverRepository(primary);
    process.env.GIT_TRACE2_EVENT = log;
    try {
      const listed = await listWorktrees(repository, { includeIgnored: false });
      expect(listed.map(tree => tree.status)).toEqual(trees.map(() => ({ kind: "known", modified: [], untracked: [], ignored: [] })));
    } finally {
      delete process.env.GIT_TRACE2_EVENT;
    }
    const events = (await readFile(log, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const status = new Set(events.filter(event => event.event === "start" && event.argv?.includes("status")).map(event => event.sid));
    // Exits sort before starts at the same instant, so ties never inflate the count.
    const timeline = events.filter(event => status.has(event.sid) && (event.event === "start" || event.event === "exit"))
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || (a.event === "exit" ? -1 : 1));
    expect(status.size).toBe(9);
    let running = 0;
    let peak = 0;
    for (const event of timeline) {
      running += event.event === "start" ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(WORKTREE_INSPECTION_LIMIT);
  });
});
