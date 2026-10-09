import { expect, test } from "bun:test";
import { execa } from "execa";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepositoryConfig } from "../src/config";
import { repositoryFixture } from "./helpers/services";

test("returns normalized defaults when .timber.toml is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber config "));
  try {
    expect(await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }))).toEqual({
      baseBranch: null,
      remote: null,
      worktreeDir: null,
      editor: null,
      agent: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads the primary root config from nested and linked-worktree contexts", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber config "));
  const primaryRoot = join(root, "primary repo");
  const linked = join(root, "linked worktree");
  try {
    await execa("git", ["init", primaryRoot]);
    await execa("git", ["-C", primaryRoot, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await execa("git", [
      "-C", primaryRoot,
      "-c", "user.name=Timber Test",
      "-c", "user.email=timber-test@example.invalid",
      "commit", "--allow-empty", "-m", "initial",
    ]);
    await execa("git", ["-C", primaryRoot, "worktree", "add", "-b", "feature", linked]);
    await mkdir(join(primaryRoot, "nested"));
    await writeFile(join(primaryRoot, ".timber.toml"), 'base_branch = "main"\n');
    await writeFile(join(primaryRoot, "nested", ".timber.toml"), 'base_branch = "nested"\n');
    await writeFile(join(linked, ".timber.toml"), 'base_branch = "linked"\n');
    const nested = repositoryFixture({
      primaryWorktreeRoot: primaryRoot,
      currentWorktreeRoot: join(primaryRoot, "nested"),
      commonGitDir: join(primaryRoot, ".git"),
    });
    const linkedContext = repositoryFixture({
      primaryWorktreeRoot: primaryRoot,
      currentWorktreeRoot: linked,
      commonGitDir: join(primaryRoot, ".git"),
      currentBranch: "feature",
    });
    expect((await loadRepositoryConfig(nested)).baseBranch).toBe("main");
    expect((await loadRepositoryConfig(linkedContext)).baseBranch).toBe("main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
