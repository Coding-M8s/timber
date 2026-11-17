import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withArena } from "./helpers/arena";
import { git } from "./helpers/git";
import { summarizeArenaAttempt } from "../src/arena/summary";

test("pick summary separates committed, uncommitted and untracked work", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[0]!;
    await writeFile(join(a.path, "tracked.txt"), "committed\n");
    await git(a.path, "add", "tracked.txt");
    await git(a.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "attempt");
    await writeFile(join(a.path, "tracked.txt"), "staged\n");
    await git(a.path, "add", "tracked.txt");
    await writeFile(join(a.path, "tracked.txt"), "original\n");
    await writeFile(join(a.path, "untracked.txt"), "keep\n");
    const summary = await summarizeArenaAttempt(f.repository, f.manifest, a);
    expect(summary.kind).toBe("available");
    if (summary.kind !== "available") throw new Error(summary.reason);
    // Local edits cancel the commit: net tracked diff is empty but the attempt is not.
    expect(summary.commits).toBe(1);
    expect(summary.committed).toEqual({ files: 1, insertions: 1, deletions: 1 });
    expect(summary.uncommitted).toEqual({ files: 1, insertions: 1, deletions: 1 });
    expect(summary.untracked).toBe(1);
  });
});

test("pick summary reports stale identities instead of reading replacement paths", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[0]!;
    await git(f.primary, "worktree", "remove", a.path);
    expect((await summarizeArenaAttempt(f.repository, f.manifest, a)).kind).toBe("unavailable");
  });
});
