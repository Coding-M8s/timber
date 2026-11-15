import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const editorStub = fileURLToPath(new URL("./fixtures/editor-stub.ts", import.meta.url));

const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, "new", ...args], {
  cwd, reject: false, timeout: 5_000, env: { CI: "true" },
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

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { return await readFile(path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await Bun.sleep(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
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

test("new applies --base ahead of configured base_branch", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "checkout", "-b", "selected");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid",
      "commit", "--allow-empty", "-m", "selected commit");
    const selected = await git(primary, "rev-parse", "selected");
    await git(primary, "checkout", "trunk");
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n');

    const result = await cli(primary, "feature/selected", "--base", "selected");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(await git(join(directory, "primary repo-worktrees", "feature-selected"), "rev-parse", "HEAD"))
      .toBe(selected);
  });
});

test("new creates a normalized sentence branch at its safe path from the selected base", async () => {
  await withRepository(async (primary, directory) => {
    const base = await git(primary, "rev-parse", "trunk");
    const target = join(directory, "primary repo-worktrees", "investigate-slow-api-usage-page");

    const result = await cli(
      primary, "--base", "trunk", "--no-editor", "Investigate", "slow", "API", "usage", "page",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`Created investigate-slow-api-usage-page at ${target}`);
    expect(await git(primary, "rev-parse", "refs/heads/investigate-slow-api-usage-page")).toBe(base);
    expect(await git(target, "rev-parse", "HEAD")).toBe(base);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("new in linked worktree reads primary config for base and destination", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "linked checkout");
    await git(primary, "worktree", "add", "-b", "context", linked);
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\nworktree_dir = "../custom space"\n');
    await writeFile(join(linked, ".timber.toml"), "invalid [ toml");
    const nested = join(linked, "nested");
    await mkdir(nested);
    const target = join(directory, "custom space", "feature-from-linked");

    const result = await cli(nested, "feature/from-linked");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(target);
    expect(await git(target, "rev-parse", "HEAD")).toBe(await git(primary, "rev-parse", "trunk"));
  });
});

test("new starts configured editor in created worktree; --no-editor skips it", async () => {
  await withRepository(async (primary, directory) => {
    const capture = join(directory, "editor capture.json");
    const heartbeat = join(directory, "editor heartbeat");
    await writeFile(join(primary, ".timber.toml"), [
      "[editor]",
      `command = ${JSON.stringify(process.execPath)}`,
      "enabled = true",
      `args = [${[editorStub, "linger", capture, heartbeat, "--literal=$HOME"].map(value => JSON.stringify(value)).join(", ")}]`,
      "",
    ].join("\n"));

    const skipped = await cli(primary, "feature/skipped", "--base", "trunk", "--no-editor");
    expect(skipped.exitCode).toBe(0);
    expect(await absent(capture)).toBe(true);

    const opened = await cli(primary, "feature/opened", "--base", "trunk");
    expect(opened.exitCode).toBe(0);
    expect(opened.stderr).toBe("");
    const target = join(directory, "primary repo-worktrees", "feature-opened");
    expect(JSON.parse(await waitForFile(capture))).toEqual({
      args: ["--literal=$HOME", target], cwd: target,
    });
  });
});

test("new keeps a configured editor off by default and --editor starts it on demand", async () => {
  await withRepository(async (primary, directory) => {
    const capture = join(directory, "editor opt-in capture.json");
    const heartbeat = join(directory, "editor opt-in heartbeat");
    await writeFile(join(primary, ".timber.toml"), [
      "[editor]", `command = ${JSON.stringify(process.execPath)}`,
      `args = [${[editorStub, "capture", capture, heartbeat].map(value => JSON.stringify(value)).join(", ")}]`,
    ].join("\n"));

    const skipped = await cli(primary, "feature/default-off", "--base", "trunk");
    expect(skipped.exitCode).toBe(0);
    await Bun.sleep(100);
    expect(await absent(capture)).toBe(true);

    const launched = await cli(primary, "feature/explicit-on", "--base", "trunk", "--editor");
    expect(launched.exitCode).toBe(0);
    const target = join(directory, "primary repo-worktrees", "feature-explicit-on");
    expect(JSON.parse(await waitForFile(capture))).toEqual({ args: [target], cwd: target });
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

test("new safely renders invalid branch controls without changing Git state", async () => {
  await withRepository(async primary => {
    const refs = await git(primary, "show-ref");
    const inventory = await git(primary, "worktree", "list", "--porcelain", "-z");
    const tracked = await readFile(join(primary, "tracked.txt"), "utf8");
    const result = await cli(primary, "bad\u001b[2J\nbranch", "--base", "trunk");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid branch name");
    expect(result.stderr).toContain("\\u001b");
    expect(result.stderr).toContain("\\n");
    expect(result.stderr).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    expect(result.stderr.split("\n")).toHaveLength(1);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(inventory);
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe(tracked);
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
      timeout: 5_000,
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
