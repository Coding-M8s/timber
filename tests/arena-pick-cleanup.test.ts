import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { withArena } from "./helpers/arena";
import { git } from "./helpers/git";
import { validateArenaAttempt } from "../src/arena/storage";
import { cleanupWorktree } from "../src/git/cleanup";

const quiet = { stdout(_s: string) {}, stderr(_s: string) {} };
const options = { keepBranch: false, discardIgnored: true };

for (const dirty of [false, true]) test(`arena policy routes deleted-upstream discard through the preserving callback (dirty=${dirty})`, async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[1]!;
    await writeFile(join(a.path, "tracked.txt"), "unique solution\n");
    await git(a.path, "add", "tracked.txt");
    await git(a.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "unique work");
    const bare = join(f.directory, "remote.git"); await mkdir(bare);
    await git(bare, "init", "--bare");
    await git(f.primary, "remote", "add", "origin", bare);
    await git(a.path, "push", "-u", "origin", a.branch);
    await git(bare, "update-ref", "-d", `refs/heads/${a.branch}`);
    if (dirty) await writeFile(join(a.path, "untracked.txt"), "precious\n");
    const refs = await git(f.primary, "show-ref");
    const tree = await validateArenaAttempt(f.repository, f.manifest, a);
    let asked = 0;
    await expect(cleanupWorktree(f.repository, tree, { ...f.config, baseBranch: "trunk" }, options, quiet,
      async () => { asked++; return false; }, undefined, { confirmEveryDiscard: true })).rejects.toThrow("Cancelled");
    expect(asked).toBe(1);
    expect(await git(f.primary, "show-ref")).toBe(refs);
    expect(await readFile(join(a.path, "tracked.txt"), "utf8")).toBe("unique solution\n");
    if (dirty) expect(await readFile(join(a.path, "untracked.txt"), "utf8")).toBe("precious\n");
  });
});

test("arena cleanup boundary runs after hooks and blocks removal", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[1]!;
    const tree = await validateArenaAttempt(f.repository, f.manifest, a);
    const refs = await git(f.primary, "show-ref");
    await expect(cleanupWorktree(f.repository, tree, { ...f.config, baseBranch: "trunk",
      hooks: { postCreate: [], preDelete: ["printf ran > .env"] } }, options, quiet, undefined, undefined,
      { confirmEveryDiscard: true, beforeRemove: async () => { throw new Error("membership changed"); } })).rejects.toThrow("membership changed");
    expect(existsSync(a.path)).toBe(true);
    expect(await git(f.primary, "show-ref")).toBe(refs);
    expect(await readFile(join(a.path, ".env"), "utf8")).toBe("ran");
  });
});
