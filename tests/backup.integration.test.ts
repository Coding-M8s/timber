import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, ...args: string[]) => execa(process.execPath, ["--no-env-file", entry, ...args], {
  cwd, reject: false, timeout: 15_000, env: { CI: "true", GIT_EDITOR: "false" },
});

const secret = "SYNTHETIC_TOKEN=not-a-real-secret\n";

async function backupIds(primary: string): Promise<string[]> {
  try { return (await readdir(join(primary, ".git/timber/backups"))).sort(); }
  catch { return []; }
}

async function backupRefs(primary: string): Promise<string> {
  return git(primary, "for-each-ref", "--format=%(refname) %(objectname)", "refs/timber/");
}

async function refs(primary: string): Promise<string> {
  return git(primary, "for-each-ref", "--format=%(refname) %(objectname)");
}

/** A linked worktree with a local commit plus modified, untracked, ignored, executable and linked content. */
async function populated(primary: string, directory: string) {
  const target = join(directory, "feature worktree");
  await git(primary, "worktree", "add", "-b", "TIM-119-feature", target);
  await writeFile(join(target, "committed.txt"), "committed on feature\n");
  await git(target, "add", "committed.txt");
  await git(target, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "feature work");
  const commit = await git(target, "rev-parse", "HEAD");
  await writeFile(join(target, "tracked.txt"), "modified but not staged\n");
  await writeFile(join(target, "untracked note.txt"), "untracked\n");
  await writeFile(join(target, ".env"), secret);
  await writeFile(join(target, "run.sh"), "#!/bin/sh\necho synthetic\n");
  await chmod(join(target, "run.sh"), 0o755);
  await mkdir(join(target, "empty", "nested"), { recursive: true });
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "unrelated.txt"), "must not be copied\n");
  await symlink(outside, join(target, "outside link"));
  await symlink("tracked.txt", join(target, "relative link"));
  return { target, commit, outside };
}

function createdId(stdout: string): string {
  const id = /^Backup created: (\S+)$/mu.exec(stdout)?.[1];
  if (!id) throw new Error(`No backup ID in output:\n${stdout}`);
  return id;
}

test("backup survives worktree removal and restores commits, file bytes, modes and symlinks", async () => {
  await withRepository(async (primary, directory) => {
    const { target, commit } = await populated(primary, directory);
    const created = await cli(primary, "backup", "create", "TIM-119-feature");
    expect(created.stderr).toBe("");
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("Ignored files, including secrets such as .env, were copied");
    expect(created.stdout).not.toContain("SYNTHETIC_TOKEN");
    expect(created.stdout).not.toContain("untracked note");
    const id = createdId(created.stdout);
    expect(id).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/u);
    expect(await backupRefs(primary)).toBe(`refs/timber/backups/${id} ${commit}`);

    // Private storage: every directory 0700 and every file 0600.
    const storage = join(primary, ".git/timber/backups", id);
    for (const path of [join(primary, ".git/timber"), join(primary, ".git/timber/backups"), storage]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
    for (const name of await readdir(storage)) expect((await lstat(join(storage, name))).mode & 0o777).toBe(0o600);
    // No Git administrative data or symlink traversal into unrelated files.
    const manifest = JSON.parse(await readFile(join(storage, "manifest.json"), "utf8")) as { path: string; type: string }[];
    expect(manifest.some(item => item.path.split("/").includes(".git"))).toBe(false);
    expect(manifest.some(item => item.path.includes("unrelated"))).toBe(false);
    expect(manifest.find(item => item.path === "outside link")?.type).toBe("symlink");

    // Ordinary worktree removal discards the source but not the backup.
    await git(primary, "worktree", "remove", "--force", target);
    await git(primary, "branch", "-D", "TIM-119-feature");
    expect(await backupIds(primary)).toEqual([id]);

    const destination = join(directory, "recovered");
    const restored = await cli(primary, "backup", "restore", id, destination);
    expect(restored.stderr).toBe("");
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout).toContain(`Recovery branch: recovery/${id} at ${commit}`);
    expect(await git(destination, "rev-parse", "HEAD")).toBe(commit);
    expect(await git(destination, "symbolic-ref", "HEAD")).toBe(`refs/heads/recovery/${id}`);
    expect(await readFile(join(destination, "committed.txt"), "utf8")).toBe("committed on feature\n");
    expect(await readFile(join(destination, "tracked.txt"), "utf8")).toBe("modified but not staged\n");
    expect(await readFile(join(destination, "untracked note.txt"), "utf8")).toBe("untracked\n");
    expect(await readFile(join(destination, ".env"), "utf8")).toBe(secret);
    expect((await lstat(join(destination, "run.sh"))).mode & 0o777).toBe(0o755);
    expect((await lstat(join(destination, "empty", "nested"))).isDirectory()).toBe(true);
    expect(await readlink(join(destination, "outside link"))).toBe(join(directory, "outside"));
    expect(await readlink(join(destination, "relative link"))).toBe("tracked.txt");
    const status = await git(destination, "status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all");
    expect(status.split("\0").filter(Boolean).sort()).toEqual([
      " M tracked.txt", "!! .env", "?? outside link", "?? relative link", "?? run.sh", "?? untracked note.txt",
    ].sort());
    // The backup itself is unchanged and still restorable elsewhere.
    expect(await backupIds(primary)).toEqual([id]);
  });
});

