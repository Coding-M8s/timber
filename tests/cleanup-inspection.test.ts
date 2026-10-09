import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { inspectCleanup } from "../src/git/cleanup";
import { readCleanupEvidence } from "../src/git/cleanup-evidence";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import type { RepositoryConfig, Worktree } from "../src/types";
import type { CommandServices } from "../src/services";
import { git, withRepository } from "./helpers/git";

const config = (baseBranch: string | null = "trunk", remote: string | null = null): RepositoryConfig => ({
  baseBranch, remote, worktreeDir: null, editor: null, agent: null,
});

const inspectionService: Pick<CommandServices, "inspectCleanup"> = { inspectCleanup };
void inspectionService;

async function addTarget(primary: string, path: string, branch: string): Promise<void> {
  await git(primary, "worktree", "add", "-b", branch, path);
}

async function selectedTree(primary: string, path: string): Promise<Worktree> {
  const repository = await discoverRepository(primary);
  const tree = (await listWorktrees(repository)).find(candidate => candidate.path === path);
  if (!tree) throw new Error("fixture worktree was not listed by Git");
  return tree;
}

async function refSnapshot(primary: string): Promise<string> {
  return git(primary, "for-each-ref", "--format=%(refname)%00%(objectname)");
}

async function configureBareUpstream(
  primary: string, directory: string, path: string, branch: string, remote = "backup",
): Promise<string> {
  const bare = join(directory, `${remote}.git`);
  await git(directory, "init", "--bare", bare);
  await git(primary, "remote", "add", remote, bare);
  await git(path, "push", "--set-upstream", remote, branch);
  return bare;
}

async function commitFile(path: string, name: string, body: string, message: string): Promise<string> {
  await writeFile(join(path, name), body);
  await git(path, "add", "--", name);
  await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(path, "rev-parse", "HEAD");
}

test("inspection reads fresh file classes without changing refs or files", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "manual linked");
    await addTarget(primary, path, "feature/status");
    await writeFile(join(path, "tracked.txt"), "modified\n");
    await writeFile(join(path, "new\nfile.txt"), "untracked\n");
    await writeFile(join(path, ".env"), "never print this\n");
    const repository = await discoverRepository(primary);
    const tree = await selectedTree(primary, path);
    const refsBefore = await refSnapshot(primary);
    const trackedBefore = await readFile(join(path, "tracked.txt"), "utf8");
    const untrackedBefore = await readFile(join(path, "new\nfile.txt"), "utf8");
    const ignoredBefore = await readFile(join(path, ".env"), "utf8");

    const result = await inspectCleanup(repository, tree, config());

    expect(result.worktree).toMatchObject({ path, branch: "feature/status", head: tree.head });
    expect(result.worktree.status).toMatchObject({ kind: "known" });
    if (result.worktree.status.kind !== "known") throw new Error("expected known status");
    expect(result.worktree.status.modified).toContain("tracked.txt");
    expect(result.worktree.status.untracked).toContain("new\nfile.txt");
    expect(result.worktree.status.ignored).toContain(".env");
    expect(await refSnapshot(primary)).toBe(refsBefore);
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe(trackedBefore);
    expect(await readFile(join(path, "new\nfile.txt"), "utf8")).toBe(untrackedBefore);
    expect(await readFile(join(path, ".env"), "utf8")).toBe(ignoredBefore);
  });
});

test("no upstream remains unknown while merged ancestry is contained", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "merged linked");
    await addTarget(primary, path, "feature/merged");
    const repository = await discoverRepository(primary);
    const tree = await selectedTree(primary, path);
    const result = await inspectCleanup(repository, tree, config());
    expect(result.publication).toMatchObject({ kind: "unknown" });
    expect(result.ancestry).toMatchObject({ kind: "contained", base: { ref: "refs/heads/trunk", source: "config" } });
    if (result.ancestry.kind !== "contained") throw new Error("expected contained ancestry");
    expect(result.ancestry.base.commit).toBe(await git(primary, "rev-parse", "refs/heads/trunk"));
  });
});

test("live upstream proves publication and reports ahead commits", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "published linked");
    await addTarget(primary, path, "feature/published");
    const bare = await configureBareUpstream(primary, directory, path, "feature/published", "review-server");
    const repository = await discoverRepository(primary);
    const first = await selectedTree(primary, path);
    const published = await inspectCleanup(repository, first, config());
    expect(published.publication).toEqual({ kind: "published", upstreamRef: "refs/remotes/review-server/feature/published" });

    const ahead = await commitFile(path, "ahead.txt", "one commit\n", "one unpublished commit");
    const currentRepository = await discoverRepository(primary);
    const currentTree = await selectedTree(primary, path);
    const aheadInspection = await inspectCleanup(currentRepository, currentTree, config());
    expect(aheadInspection.publication).toEqual({ kind: "unpublished", commits: [ahead] });
    expect(await git(bare, "rev-parse", "refs/heads/feature/published")).not.toBe(ahead);
  });
});

