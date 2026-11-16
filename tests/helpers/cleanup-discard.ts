import { expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverRepository } from "../../src/git/repository";
import { listWorktrees } from "../../src/git/worktrees";
import type { CleanupOptions, RepositoryConfig } from "../../src/types";
import { git } from "./git";

// Shared fixtures for the tests/cleanup-discard-*.test.ts files.
export const config: RepositoryConfig = { baseBranch: "trunk", remote: null, worktreeDir: null, editor: null, agent: null };
export const options: CleanupOptions = { keepBranch: false, discardIgnored: true };
export const quiet = { stdout: (_text: string) => {}, stderr: (_text: string) => {} };

export async function fixture(primary: string, directory: string, remote = true) {
  const path = join(directory, "review linked");
  const branch = "feature/review";
  await git(primary, "worktree", "add", "-b", branch, path);
  const bare = join(directory, "remote.git");
  if (remote) {
    await git(directory, "init", "--bare", bare);
    await git(primary, "remote", "add", "origin", bare);
    await git(path, "push", "-u", "origin", branch);
  }
  await writeFile(join(path, "local.txt"), "local commit\n");
  await git(path, "add", "local.txt");
  await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "local review edits");
  const repository = await discoverRepository(primary);
  const tree = (await listWorktrees(repository)).find(tree => tree.path === path)!;
  const head = await git(path, "rev-parse", "HEAD");
  return { path, branch, bare, repository, tree, head };
}

export async function dirty(path: string) {
  await writeFile(join(path, "tracked.txt"), "edited\n");
  await writeFile(join(path, "scratch.txt"), "untracked\n");
}

export async function retained(primary: string, path: string, head: string) {
  expect(await git(path, "rev-parse", "HEAD")).toBe(head);
  expect(await git(primary, "rev-parse", "feature/review")).toBe(head);
  expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("edited\n");
  expect(await readFile(join(path, "scratch.txt"), "utf8")).toBe("untracked\n");
  expect(await git(primary, "worktree", "list", "--porcelain")).toContain(path);
}

export async function addModule(primary: string, directory: string) {
  const source = join(directory, "module source");
  await git(directory, "init", "-b", "main", source);
  await writeFile(join(source, "module.txt"), "module baseline\n");
  await writeFile(join(source, ".gitignore"), ".env\n");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "module baseline");
  await git(primary, "-c", "protocol.file.allow=always", "submodule", "add", source, "module");
  await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-am", "add module");
}
