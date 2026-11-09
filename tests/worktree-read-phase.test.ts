import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readBaseAssociation, writeBaseAssociation } from "../src/git/base-metadata";
import { WorktreeReadPhase } from "../src/git/worktree-read-phase";
import { discoverRepository } from "../src/git/repository";
import { listWorktreeInventory, uninspectedWorktree } from "../src/git/worktrees";
import { git, withRepository } from "./helpers/git";

test("metadata bytes stay fresh within a phase, and writes are visible to the next read", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "linked");
    await git(primary, "worktree", "add", "-b", "feature", linked);
    const repository = await discoverRepository(primary);
    const tree = uninspectedWorktree((await listWorktreeInventory(repository)).find(tree => tree.path === linked)!);
    await writeBaseAssociation(repository, tree, "refs/heads/trunk");
    const phase = new WorktreeReadPhase(repository);
    expect(await readBaseAssociation(repository, tree, phase)).toEqual({ kind: "assigned", ref: "refs/heads/trunk" });
    const admin = await phase.gitDirectory(tree);
    await writeFile(join(admin, "timber", "base.json"), "malformed");
    expect(await readBaseAssociation(repository, tree, phase)).toEqual({ kind: "invalid", reason: "malformed" });
    // Metadata content is never cached, even when the location is reused.
    await rm(join(admin, "timber", "base.json"));
    expect(await readBaseAssociation(repository, tree, phase)).toEqual({ kind: "unassigned" });
    await writeBaseAssociation(repository, tree, "refs/heads/feature");
    expect(await readBaseAssociation(repository, tree, phase)).toEqual({ kind: "assigned", ref: "refs/heads/feature" });
    expect(await git(primary, "show-ref", "--verify", "refs/heads/feature")).toContain(tree.head!);
    expect(await readFile(join(linked, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("a new read phase and metadata writes reject a replaced reciprocal identity", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "linked");
    const sibling = join(directory, "sibling");
    await git(primary, "worktree", "add", "-b", "feature", linked);
    await git(primary, "worktree", "add", "-b", "sibling", sibling);
    const repository = await discoverRepository(primary);
    const tree = uninspectedWorktree((await listWorktreeInventory(repository)).find(tree => tree.path === linked)!);
    await writeBaseAssociation(repository, tree, "refs/heads/trunk");
    const phase = new WorktreeReadPhase(repository);
    expect(await readBaseAssociation(repository, tree, phase)).toEqual({ kind: "assigned", ref: "refs/heads/trunk" });
    const refs = await git(primary, "show-ref");
    await rm(join(linked, ".git"));
    await writeFile(join(linked, ".git"), await readFile(join(sibling, ".git")));
    expect(await readBaseAssociation(repository, tree, new WorktreeReadPhase(repository)))
      .toEqual({ kind: "invalid", reason: "stale" });
    expect(await readBaseAssociation(repository, tree)).toEqual({ kind: "invalid", reason: "stale" });
    await expect(writeBaseAssociation(repository, tree, "refs/heads/trunk")).rejects.toThrow(/verify/);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await readFile(join(sibling, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await readFile(join(linked, "tracked.txt"), "utf8")).toBe("original\n");
  });
});