test("backup excludes nested .git entries and nested registered worktrees", async () => {
  await withRepository(async primary => {
    await mkdir(join(primary, "vendor", "nested", ".git"), { recursive: true });
    await writeFile(join(primary, "vendor", "nested", ".git", "config"), "[core]\n");
    await writeFile(join(primary, "vendor", "nested", "kept.txt"), "kept\n");
    await git(primary, "worktree", "add", "-b", "inner", join(primary, "inner-worktree"));
    await writeFile(join(primary, "inner-worktree", "other.txt"), "belongs to another worktree\n");
    const created = await cli(primary, "backup", "create", primary);
    expect(created.exitCode).toBe(0);
    const id = createdId(created.stdout);
    const manifest = JSON.parse(await readFile(join(primary, ".git/timber/backups", id, "manifest.json"), "utf8")) as { path: string }[];
    const paths = manifest.map(item => item.path);
    expect(paths).toContain("vendor/nested/kept.txt");
    expect(paths.some(path => path.split("/").includes(".git"))).toBe(false);
    expect(paths.some(path => path.startsWith("inner-worktree"))).toBe(false);
  });
});

for (const location of ["selected", "unselected"] as const) {
  test(`backup selection never runs clean filters in the ${location} worktree`, async () => {
    await withRepository(async (primary, directory) => {
      const target = join(directory, "feature worktree");
      await git(primary, "worktree", "add", "-b", "TIM-119-filter", target);
      const filtered = location === "selected" ? target : primary;
      const marker = join(directory, "filter ran");
      await writeFile(join(filtered, ".gitattributes"), "tracked.txt filter=backup-probe\n");
      await git(primary, "config", "filter.backup-probe.clean", `printf invoked >> '${marker}'; cat`);
      // Equal size forces status to hash the file instead of using its size alone.
      await writeFile(join(filtered, "tracked.txt"), "changed!\n");
      const indexPath = await git(filtered, "rev-parse", "--path-format=absolute", "--git-path", "index");
      const index = await readFile(indexPath);
      const branches = await git(primary, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");

      for (const selector of ["TIM-119-filter", target, "TIM-119"]) {
        const created = await cli(primary, "backup", "create", selector);
        expect(created.exitCode).toBe(0);
        expect(created.stderr).toBe("");
        await expect(lstat(marker)).rejects.toThrow();
        expect(await readFile(join(filtered, "tracked.txt"), "utf8")).toBe("changed!\n");
        expect(await readFile(indexPath)).toEqual(index);
        expect(await git(primary, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/")).toBe(branches);
      }
    });
  });
}

test("unsupported files and storage failures never publish a backup or change source state", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await populated(primary, directory);
    const before = await refs(primary);
    const status = await git(target, "status", "--porcelain=v1", "--ignored");
    await execa("mkfifo", [join(target, "pipe")]);
    const fifo = await cli(primary, "backup", "create", target);
    expect(fifo.exitCode).toBe(1);
    expect(fifo.stderr).toContain("unsupported file type");
    expect(fifo.stderr).not.toContain("pipe");
    expect(await backupIds(primary)).toEqual([]);
    expect(await refs(primary)).toBe(before);
    await execa("rm", [join(target, "pipe")]);

    if (process.getuid?.() === 0) return; // Root ignores directory permissions.
    await chmod(join(primary, ".git/timber/backups"), 0o500);
    try {
      const storage = await cli(primary, "backup", "create", target);
      expect(storage.exitCode).toBe(1);
      expect(storage.stderr).toContain("No backup was created");
    } finally { await chmod(join(primary, ".git/timber/backups"), 0o700); }
    expect(await backupIds(primary)).toEqual([]);
    expect(await refs(primary)).toBe(before);
    expect(await git(target, "status", "--porcelain=v1", "--ignored")).toBe(status);
    expect(await readFile(join(target, ".env"), "utf8")).toBe(secret);
  });
});

