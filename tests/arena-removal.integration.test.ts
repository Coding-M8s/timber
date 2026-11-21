import { expect, test } from "bun:test";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withArena } from "./helpers/arena";
import { git } from "./helpers/git";
import { inspectArenaRemoval } from "../src/arena/summary";

test("removal check reports a registered attempt with its directory as present", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[0]!;
    expect(await inspectArenaRemoval(f.repository, a)).toEqual({ worktree: "present", branch: "present" });
  });
});

test("removal check reports a registered attempt with a missing directory as present", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[0]!;
    await rm(a.path, { recursive: true, force: true });
    expect(await inspectArenaRemoval(f.repository, a)).toEqual({ worktree: "present", branch: "present" });
  });
});

test("removal check reports an unregistered attempt whose directory remains as present", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[0]!;
    await git(f.primary, "worktree", "remove", "--force", a.path);
    await mkdir(a.path);
    expect(await inspectArenaRemoval(f.repository, a)).toEqual({ worktree: "present", branch: "present" });
  });
});

test("removal check reports a removed attempt and deleted branch as absent", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[0]!;
    await git(f.primary, "worktree", "remove", "--force", a.path);
    await git(f.primary, "branch", "-D", a.branch);
    expect(await inspectArenaRemoval(f.repository, a)).toEqual({ worktree: "absent", branch: "absent" });
  });
});

test("removal check reports a deleted and pruned attempt as absent", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[0]!;
    await rm(a.path, { recursive: true, force: true });
    await git(f.primary, "worktree", "prune");
    expect(await inspectArenaRemoval(f.repository, a)).toEqual({ worktree: "absent", branch: "present" });
  });
});

test("removal check keeps the worktree unknown when Git cannot list worktrees", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[0]!;
    await rm(a.path, { recursive: true, force: true });
    const repository = { ...f.repository, currentWorktreeRoot: join(f.directory, "missing current worktree") };
    expect(await inspectArenaRemoval(repository, a)).toEqual({ worktree: "unknown", branch: "present" });
  });
});

test("removal check keeps the worktree unknown when the attempt path cannot be read", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[0]!;
    // A file in the middle of the path gives ENOTDIR, which is not proof of absence.
    const attempt = { ...a, path: join(a.path, "tracked.txt", "child") };
    expect(await inspectArenaRemoval(f.repository, attempt)).toEqual({ worktree: "unknown", branch: "present" });
  });
});

for (const location of ["inspected", "other", "primary"] as const) {
  test(`removal check never runs clean filters in the ${location} worktree`, async () => {
    await withArena(async f => {
      const [inspected, other] = f.manifest.attempts;
      const filtered = location === "inspected" ? inspected!.path : location === "other" ? other!.path : f.primary;
      const marker = join(f.directory, "filter ran");
      await writeFile(join(filtered, ".gitattributes"), "tracked.txt filter=removal-probe\n");
      await git(f.primary, "config", "filter.removal-probe.clean", `printf invoked >> '${marker}'; cat`);
      // Equal size forces status to hash the file instead of using its size alone.
      await writeFile(join(filtered, "tracked.txt"), "changed!\n");
      expect(await inspectArenaRemoval(f.repository, inspected!)).toEqual({ worktree: "present", branch: "present" });
      await expect(lstat(marker)).rejects.toThrow();
    });
  });
}
