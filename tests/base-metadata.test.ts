import { expect, test } from "bun:test";
import { lstat, readFile, rename, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import { readBaseAssociation, writeBaseAssociation } from "../src/git/base-metadata";
import { git, withRepository } from "./helpers/git";

test("associations are private to each Git worktree and vanish with its admin directory", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "review worktree");
    await git(primary, "worktree", "add", "-b", "review", linked);
    const repository = await discoverRepository(linked);
    const trees = await listWorktrees(repository);
    const primaryTree = trees.find(tree => tree.isPrimary)!;
    const linkedTree = trees.find(tree => tree.path === linked)!;
    expect(await readBaseAssociation(repository, linkedTree)).toEqual({ kind: "unassigned" });
    await writeBaseAssociation(repository, linkedTree, "refs/heads/trunk");
    expect(await readBaseAssociation(repository, linkedTree)).toEqual({ kind: "assigned", ref: "refs/heads/trunk" });
    expect(await readBaseAssociation(repository, primaryTree)).toEqual({ kind: "unassigned" });
    expect(await git(linked, "status", "--porcelain")).toBe("");
    const admin = await git(linked, "rev-parse", "--absolute-git-dir");
    const metadata = join(admin, "timber", "base.json");
    expect((await lstat(metadata)).mode & 0o777).toBe(0o600);
    await git(primary, "worktree", "remove", linked);
    await git(primary, "worktree", "add", linked, "review");
    const recreated = (await listWorktrees(repository)).find(tree => tree.path === linked)!;
    expect(await readBaseAssociation(repository, recreated)).toEqual({ kind: "unassigned" });
  });
});

test("invalid metadata fails closed and an explicit assignment repairs it", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "review worktree");
    await git(primary, "worktree", "add", "-b", "review", linked);
    const repository = await discoverRepository(linked);
    const tree = (await listWorktrees(repository)).find(item => item.path === linked)!;
    await writeBaseAssociation(repository, tree, "refs/heads/trunk");
    const admin = await git(linked, "rev-parse", "--absolute-git-dir");
    const metadata = join(admin, "timber", "base.json");
    const record = JSON.parse(await readFile(metadata, "utf8"));
    await writeFile(metadata, JSON.stringify({ ...record, worktreePath: primary }));
    expect(await readBaseAssociation(repository, tree)).toEqual({ kind: "invalid", reason: "stale" });
    await writeBaseAssociation(repository, tree, "refs/heads/develop");
    expect(await readBaseAssociation(repository, tree)).toEqual({ kind: "assigned", ref: "refs/heads/develop" });
    await writeFile(metadata, "not json");
    expect(await readBaseAssociation(repository, tree)).toEqual({ kind: "invalid", reason: "malformed" });
    await expect(writeBaseAssociation(repository, tree, "refs/heads/trunk")).rejects.toThrow(/malformed/);
    await writeFile(metadata, JSON.stringify({ ...record, version: 999 }));
    expect(await readBaseAssociation(repository, tree)).toEqual({ kind: "invalid", reason: "malformed" });
    await writeFile(metadata, JSON.stringify(record));
    await rename(metadata, join(admin, "timber", "record-backup"));
    await symlink(join(admin, "timber", "record-backup"), metadata);
    expect(await readBaseAssociation(repository, tree)).toEqual({ kind: "invalid", reason: "malformed" });
    await expect(writeBaseAssociation(repository, tree, "refs/heads/trunk")).rejects.toThrow(/malformed/);
    expect(await git(linked, "status", "--porcelain")).toBe("");
  });
});

test("a commit record stores one lowercase full hash and any other commit shape reads as malformed", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "review worktree");
    await git(primary, "worktree", "add", "-b", "review", linked);
    const repository = await discoverRepository(linked);
    const tree = (await listWorktrees(repository)).find(item => item.path === linked)!;
    const head = await git(primary, "rev-parse", "HEAD");
    await writeBaseAssociation(repository, tree, head.toUpperCase());
    expect(await readBaseAssociation(repository, tree)).toEqual({ kind: "commit", commit: head });
    const metadata = join(await git(linked, "rev-parse", "--absolute-git-dir"), "timber", "base.json");
    const record = JSON.parse(await readFile(metadata, "utf8"));
    expect(Object.keys(record)).toEqual(["version", "commit", "worktreePath", "commonGitDir", "worktreeGitDir"]);
    for (const broken of [
      { ...record, commit: head.toUpperCase() },
      { ...record, commit: head.slice(0, 12) },
      { ...record, ref: "refs/heads/trunk" },
    ]) {
      await writeFile(metadata, JSON.stringify(broken));
      expect(await readBaseAssociation(repository, tree)).toEqual({ kind: "invalid", reason: "malformed" });
    }
    await expect(writeBaseAssociation(repository, tree, head.slice(0, 12))).rejects.toThrow(/Invalid base ref/);
  });
});

test("metadata publication failure preserves Git refs and worktree files", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "review worktree");
    await git(primary, "worktree", "add", "-b", "review", linked);
    const repository = await discoverRepository(linked);
    const tree = (await listWorktrees(repository)).find(item => item.path === linked)!;
    const admin = await git(linked, "rev-parse", "--absolute-git-dir");
    await writeFile(join(admin, "timber"), "user-owned blocking file");
    const refs = await git(primary, "show-ref");
    await expect(writeBaseAssociation(repository, tree, "refs/heads/trunk")).rejects.toThrow(/metadata/);
    expect(await readFile(join(admin, "timber"), "utf8")).toBe("user-owned blocking file");
    expect(await readFile(join(linked, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

test("oversized association is refused before publication", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "review worktree");
    await git(primary, "worktree", "add", "-b", "review", linked);
    const repository = await discoverRepository(linked);
    const tree = (await listWorktrees(repository)).find(item => item.path === linked)!;
    const refs = await git(primary, "show-ref");
    await expect(writeBaseAssociation(repository, tree, `refs/heads/r${"e".repeat(4096)}`))
      .rejects.toThrow(/too large/);
    expect(await readBaseAssociation(repository, tree)).toEqual({ kind: "unassigned" });
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await readFile(join(linked, "tracked.txt"), "utf8")).toBe("original\n");
  });
});
