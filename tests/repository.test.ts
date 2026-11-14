import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { discoverRepository } from "../src/git/repository";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout;
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  // Git reports resolved paths; macOS temporary directories sit behind a symlink.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "timber repository ")));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("nested and linked paths share repository identity but retain distinct worktree roots", async () => {
  await withTempDir(async directory => {
    const primary = join(directory, "primary repo");
    const nested = join(primary, "folder with spaces", "deeper");
    const linked = join(directory, "linked feature tree");
    await mkdir(nested, { recursive: true });
    await git(primary, "init", "-b", "trunk");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init");
    await git(primary, "worktree", "add", "-b", "feature/ticket", linked);
    const linkedNested = join(linked, "nested path");
    await mkdir(linkedNested);

    const fromPrimary = await discoverRepository(nested);
    const fromLinked = await discoverRepository(linkedNested);

    expect(fromPrimary).toEqual({
      currentWorktreeRoot: primary,
      primaryWorktreeRoot: primary,
      commonGitDir: join(primary, ".git"),
      currentBranch: "trunk",
      remotes: [],
    });
    expect(fromLinked).toEqual({
      currentWorktreeRoot: linked,
      primaryWorktreeRoot: primary,
      commonGitDir: fromPrimary.commonGitDir,
      currentBranch: "feature/ticket",
      remotes: [],
    });

    await git(linked, "checkout", "--detach");
    expect((await discoverRepository(linked)).currentBranch).toBeNull();
  });
});

test("non-repository and bare repository fail clearly without changing files or refs", async () => {
  await withTempDir(async directory => {
    const outside = join(directory, "outside");
    const marker = join(outside, "keep.txt");
    await mkdir(outside);
    await writeFile(marker, "untouched");
    await expect(discoverRepository(outside)).rejects.toThrow(/not a Git repository/i);
    await expect(discoverRepository(join(directory, "missing"))).rejects.toThrow(/cannot access directory/i);
    await expect(discoverRepository(marker)).rejects.toThrow(/not a directory/i);
    expect(await readFile(marker, "utf8")).toBe("untouched");

    const bare = join(directory, "bare.git");
    await mkdir(bare);
    await git(bare, "init", "--bare", "-b", "trunk");
    const beforeHead = await readFile(join(bare, "HEAD"), "utf8");
    await expect(discoverRepository(bare)).rejects.toThrow(/bare.*unsupported/i);
    expect(await readFile(join(bare, "HEAD"), "utf8")).toBe(beforeHead);
  });
});

test("primary root is read from Git when Git metadata lives elsewhere", async () => {
  await withTempDir(async directory => {
    const primary = join(directory, "working files");
    const gitDir = join(directory, "external metadata.git");
    await mkdir(primary);
    await git(primary, "init", "-b", "trunk", "--separate-git-dir", gitDir);

    const context = await discoverRepository(primary);
    expect(context.currentWorktreeRoot).toBe(primary);
    expect(context.primaryWorktreeRoot).toBe(primary);
    expect(context.commonGitDir).toBe(gitDir);

    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init");
    const linked = join(directory, "linked tree");
    await git(primary, "worktree", "add", "-b", "feature", linked);
    await expect(discoverRepository(linked)).rejects.toThrow(/could not locate primary worktree.*separate Git metadata/i);
  });
});

test("unborn branch has a name and remote defaults come only from local Git refs", async () => {
  await withTempDir(async directory => {
    const repository = join(directory, "unborn repo");
    await mkdir(repository);
    await git(repository, "init", "-b", "waiting");
    await git(repository, "remote", "add", "upstream", join(directory, "remote with spaces.git"));
    await git(repository, "remote", "add", "backup", join(directory, "backup.git"));

    expect(await discoverRepository(repository)).toEqual({
      currentWorktreeRoot: repository,
      primaryWorktreeRoot: repository,
      commonGitDir: join(repository, ".git"),
      currentBranch: "waiting",
      remotes: [
        { name: "backup", defaultBranchRef: null },
        { name: "upstream", defaultBranchRef: null },
      ],
    });

    await git(repository, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk");
    expect((await discoverRepository(repository)).remotes).toEqual([
      { name: "backup", defaultBranchRef: null },
      { name: "upstream", defaultBranchRef: "refs/remotes/upstream/trunk" },
    ]);
  });
});
