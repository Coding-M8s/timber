import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, "new", ...args], {
  cwd, reject: false, timeout: 30_000, env: { CI: "true" },
});

function quotePosix(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

test("new from nested directory creates branch and sibling worktree at base commit", async () => {
  await withRepository(async (primary, directory) => {
    const nested = join(primary, "nested");
    await mkdir(nested);
    await git(primary, "branch", "main");
    const base = await git(primary, "rev-parse", "trunk");
    const target = join(directory, "primary repo-worktrees", "feature-one");

    const result = await cli(nested, "feature/one");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`Created feature/one at ${target}`);
    expect(await git(primary, "rev-parse", "refs/heads/feature/one")).toBe(base);
    expect(await git(target, "rev-parse", "HEAD")).toBe(base);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("new --editor without a configured command preserves refs and worktrees", async () => {
  await withRepository(async (primary) => {
    const refs = await git(primary, "show-ref");
    const worktrees = await git(primary, "worktree", "list", "--porcelain", "-z");
    const result = await cli(primary, "feature/missing-editor", "--base", "trunk", "--editor");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Configure an editor");
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(worktrees);
  });
});

test("duplicate branch and slug collision suggest open without changing refs or files", async () => {
  await withRepository(async (primary, directory) => {
    const first = await cli(primary, "Feature", "one", "--base", "trunk");
    expect(first.exitCode).toBe(0);
    const beforeRefs = await git(primary, "show-ref");
    const beforeTrees = await git(primary, "worktree", "list", "--porcelain", "-z");
    const target = join(directory, "primary repo-worktrees", "feature-one");

    const duplicate = await cli(primary, "  FEATURE   ONE  ", "--base", "trunk");
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toContain("timber open");
    const collision = await cli(primary, "feature/one", "--base", "trunk");
    expect(collision.exitCode).toBe(1);
    expect(collision.stderr).toContain("Worktree path already exists");
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await git(primary, "show-ref")).toBe(beforeRefs);
    expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(beforeTrees);
  });
});

test("existing destination, invalid branch, and ambiguous base leave refs and files intact", async () => {
  await withRepository(async (primary, directory) => {
    const root = join(directory, "primary repo-worktrees");
    await mkdir(root);
    const target = join(root, "feature-existing");
    await writeFile(target, "keep me\n");
    await git(primary, "branch", "main");
    await git(primary, "branch", "master");
    const beforeRefs = await git(primary, "show-ref");

    const existing = await cli(primary, "feature/existing", "--base", "trunk");
    expect(existing.exitCode).toBe(1);
    expect(existing.stderr).toContain("Worktree path already exists");
    const invalid = await cli(primary, "--base", "trunk", "--", "-bad");
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("Invalid branch name");
    const ambiguous = await cli(primary, "feature/ambiguous");
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain("Base branch is ambiguous");
    expect(await readFile(target, "utf8")).toBe("keep me\n");
    expect(await absent(join(root, "feature-ambiguous"))).toBe(true);
    expect(await git(primary, "show-ref")).toBe(beforeRefs);
  });
});

test("editor startup failure retains created worktree and gives retry command", async () => {
  await withRepository(async (primary, directory) => {
    await writeFile(join(primary, ".timber.toml"), '[editor]\ncommand = "missing-timber-editor"\nenabled = false\n');
    const target = join(directory, "primary repo-worktrees", "feature-retry");

    const result = await cli(primary, "feature/retry", "--base", "trunk", "--editor");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(`Created feature/retry at ${target}`);
    expect(result.stderr).toContain(target);
    expect(result.stderr).toContain("timber open --editor -- '");
    expect(await git(primary, "rev-parse", "refs/heads/feature/retry")).toBe(await git(target, "rev-parse", "HEAD"));
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("new editor failure safely renders and executes retry for a control-character path", async () => {
  await withRepository(async (primary, directory) => {
    const worktreeRoot = join(directory, "worktrees \u001b[2J\npath");
    await writeFile(join(primary, ".timber.toml"), [
      `worktree_dir = ${JSON.stringify(worktreeRoot)}`,
      "",
      "[editor]",
      'command = "missing-timber-editor"',
      "enabled = false",
      "",
    ].join("\n"));
    const target = join(worktreeRoot, "feature-retry-control");

    const created = await cli(primary, "feature/retry-control", "--base", "trunk", "--editor");
    expect(created.exitCode).toBe(1);
    expect(created.stdout).toContain("\\u001b");
    expect(created.stdout).toContain("\\n");
    expect(created.stderr).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    expect(created.stderr.split("\n")).toHaveLength(1);

    const retryCommand = created.stderr.match(/retry with: (timber open --editor -- .+)$/u)?.[1];
    expect(retryCommand).toBeDefined();
    if (retryCommand === undefined) throw new Error("Expected a Bash retry command");

    const binDirectory = join(directory, "bin");
    await mkdir(binDirectory);
    const timberWrapper = join(binDirectory, "timber");
    await writeFile(timberWrapper,
      `#!/bin/sh\nexec ${quotePosix(process.execPath)} ${quotePosix(entry)} "$@"\n`);
    await chmod(timberWrapper, 0o755);
    const retried = await execa("/bin/bash", ["-c", retryCommand], {
      cwd: primary,
      env: { CI: "true", PATH: `${binDirectory}:${process.env.PATH ?? ""}` },
      reject: false,
      timeout: 30_000,
    });

    expect(retried.exitCode).toBe(0);
    expect(retried.stdout).toContain(`Opened existing worktree at ${JSON.stringify(target)}`);
    expect(retried.stderr).toContain("Could not start the configured editor");
    expect(await git(primary, "rev-parse", "refs/heads/feature/retry-control"))
      .toBe(await git(target, "rev-parse", "HEAD"));
  });
});

test("new refuses a repository with no commits, with and without --base, and creates nothing", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "timber unborn ")));
  const primary = join(directory, "empty repo");
  try {
    await mkdir(primary);
    await git(primary, "init", "-b", "trunk");
    await writeFile(join(primary, "draft.txt"), "untracked draft\n");
    const headBefore = await readFile(join(primary, ".git", "HEAD"), "utf8");

    for (const args of [["Fix login bug"], ["Fix login bug", "--base", "master"], ["Fix login bug", "--base", "trunk"]]) {
      const result = await cli(primary, ...args, "--no-editor", "--no-agent");
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("error: This repository has no commits yet. Make an initial commit, then try again.");
    }

    expect(await git(primary, "for-each-ref")).toBe("");
    expect(await readFile(join(primary, ".git", "HEAD"), "utf8")).toBe(headBefore);
    expect(await readFile(join(primary, "draft.txt"), "utf8")).toBe("untracked draft\n");
    expect(await git(primary, "worktree", "list", "--porcelain")).not.toContain("fix-login-bug");
    expect((await readdir(directory)).sort()).toEqual(["empty repo"]);
    expect(await absent(join(directory, "empty repo-worktrees"))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new keeps the generic base diagnostic for an orphan checkout in a repository with commits", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "checkout", "--orphan", "orphan");
    const before = await git(primary, "show-ref");

    const result = await cli(primary, "feature/orphan", "--no-editor", "--no-agent");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("error: Could not find a base branch. Use --base or configure base_branch.");
    expect(await git(primary, "show-ref")).toBe(before);
    expect(await absent(join(directory, "primary repo-worktrees"))).toBe(true);
  });
});

test("new keeps the generic base diagnostic when only tags hold commits", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "tag", "v1");
    await git(primary, "checkout", "--orphan", "orphan");
    await git(primary, "branch", "-D", "trunk");
    const before = await git(primary, "show-ref");

    const result = await cli(primary, "feature/tagged", "--no-editor", "--no-agent");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("error: Could not find a base branch. Use --base or configure base_branch.");
    expect(await git(primary, "show-ref")).toBe(before);
    expect(await absent(join(directory, "primary repo-worktrees"))).toBe(true);
  });
});
