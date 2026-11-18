import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitLocation } from "../src/platform/git-location";
import { git } from "./helpers/git";

test("gitLocation classifies worktree, Git directory, symlinked and outside paths", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "timber git-location ")));
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "trunk");
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(repo, join(root, "shortcut"));
    expect(await gitLocation(join(repo, "file"))).toBe("inside");
    expect(await gitLocation(join(repo, ".git/timber/missing/deeper"))).toBe("inside");
    expect(await gitLocation(join(root, "shortcut/file"))).toBe("inside");
    expect(await gitLocation(join(outside, "missing/file"))).toBe("outside");
  } finally { await rm(root, { recursive: true, force: true }); }
});
