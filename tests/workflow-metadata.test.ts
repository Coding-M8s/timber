import { expect, test } from "bun:test";
import { lstat, readFile, rename, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import { readWorkflowAssociation, writeWorkflowAssociation } from "../src/git/workflow-metadata";
import { git, withRepository } from "./helpers/git";

test("associations are private to each Git worktree and vanish with its admin directory", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "review worktree");
    await git(primary, "worktree", "add", "-b", "review", linked);
    const repository = await discoverRepository(linked);
    const trees = await listWorktrees(repository);
    const primaryTree = trees.find(tree => tree.isPrimary)!;
    const linkedTree = trees.find(tree => tree.path === linked)!;
    expect(await readWorkflowAssociation(repository, linkedTree)).toEqual({ kind: "unassigned" });
    await writeWorkflowAssociation(repository, linkedTree, "review");
    expect(await readWorkflowAssociation(repository, linkedTree)).toEqual({ kind: "assigned", name: "review" });
    expect(await readWorkflowAssociation(repository, primaryTree)).toEqual({ kind: "unassigned" });
    expect(await git(linked, "status", "--porcelain")).toBe("");
    const admin = await git(linked, "rev-parse", "--absolute-git-dir");
    const metadata = join(admin, "timber", "workflow.json");
    expect((await lstat(metadata)).mode & 0o777).toBe(0o600);
    await git(primary, "worktree", "remove", linked);
    await git(primary, "worktree", "add", linked, "review");
    const recreated = (await listWorktrees(repository)).find(tree => tree.path === linked)!;
    expect(await readWorkflowAssociation(repository, recreated)).toEqual({ kind: "unassigned" });
  });
});

test("invalid metadata fails closed and an explicit assignment repairs it", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "review worktree");
    await git(primary, "worktree", "add", "-b", "review", linked);
    const repository = await discoverRepository(linked);
    const tree = (await listWorktrees(repository)).find(item => item.path === linked)!;
    await writeWorkflowAssociation(repository, tree, "review");
    const admin = await git(linked, "rev-parse", "--absolute-git-dir");
    const metadata = join(admin, "timber", "workflow.json");
    const record = JSON.parse(await readFile(metadata, "utf8"));
    await writeFile(metadata, JSON.stringify({ ...record, worktreePath: primary }));
    expect(await readWorkflowAssociation(repository, tree)).toEqual({ kind: "invalid", reason: "stale" });
    await writeWorkflowAssociation(repository, tree, "develop");
    expect(await readWorkflowAssociation(repository, tree)).toEqual({ kind: "assigned", name: "develop" });
    await writeFile(metadata, "not json");
    expect(await readWorkflowAssociation(repository, tree)).toEqual({ kind: "invalid", reason: "malformed" });
    await expect(writeWorkflowAssociation(repository, tree, "review")).rejects.toThrow(/malformed/);
    await writeFile(metadata, JSON.stringify({ ...record, version: 999 }));
    expect(await readWorkflowAssociation(repository, tree)).toEqual({ kind: "invalid", reason: "malformed" });
    await writeFile(metadata, JSON.stringify(record));
    await rename(metadata, join(admin, "timber", "record-backup"));
    await symlink(join(admin, "timber", "record-backup"), metadata);
    expect(await readWorkflowAssociation(repository, tree)).toEqual({ kind: "invalid", reason: "malformed" });
    await expect(writeWorkflowAssociation(repository, tree, "review")).rejects.toThrow(/malformed/);
    expect(await git(linked, "status", "--porcelain")).toBe("");
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
    await expect(writeWorkflowAssociation(repository, tree, "review")).rejects.toThrow(/metadata/);
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
    await expect(writeWorkflowAssociation(repository, tree, `r${"e".repeat(4096)}`))
      .rejects.toThrow(/too large/);
    expect(await readWorkflowAssociation(repository, tree)).toEqual({ kind: "unassigned" });
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await readFile(join(linked, "tracked.txt"), "utf8")).toBe("original\n");
  });
});
