import { expect } from "bun:test";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git } from "./git";
import { writeBaseAssociation } from "../../src/git/base-metadata";
import { discoverRepository } from "../../src/git/repository";
import { listWorktrees } from "../../src/git/worktrees";

// Shared fixtures for the tests/done-*.integration.test.ts files.
export const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
export const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, "done", ...args], {
  cwd, reject: false, timeout: 30_000, env: { CI: "true" },
});

export async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export async function snapshot(primary: string) {
  return {
    refs: await git(primary, "for-each-ref", "--format=%(refname)%00%(objectname)"),
    trees: await git(primary, "worktree", "list", "--porcelain", "-z"),
    primaryFile: await readFile(join(primary, "tracked.txt"), "utf8"),
  };
}

export async function target(primary: string, directory: string, branch = "feature/one") {
  await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n');
  const path = join(directory, `manual ${branch.replaceAll("/", "-")}`);
  await git(primary, "worktree", "add", "-b", branch, path);
  return path;
}

export async function commit(path: string, name = "feature.txt", message = "feature commit") {
  await writeFile(join(path, name), "feature bytes\n");
  await git(path, "add", "--", name);
  await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(path, "rev-parse", "HEAD");
}

export async function upstream(primary: string, directory: string, path: string, branch = "feature/one") {
  const remote = join(directory, "upstream.git");
  await git(directory, "init", "--bare", remote);
  await git(primary, "remote", "add", "backup", remote);
  await git(path, "push", "--set-upstream", "backup", branch);
  return remote;
}

export async function retained(primary: string, path: string, before: Awaited<ReturnType<typeof snapshot>>) {
  expect(await absent(path)).toBe(false);
  expect(await snapshot(primary)).toEqual(before);
}

export async function removed(primary: string, path: string, branch: string | null, deleted: boolean) {
  expect(await absent(path)).toBe(true);
  expect(await git(primary, "worktree", "list", "--porcelain")).not.toContain(`worktree ${path}\n`);
  if (branch !== null) {
    const ref = await execa("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: primary, reject: false });
    expect(ref.exitCode).toBe(deleted ? 1 : 0);
  }
  expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("original\n");
}

export async function saveBase(primary: string, path: string, ref: string) {
  const repository = await discoverRepository(primary);
  const tree = (await listWorktrees(repository)).find(tree => tree.path === path)!;
  await writeBaseAssociation(repository, tree, ref);
  return join(await git(path, "rev-parse", "--absolute-git-dir"), "timber", "base.json");
}

export async function mergedIntoParent(primary: string, directory: string, squash = false, rebase = false) {
  await git(primary, "checkout", "-b", "feature/parent");
  await commit(primary, "parent.txt", "parent work absent from trunk");
  const path = await target(primary, directory);
  const child = await commit(path);
  if (rebase) {
    await commit(primary, "parent-next.txt", "advance parent");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "cherry-pick", child);
  } else {
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid",
      "merge", squash ? "--squash" : "--ff-only", "feature/one");
  }
  if (squash) await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "integrate child");
  return { path, child };
}