test("missing or rewritten remote defeats cached publication", async () => {
  await withRepository(async (primary, directory) => {
    for (const variant of ["missing", "rewritten"] as const) {
      const path = join(directory, `remote ${variant}`);
      const branch = `feature/${variant}`;
      await addTarget(primary, path, branch);
      const bare = await configureBareUpstream(primary, directory, path, branch, `remote-${variant}`);
      let cachedTip = await git(bare, "rev-parse", `refs/heads/${branch}`);
      let expectedAhead: readonly string[];
      if (variant === "rewritten") {
        const published = await commitFile(path, "rewritten-published.txt", "published\n", "publish before remote rewrite");
        await git(path, "push", `remote-${variant}`, branch);
        cachedTip = published;
        const currentTip = await commitFile(path, "rewritten-ahead.txt", "ahead\n", "local commit after publish");
        expectedAhead = [published, currentTip];
        await git(bare, "update-ref", `refs/heads/${branch}`, await git(primary, "rev-parse", "refs/heads/trunk"));
      } else {
        const currentTip = await commitFile(path, `${variant}.txt`, `${variant}\n`, `${variant} local change`);
        expectedAhead = [currentTip];
      }
      await git(primary, "update-ref", `refs/remotes/remote-${variant}/${branch}`, cachedTip);
      if (variant === "missing") await git(bare, "update-ref", "-d", `refs/heads/${branch}`);

      const repository = await discoverRepository(primary);
      const tree = await selectedTree(primary, path);
      const result = await inspectCleanup(repository, tree, config());
      if (variant === "missing") expect(result.publication).toMatchObject({ kind: "unknown" });
      else expect(result.publication).toEqual({ kind: "unpublished", commits: expectedAhead });
      expect(await git(primary, "rev-parse", `refs/remotes/remote-${variant}/${branch}`)).toBe(cachedTip);
    }
  });
});

test("inaccessible upstream stays unknown", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "offline linked");
    await addTarget(primary, path, "feature/offline");
    const bare = await configureBareUpstream(primary, directory, path, "feature/offline", "offline");
    await git(primary, "remote", "set-url", "offline", join(directory, "not available.git"));
    const repository = await discoverRepository(primary);
    const tree = await selectedTree(primary, path);
    const result = await inspectCleanup(repository, tree, config());
    expect(result.publication).toMatchObject({ kind: "unknown" });
    expect(await git(bare, "rev-parse", "refs/heads/feature/offline")).toBe(await git(path, "rev-parse", "HEAD"));
  });
});

test("missing upstream object stays unknown without fetching", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "missing object linked");
    await addTarget(primary, path, "feature/missing-object");
    const bare = join(directory, "foreign.git");
    const foreign = join(directory, "foreign source");
    await mkdir(foreign);
    await git(foreign, "init", "-b", "main");
    await writeFile(join(foreign, "foreign.txt"), "remote only\n");
    await git(foreign, "add", ".");
    await git(foreign, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "foreign history");
    const foreignTip = await git(foreign, "rev-parse", "HEAD");
    await git(directory, "init", "--bare", bare);
    await git(foreign, "remote", "add", "origin", bare);
    await git(foreign, "push", "origin", "main:refs/heads/feature/remote-only");
    await git(primary, "remote", "add", "stranger", bare);
    const cachedTip = await git(primary, "rev-parse", "refs/heads/feature/missing-object");
    await git(primary, "update-ref", "refs/remotes/stranger/feature/remote-only", cachedTip);
    await git(path, "branch", "--set-upstream-to=stranger/feature/remote-only", "feature/missing-object");
    const missingObject = await execa("git", ["cat-file", "-e", `${foreignTip}^{commit}`], { cwd: primary, reject: false });
    expect(missingObject.exitCode).not.toBe(0);

    const repository = await discoverRepository(primary);
    const tree = await selectedTree(primary, path);
    const refsBefore = await refSnapshot(primary);
    const result = await inspectCleanup(repository, tree, config());
    expect(result.publication).toMatchObject({ kind: "unknown" });
    expect(await execa("git", ["cat-file", "-e", `${foreignTip}^{commit}`], { cwd: primary, reject: false }).then(value => value.exitCode)).not.toBe(0);
    expect(await refSnapshot(primary)).toBe(refsBefore);
  });
});

