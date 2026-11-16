import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, withRepository } from "./helpers/git";
import { absent, cli, removed, retained, snapshot, target, upstream } from "./helpers/done";

test("done selects a merged manual worktree by ticket and preserves unrelated work and remote refs", async () => {
  await withRepository(async (primary, directory) => {
    const branch = "TIM-42-complete";
    const path = await target(primary, directory, branch);
    const pushedOid = await git(path, "rev-parse", "HEAD");
    const other = await target(primary, directory, "TIM-420-unrelated");
    await writeFile(join(other, "tracked.txt"), "unrelated dirty bytes\n");
    const remote = await upstream(primary, directory, path, branch);
    const remoteRefs = await git(remote, "show-ref");
    const otherOid = await git(other, "rev-parse", "HEAD");
    const nested = join(primary, "nested");
    await mkdir(nested);

    const result = await cli(nested, "TIM-42");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Removed worktree at ${path}`);
    expect(result.stdout).toContain(`Deleted local branch ${branch}`);
    await removed(primary, path, branch, true);
    expect(await readFile(join(other, "tracked.txt"), "utf8")).toBe("unrelated dirty bytes\n");
    expect(await git(other, "rev-parse", "HEAD")).toBe(otherOid);
    expect(await git(remote, "show-ref")).toBe(remoteRefs);
    expect(await git(primary, "rev-parse", "refs/remotes/backup/TIM-42-complete")).toBe(pushedOid);
  });
});

test("done from its own nested worktree uses primary config and keeps the branch explicitly", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const nested = join(path, "nested");
    await mkdir(nested);
    await writeFile(join(path, ".timber.toml"), "invalid [ toml");
    await git(primary, "config", "--add", "core.excludesFile", join(directory, "excludes"));
    await writeFile(join(directory, "excludes"), ".timber.toml\n");
    const refs = (await snapshot(primary)).refs;

    const result = await cli(nested, "feature/one", "--keep-branch", "--discard-ignored");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Retained local branch feature/one");
    expect(result.stdout).not.toContain("Deleted");
    await removed(primary, path, "feature/one", false);
    expect((await snapshot(primary)).refs).toBe(refs);
  });
});

test("done refuses primary-path targets without erasing files or refs", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const before = await snapshot(primary);
    const result = await cli(primary, primary, "--keep-branch", "--discard-ignored");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/primary/);
    expect(result.stderr).not.toContain("Cannot open");
    expect(await snapshot(primary)).toEqual(before);
    expect(await absent(path)).toBe(false);
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("done refuses ambiguous prefixes, unchecked branches, and unknown paths without creating or deleting worktrees", async () => {
  await withRepository(async (primary, directory) => {
    const first = await target(primary, directory, "TIM-42-first");
    const second = await target(primary, directory, "TIM-42-second");
    await git(primary, "branch", "unchecked");
    const remote = await upstream(primary, directory, first, "TIM-42-first");
    await git(primary, "push", "backup", "trunk:remote-only");
    const remoteRefs = await git(remote, "show-ref");
    const before = await snapshot(primary);
    for (const [input, diagnostic] of [
      ["TIM-42", /multiple/], ["unchecked", /no registered worktree/],
      ["backup/remote-only", /no registered worktree/],
      ["unknown", /[Nn]o .*matches/], [join(directory, "unregistered"), /[Nn]o .*matches/],
      [" ", /[Pp]rovide/],
    ] as const) {
      const result = await cli(primary, input);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(diagnostic);
      if (input === "TIM-42") {
        expect(result.stderr).toContain(first);
        expect(result.stderr).toContain(second);
        expect(result.stderr).toContain("exact branch name or absolute worktree path");
      }
      await retained(primary, first, before);
      expect(await readFile(join(second, "tracked.txt"), "utf8")).toBe("original\n");
      expect(await git(remote, "show-ref")).toBe(remoteRefs);
    }
  });
});

test("done ignores a remote-only prefix match while retaining cleanup safeguards", async () => {
  await withRepository(async (primary, directory) => {
    const branch = "ENG-835-pilot";
    const path = await target(primary, directory, branch);
    const remote = await upstream(primary, directory, path, branch);
    await git(primary, "push", "backup", "trunk:ENG-835-rest");
    const remoteRefs = await git(remote, "show-ref");
    const result = await cli(primary, "ENG-835");
    expect(result.exitCode).toBe(0);
    await removed(primary, path, branch, true);
    expect(await git(remote, "show-ref")).toBe(remoteRefs);
    expect(await git(primary, "rev-parse", "refs/remotes/backup/ENG-835-rest")).toBe(await git(primary, "rev-parse", "trunk"));
  });
});
