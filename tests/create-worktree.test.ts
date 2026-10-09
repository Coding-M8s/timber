import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { createWorktree } from "../src/git/create-worktree";
import { resolveBase } from "../src/git/branches";
import { discoverRepository } from "../src/git/repository";
import type { RepositoryConfig, RemoteBranch } from "../src/types";
import { git, withRepository } from "./helpers/git";

const config = (worktreeDir: string | null = null): RepositoryConfig => ({
  baseBranch: null, remote: null, worktreeDir, editor: null, agent: null,
});

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

const raceRunner = fileURLToPath(new URL("./fixtures/create-worktree-runner.ts", import.meta.url));

async function runWithFilesystemRace(
  primary: string, directory: string, action: "empty-target" | "symlink-root", root: string,
) {
  const wrapperDirectory = join(directory, "git wrapper");
  await mkdir(wrapperDirectory);
  const realGit = (await execa("which", ["git"])).stdout;
  const wrapper = join(wrapperDirectory, "git");
  await writeFile(wrapper, [
    "#!/bin/sh",
    'if [ "$1" = worktree ] && [ "$2" = list ] && [ ! -e "$TIMBER_RACE_MARKER" ]; then',
    '  : > "$TIMBER_RACE_MARKER"',
    '  if [ "$TIMBER_RACE_ACTION" = empty-target ]; then mkdir "$TIMBER_RACE_TARGET"; fi',
    '  if [ "$TIMBER_RACE_ACTION" = symlink-root ]; then ln -s "$TIMBER_RACE_PRIMARY" "$TIMBER_RACE_ROOT"; fi',
    "fi",
    'exec "$TIMBER_REAL_GIT" "$@"',
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);
  const repository = await discoverRepository(primary);
  const base = await resolveBase(repository, config(), "trunk");
  const branch = `feature/${action}`;
  const target = join(root, `feature-${action}`);
  const inputPath = join(directory, "runner-input.json");
  await writeFile(inputPath, JSON.stringify({ repository, request: { kind: "new", branch, base }, config: config(root) }));
  const result = await execa(process.execPath, [raceRunner, inputPath], {
    cwd: primary, reject: false,
    env: {
      ...process.env,
      PATH: `${wrapperDirectory}:${process.env.PATH ?? ""}`,
      TIMBER_REAL_GIT: realGit,
      TIMBER_RACE_ACTION: action,
      TIMBER_RACE_MARKER: join(directory, "race-fired"),
      TIMBER_RACE_PRIMARY: primary,
      TIMBER_RACE_ROOT: root,
      TIMBER_RACE_TARGET: target,
    },
  });
  return { result, target, branch };
}

test("new branch uses pinned base commit and default sibling path", async () => {
  await withRepository(async (primary, directory) => {
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config(), "trunk");
    const result = await createWorktree(repository, { kind: "new", branch: "feature/one", base }, config());
    const target = join(directory, "primary repo-worktrees", "feature-one");
    expect(result).toMatchObject({ path: target, branch: "feature/one", isPrimary: false, pathExists: true });
    expect(await git(primary, "rev-parse", "refs/heads/feature/one")).toBe(base.commit);
    expect(await git(target, "rev-parse", "HEAD")).toBe(base.commit);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("local branch creation uses configured directory and retains existing branch commit", async () => {
  await withRepository(async (primary, directory) => {
    const targetRoot = join(directory, "configured worktrees");
    await git(primary, "branch", "feature/local");
    const repository = await discoverRepository(primary);
    const before = await git(primary, "rev-parse", "refs/heads/feature/local");
    const result = await createWorktree(repository, {
      kind: "local", branch: { kind: "local", name: "feature/local", ref: "refs/heads/feature/local", upstream: null },
    }, config(targetRoot));
    expect(result.path).toBe(join(targetRoot, "feature-local"));
    expect(result.branch).toBe("feature/local");
    expect(await git(primary, "rev-parse", "refs/heads/feature/local")).toBe(before);
  });
});

test("remote mode refreshes selected ref and creates tracking branch", async () => {
  await withRepository(async (primary, directory) => {
    const bare = join(directory, "upstream.git");
    await git(directory, "init", "--bare", bare);
    await git(primary, "remote", "add", "upstream", bare);
    await git(primary, "branch", "feature/remote");
    await git(primary, "push", "upstream", "feature/remote");
    const stale = await git(primary, "rev-parse", "refs/heads/feature/remote");
    await git(primary, "checkout", "feature/remote");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "remote update");
    const fresh = await git(primary, "rev-parse", "HEAD");
    await git(primary, "push", "upstream", "feature/remote");
    await git(primary, "checkout", "trunk");
    await git(primary, "branch", "-D", "feature/remote");
    await git(primary, "update-ref", "refs/remotes/upstream/feature/remote", stale);
    const repository = await discoverRepository(primary);
    const branch: RemoteBranch = { kind: "remote", remote: "upstream", name: "feature/remote", ref: "refs/remotes/upstream/feature/remote" };
    const result = await createWorktree(repository, { kind: "remote", branch }, config());
    expect(result.branch).toBe("feature/remote");
    expect(await git(result.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"))
      .toBe("upstream/feature/remote");
    expect(await git(primary, "rev-parse", "refs/heads/feature/remote"))
      .toBe(await git(primary, "rev-parse", branch.ref));
    expect(await git(result.path, "rev-parse", "HEAD")).toBe(fresh);
  });
});

test("existing file, directory, and slug collision preserve contents and refs", async () => {
  await withRepository(async (primary, directory) => {
    const root = join(directory, "targets");
    await mkdir(root);
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config(), "trunk");
    const beforeRefs = await git(primary, "show-ref");
    for (const branch of ["feature/file", "feature/directory"]) {
      const target = join(root, branch.replace("/", "-"));
      if (branch.endsWith("file")) await writeFile(target, "keep file\n");
      else { await mkdir(target); await writeFile(join(target, "keep.txt"), "keep directory\n"); }
      await expect(createWorktree(repository, { kind: "new", branch, base }, config(root)))
        .rejects.toThrow(/path|exists|collision/i);
      expect(await readFile(branch.endsWith("file") ? target : join(target, "keep.txt"), "utf8"))
        .toBe(branch.endsWith("file") ? "keep file\n" : "keep directory\n");
    }
    expect(await git(primary, "show-ref")).toBe(beforeRefs);
    await createWorktree(repository, { kind: "new", branch: "feature-one", base }, config(root));
    await expect(createWorktree(repository, { kind: "new", branch: "feature/one", base }, config(root)))
      .rejects.toThrow(/path|exists|collision/i);
    expect(await absent(join(root, "feature-one", "tracked.txt"))).toBe(false);
    expect(await git(primary, "show-ref", "--verify", "refs/heads/feature-one")).not.toBe("");
    expect(await execa("git", ["show-ref", "--verify", "refs/heads/feature/one"], { cwd: primary, reject: false })
      .then(result => result.exitCode)).not.toBe(0);
  });
});

test("checked-out local branch reports existing path without changing work", async () => {
  await withRepository(async (primary, directory) => {
    const existing = join(directory, "manual linked");
    await git(primary, "worktree", "add", "-b", "feature/busy", existing);
    await writeFile(join(existing, "untracked.txt"), "keep\n");
    const repository = await discoverRepository(primary);
    const refs = await git(primary, "show-ref");
    await expect(createWorktree(repository, {
      kind: "local", branch: { kind: "local", name: "feature/busy", ref: "refs/heads/feature/busy", upstream: null },
    }, config())).rejects.toThrow(existing);
    expect(await readFile(join(existing, "untracked.txt"), "utf8")).toBe("keep\n");
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

test("configured directory cannot target primary repository through direct or symlink path", async () => {
  await withRepository(async (primary, directory) => {
    const link = join(directory, "linked primary");
    await symlink(primary, link);
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config(), "trunk");
    const refs = await git(primary, "show-ref");
    for (const root of [primary, join(primary, "nested"), link]) {
      await expect(createWorktree(repository, { kind: "new", branch: "feature/unsafe", base }, config(root)))
        .rejects.toThrow(/primary|directory|path/i);
    }
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await absent(join(primary, "nested"))).toBe(true);
  });
});

test("external symlink worktree directory creates a verifiable worktree", async () => {
  await withRepository(async (primary, directory) => {
    const physicalRoot = join(directory, "external worktrees");
    const linkedRoot = join(directory, "linked worktrees");
    await mkdir(physicalRoot);
    await symlink(physicalRoot, linkedRoot);
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config(), "trunk");
    const result = await createWorktree(repository, { kind: "new", branch: "feature/external", base }, config(linkedRoot));
    expect(result.path).toBe(join(physicalRoot, "feature-external"));
    expect(result.branch).toBe("feature/external");
    expect(await readFile(join(linkedRoot, "feature-external", "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("traversal-shaped branch input cannot create files outside configured directory", async () => {
  await withRepository(async (primary, directory) => {
    const root = join(directory, "targets");
    const marker = join(directory, "keep.txt");
    await writeFile(marker, "keep\n");
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config(), "trunk");
    const refs = await git(primary, "show-ref");
    await expect(createWorktree(repository, {
      kind: "new", branch: "feature/../../escape", base,
    }, config(root))).rejects.toThrow(/invalid branch/i);
    expect(await readFile(marker, "utf8")).toBe("keep\n");
    expect(await absent(root)).toBe(true);
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

test("failed remote refresh leaves destination and local refs untouched", async () => {
  await withRepository(async (primary, directory) => {
    const bare = join(directory, "upstream.git");
    await git(directory, "init", "--bare", bare);
    await git(primary, "remote", "add", "upstream", bare);
    await git(primary, "branch", "feature/remote");
    await git(primary, "push", "upstream", "feature/remote");
    await git(primary, "branch", "-d", "feature/remote");
    await git(primary, "fetch", "upstream");
    const repository = await discoverRepository(primary);
    await git(primary, "remote", "set-url", "upstream", join(directory, "missing.git"));
    const refs = await git(primary, "show-ref");
    const branch: RemoteBranch = { kind: "remote", remote: "upstream", name: "feature/remote", ref: "refs/remotes/upstream/feature/remote" };
    await expect(createWorktree(repository, { kind: "remote", branch }, config()))
      .rejects.toThrow(/refresh/i);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await absent(join(directory, "primary repo-worktrees", "feature-remote"))).toBe(true);
  });
});

test("failed Git checkout reports any retained worktree and branch without deleting either", async () => {
  await withRepository(async (primary, directory) => {
    const hooks = join(directory, "hooks");
    await mkdir(hooks);
    const hook = join(hooks, "post-checkout");
    await writeFile(hook, "#!/bin/sh\nexit 7\n");
    await chmod(hook, 0o755);
    await git(primary, "config", "core.hooksPath", hooks);
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config(), "trunk");
    const target = join(directory, "primary repo-worktrees", "feature-hook-fails");

    const message = await createWorktree(repository, { kind: "new", branch: "feature/hook-fails", base }, config())
      .then(() => "unexpected success", error => error instanceof Error ? error.message : "unknown error");
    expect(message).toContain("Could not create worktree");
    expect(message).toContain(`Destination currently exists at ${target}`);
    expect(message).toContain("refs/heads/feature/hook-fails currently exists");
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await git(primary, "rev-parse", "refs/heads/feature/hook-fails")).toBe(base.commit);
  });
});

test("interrupted Git creation reports retained state instead of claiming Git is unavailable", async () => {
  await withRepository(async (primary, directory) => {
    const hooks = join(directory, "hooks");
    await mkdir(hooks);
    const hook = join(hooks, "post-checkout");
    await writeFile(hook, '#!/bin/sh\nkill -TERM "$PPID"\n');
    await chmod(hook, 0o755);
    await git(primary, "config", "core.hooksPath", hooks);
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config(), "trunk");
    const target = join(directory, "primary repo-worktrees", "feature-interrupted");

    const message = await createWorktree(repository, { kind: "new", branch: "feature/interrupted", base }, config())
      .then(() => "unexpected success", error => error instanceof Error ? error.message : "unknown error");
    expect(message).toContain("Could not create worktree");
    expect(message).toContain(`Destination currently exists at ${target}`);
    expect(message).toContain("refs/heads/feature/interrupted currently exists");
    expect(message).not.toContain("Git is installed");
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await git(primary, "rev-parse", "refs/heads/feature/interrupted")).toBe(base.commit);
  });
});

test("concurrent duplicate creation has one winner and preserves its worktree", async () => {
  await withRepository(async (primary, directory) => {
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config(), "trunk");
    const request = { kind: "new" as const, branch: "feature/race", base };
    const results = await Promise.allSettled([
      createWorktree(repository, request, config()),
      createWorktree(repository, request, config()),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const target = join(directory, "primary repo-worktrees", "feature-race");
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await git(primary, "rev-parse", "refs/heads/feature/race")).toBe(base.commit);
    expect((await git(primary, "worktree", "list", "--porcelain")).match(/branch refs\/heads\/feature\/race/g))
      .toHaveLength(1);
  });
});

test("directory created after preflight is rejected without adopting it", async () => {
  await withRepository(async (primary, directory) => {
    const root = join(directory, "targets");
    await mkdir(root);
    const refs = await git(primary, "show-ref");
    const { result, target, branch } = await runWithFilesystemRace(primary, directory, "empty-target", root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/path|exists|collision/i);
    expect((await lstat(target)).isDirectory()).toBe(true);
    expect(await absent(join(target, ".git"))).toBe(true);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await execa("git", ["show-ref", "--verify", `refs/heads/${branch}`], { cwd: primary, reject: false })
      .then(output => output.exitCode)).not.toBe(0);
  });
});

test("directory replaced by primary symlink after preflight cannot redirect creation", async () => {
  await withRepository(async (primary, directory) => {
    const root = join(directory, "late symlink");
    const refs = await git(primary, "show-ref");
    const { result, target } = await runWithFilesystemRace(primary, directory, "symlink-root", root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/primary|path|directory/i);
    expect(await lstat(root).then(info => info.isSymbolicLink())).toBe(true);
    expect(await absent(target)).toBe(true);
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});