test("base selection obeys existing config and ambiguity policy", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "configured base linked");
    await addTarget(primary, path, "feature/base-policy");
    const repository = await discoverRepository(primary);
    const tree = await selectedTree(primary, path);
    const configured = await inspectCleanup(repository, tree, config("trunk"));
    expect(configured.ancestry).toMatchObject({ kind: "contained", base: { ref: "refs/heads/trunk", source: "config" } });

    await git(primary, "branch", "main");
    await git(primary, "branch", "master");
    const ambiguousRepository = await discoverRepository(primary);
    const ambiguousTree = await selectedTree(primary, path);
    const ambiguous = await inspectCleanup(ambiguousRepository, ambiguousTree, config(null));
    expect(ambiguous.ancestry).toMatchObject({ kind: "unknown" });
    if (ambiguous.ancestry.kind !== "unknown") throw new Error("expected ambiguous base to stay unknown");
    expect(ambiguous.ancestry.reason).toMatch(/base|ambiguous|select/i);
    const missingBase = await inspectCleanup(ambiguousRepository, ambiguousTree, config("refs/heads/not-a-base"));
    expect(missingBase.ancestry).toMatchObject({ kind: "unknown" });
  });
});

test("detached or unborn HEAD never invents branch evidence", async () => {
  await withRepository(async (primary, directory) => {
    const detachedPath = join(directory, "detached linked");
    await git(primary, "worktree", "add", "--detach", detachedPath, "HEAD");
    const repository = await discoverRepository(primary);
    const detachedTree = await selectedTree(primary, detachedPath);
    expect(detachedTree.branch).toBeNull();
    const detached = await readCleanupEvidence(repository, detachedTree, config());
    expect(detached.branchRef).toBeNull();
    expect(detached.inspection.publication).toMatchObject({ kind: "unknown" });
    expect(detached.inspection.ancestry).toMatchObject({ kind: "contained" });

    const unbornPath = join(directory, "unborn linked");
    const unborn = await execa("git", ["worktree", "add", "--orphan", "-b", "feature/unborn", unbornPath], { cwd: primary, reject: false });
    expect(unborn.exitCode).toBe(0);
    const unbornRepository = await discoverRepository(primary);
    const unbornTree = await selectedTree(primary, unbornPath);
    await expect(inspectCleanup(unbornRepository, unbornTree, config())).rejects.toThrow(/unborn|commit|unproven/i);
  });
});

test("primary, unregistered, missing, and replaced targets are never identified as removable", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "identity linked");
    await addTarget(primary, path, "feature/identity");
    const repository = await discoverRepository(primary);
    const primaryTree = (await listWorktrees(repository)).find(tree => tree.isPrimary)!;
    const pathTree = await selectedTree(primary, path);
    const refsBefore = await refSnapshot(primary);
    const original = await readFile(join(path, "tracked.txt"), "utf8");
    await expect(inspectCleanup(repository, { ...primaryTree, isPrimary: false }, config())).rejects.toThrow(/primary/i);

    const unrelated = join(directory, "unregistered repo");
    await mkdir(unrelated);
    await git(unrelated, "init", "-b", "trunk");
    await writeFile(join(unrelated, "keep.txt"), "unrelated data\n");
    await git(unrelated, "add", ".");
    await git(unrelated, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "unrelated");
    const unrelatedRefs = await refSnapshot(unrelated);
    await expect(inspectCleanup(repository, { ...pathTree, path: unrelated }, config())).rejects.toThrow(/registered|worktree/i);
    expect(await refSnapshot(unrelated)).toBe(unrelatedRefs);
    expect(await readFile(join(unrelated, "keep.txt"), "utf8")).toBe("unrelated data\n");

    await rm(path, { recursive: true, force: true });
    await expect(inspectCleanup(repository, pathTree, config())).rejects.toThrow(/missing|prunable|identity|path/i);
    expect(await refSnapshot(primary)).toBe(refsBefore);

    const replacementPath = join(directory, "replacement linked");
    await addTarget(primary, replacementPath, "feature/replacement");
    const replacementTree = await selectedTree(primary, replacementPath);
    await rm(replacementPath, { recursive: true, force: true });
    await mkdir(replacementPath);
    await git(replacementPath, "init", "-b", "main");
    await writeFile(join(replacementPath, "owned.txt"), "keep replacement\n");
    await git(replacementPath, "add", ".");
    await git(replacementPath, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "replacement");
    const replacementRefs = await refSnapshot(replacementPath);
    const mainRefsAfterReplacement = await refSnapshot(primary);
    await expect(inspectCleanup(repository, replacementTree, config())).rejects.toThrow(/prunable|identity|Git metadata|path/i);
    expect(await refSnapshot(replacementPath)).toBe(replacementRefs);
    expect(await readFile(join(replacementPath, "owned.txt"), "utf8")).toBe("keep replacement\n");
    expect(await refSnapshot(primary)).toBe(mainRefsAfterReplacement);
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe(original);
  });
});
