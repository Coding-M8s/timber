import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const editorStub = fileURLToPath(new URL("./fixtures/editor-stub.ts", import.meta.url));

const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, "new", ...args], {
  cwd, reject: false, timeout: 5_000, env: { CI: "true" },
});

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

test("duplicate branch and slug collision suggest open without changing refs or files", async () => {
  await withRepository(async (primary, directory) => {
    const first = await cli(primary, "feature-one", "--base", "trunk");
    expect(first.exitCode).toBe(0);
    const beforeRefs = await git(primary, "show-ref");
    const beforeTrees = await git(primary, "worktree", "list", "--porcelain", "-z");
    const target = join(directory, "primary repo-worktrees", "feature-one");

    const duplicate = await cli(primary, "feature-one", "--base", "trunk");
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
    await writeFile(join(primary, ".timber.toml"), '[editor]\ncommand = "missing-timber-editor"\n');
    const target = join(directory, "primary repo-worktrees", "feature-retry");

    const result = await cli(primary, "feature/retry", "--base", "trunk");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(`Created feature/retry at ${target}`);
    expect(result.stderr).toContain(target);
    expect(result.stderr).toContain("timber open -- '");
    expect(await git(primary, "rev-parse", "refs/heads/feature/retry")).toBe(await git(target, "rev-parse", "HEAD"));
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
  });
});