test("backup refuses in-progress operations and unborn worktrees", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await populated(primary, directory);
    await git(target, "stash", "-u");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base moves");
    await writeFile(join(target, "tracked.txt"), "conflicting feature change\n");
    await git(target, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-am", "conflict");
    await writeFile(join(primary, "tracked.txt"), "conflicting base change\n");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-am", "conflict base");
    const paused = await execa("git", ["rebase", "trunk"], { cwd: target, reject: false, env: { GIT_EDITOR: "true" } });
    expect(paused.exitCode).not.toBe(0);
    const marker = join(directory, "filter ran during paused lookup");
    await writeFile(join(primary, ".gitattributes"), "tracked.txt filter=backup-probe\n");
    await git(primary, "config", "filter.backup-probe.clean", `printf invoked >> '${marker}'; cat`);
    await writeFile(join(primary, "tracked.txt"), "Conflicting base change\n");
    // Selecting by branch maps the paused (detached) worktree so the real refusal is reported.
    const operation = await cli(primary, "backup", "create", "TIM-119-feature");
    expect(operation.exitCode).toBe(1);
    expect(operation.stderr).toContain("operation is in progress");
    await expect(lstat(marker)).rejects.toThrow();
    expect(await backupIds(primary)).toEqual([]);
    await git(target, "rebase", "--abort");

    const unborn = join(directory, "unborn");
    await git(directory, "init", "-b", "trunk", unborn);
    const empty = await cli(unborn, "backup", "create", unborn);
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).not.toBe("");
    expect(await backupIds(unborn)).toEqual([]);
  });
});

test("detached worktrees can be backed up and restored", async () => {
  await withRepository(async (primary, directory) => {
    const target = join(directory, "detached");
    await git(primary, "worktree", "add", "--detach", target);
    await writeFile(join(target, "note.txt"), "detached work\n");
    const created = await cli(primary, "backup", "create", target);
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("Branch: detached HEAD");
    const id = createdId(created.stdout);
    const restored = await cli(primary, "backup", "restore", id, join(directory, "again"));
    expect(restored.exitCode).toBe(0);
    expect(await readFile(join(directory, "again", "note.txt"), "utf8")).toBe("detached work\n");
  });
});

test("restore refuses collisions, tampering, missing refs and incomplete backups without creating anything", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await populated(primary, directory);
    const id = createdId((await cli(primary, "backup", "create", target)).stdout);
    const storage = join(primary, ".git/timber/backups", id);

    const occupied = join(directory, "occupied");
    await mkdir(occupied);
    await writeFile(join(occupied, "keep.txt"), "existing work\n");
    const collision = await cli(primary, "backup", "restore", id, occupied);
    expect(collision.exitCode).toBe(1);
    expect(collision.stderr).toContain("Destination already exists");
    expect(await readdir(occupied)).toEqual(["keep.txt"]);
    expect(await readFile(join(occupied, "keep.txt"), "utf8")).toBe("existing work\n");

    await git(primary, "branch", `recovery/${id}`);
    const branch = await cli(primary, "backup", "restore", id, join(directory, "branch collision"));
    expect(branch.exitCode).toBe(1);
    expect(branch.stderr).toContain("already exists");
    await git(primary, "branch", "-D", `recovery/${id}`);

    const before = await refs(primary);
    const blob = join(storage, "000001");
    const original = await readFile(blob);
    await writeFile(blob, "tampered\n");
    const tampered = await cli(primary, "backup", "restore", id, join(directory, "tampered"));
    expect(tampered.exitCode).toBe(1);
    expect(tampered.stderr).toContain("does not match its manifest");
    await writeFile(blob, original);

    const commit = await git(primary, "rev-parse", `refs/timber/backups/${id}`);
    await git(primary, "update-ref", "-d", `refs/timber/backups/${id}`);
    const missingRef = await cli(primary, "backup", "restore", id, join(directory, "missing ref"));
    expect(missingRef.exitCode).toBe(1);
    expect(missingRef.stderr).toContain("private Git ref");
    await git(primary, "update-ref", `refs/timber/backups/${id}`, commit);

    // A copy left by interrupted creation is never addressable as a backup.
    const incomplete = id.replace(/[0-9a-f]{8}$/u, "00000000");
    await execa("cp", ["-a", storage, join(primary, ".git/timber/backups", `.incomplete-${incomplete}`)]);
    const partial = await cli(primary, "backup", "restore", incomplete, join(directory, "partial"));
    expect(partial.exitCode).toBe(1);
    expect(partial.stderr).toContain("No backup with that ID");

    const gitAdmin = await cli(primary, "backup", "restore", id, join(primary, ".git", "..inside"));
    expect(gitAdmin.exitCode).toBe(1);
    expect(gitAdmin.stderr).toContain("Git directory");
    await expect(lstat(join(primary, ".git", "..inside"))).rejects.toThrow();

    const malformed = await cli(primary, "backup", "restore", "../escape", join(directory, "escape"));
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toContain("Invalid backup ID");

    for (const name of ["tampered", "missing ref", "partial", "escape", "branch collision"]) {
      expect(await Bun.file(join(directory, name)).exists()).toBe(false);
      await expect(lstat(join(directory, name))).rejects.toThrow();
    }
    expect(await refs(primary)).toBe(before);
    expect(await git(primary, "worktree", "list", "--porcelain")).not.toContain("tampered");
  });
});

test("create and restore never run repository hooks or change the source index", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await populated(primary, directory);
    const indexPath = await git(target, "rev-parse", "--path-format=absolute", "--git-path", "index");
    await git(target, "add", "untracked note.txt");
    const index = await readFile(indexPath);
    const marker = join(directory, "hook ran");
    const hooks = join(primary, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    for (const hook of ["post-checkout", "reference-transaction", "post-index-change"]) {
      await writeFile(join(hooks, hook), `#!/bin/sh\ntouch '${marker}'\n`);
      await chmod(join(hooks, hook), 0o755);
    }
    const created = await cli(primary, "backup", "create", target);
    expect(created.exitCode).toBe(0);
    const id = createdId(created.stdout);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(Buffer.compare(await readFile(indexPath), index)).toBe(0);
    const restored = await cli(primary, "backup", "restore", id, join(directory, "hookless"));
    expect(restored.exitCode).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

test("a moved repository keeps its backups restorable", async () => {
  await withRepository(async (primary, directory) => {
    await writeFile(join(primary, ".env"), secret);
    const id = createdId((await cli(primary, "backup", "create", primary)).stdout);
    const moved = join(directory, "moved repo");
    await execa("mv", [primary, moved]);
    const restored = await cli(moved, "backup", "restore", id, join(directory, "from moved"));
    expect(restored.stderr).toBe("");
    expect(restored.exitCode).toBe(0);
    expect(await readFile(join(directory, "from moved", ".env"), "utf8")).toBe(secret);
  });
});

test("sparse checkouts and unreadable files are refused with accurate reasons", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await populated(primary, directory);
    if (process.getuid?.() !== 0) {
      await chmod(join(target, "untracked note.txt"), 0o000);
      const unreadable = await cli(primary, "backup", "create", target);
      expect(unreadable.exitCode).toBe(1);
      expect(unreadable.stderr).toContain("cannot be read");
      expect(unreadable.stderr).not.toContain("untracked note");
      await chmod(join(target, "untracked note.txt"), 0o644);
    }
    await git(target, "sparse-checkout", "set", "--no-cone", "/tracked.txt");
    const sparse = await cli(primary, "backup", "create", target);
    expect(sparse.exitCode).toBe(1);
    expect(sparse.stderr).toContain("Sparse-checkout");
    expect(await backupIds(primary)).toEqual([]);
    expect(await backupRefs(primary)).toBe("");
  });
});

test("a failed recovery worktree creation reports any branch Git left behind", async () => {
  if (process.getuid?.() === 0) return;
  await withRepository(async (primary, directory) => {
    const { target } = await populated(primary, directory);
    const id = createdId((await cli(primary, "backup", "create", target)).stdout);
    const locked = join(directory, "locked parent");
    await mkdir(locked);
    await chmod(locked, 0o500);
    try {
      const failed = await cli(primary, "backup", "restore", id, join(locked, "recovered"));
      expect(failed.exitCode).toBe(1);
      const left = await execa("git", ["show-ref", "--verify", "--quiet", `refs/heads/recovery/${id}`], { cwd: primary, reject: false });
      if (left.exitCode === 0) expect(failed.stderr).toContain(`git branch -D -- 'recovery/${id}'`);
      else expect(failed.stderr).toContain("nothing was restored");
    } finally { await chmod(locked, 0o700); }
    expect(await backupIds(primary)).toEqual([id]);
  });
});
