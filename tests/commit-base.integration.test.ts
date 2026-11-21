import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { cli, commit, fixture } from "./helpers/rebase";
import { cli as done, removed, retained, snapshot, target as doneTarget, commit as doneCommit } from "./helpers/done";

const branch = "TIM-28-feature";
const metadata = async (path: string) => join(await git(path, "rev-parse", "--absolute-git-dir"), "timber", "base.json");
const saved = async (path: string) => JSON.parse(await readFile(await metadata(path), "utf8"));
const listed = async (primary: string, path: string) => {
  const result = await cli(primary, "ls", "--json");
  expect(result.exitCode).toBe(0);
  return (JSON.parse(result.stdout).worktrees as { path: string; base: unknown }[]).find(tree => tree.path === path)!.base;
};
/** A commit on top of trunk that no branch, local or remote, contains. */
async function unbranched(primary: string): Promise<string> {
  await git(primary, "checkout", "--quiet", "--detach");
  const pinned = await commit(primary, "pinned.txt", "pinned\n");
  await git(primary, "checkout", "--quiet", "trunk");
  expect(await git(primary, "branch", "--all", "--contains", pinned)).toBe("");
  return pinned;
}
/** Point origin at a path that does not exist, so any fetch or ls-remote fails. */
const offline = (primary: string, directory: string) => git(primary, "remote", "set-url", "origin", join(directory, "absent.git"));
const branches = (primary: string) => git(primary, "for-each-ref", "--format=%(refname) %(objectname)");

test("new accepts a full commit hash that no branch contains and ls reports it as a commit base", async () => {
  await withRepository(async (primary, directory) => {
    await fixture(primary, directory);
    const pinned = await unbranched(primary);
    const result = await cli(primary, "new", "pinned-work", "--base", pinned, "--no-editor", "--no-agent");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const path = (await git(primary, "worktree", "list", "--porcelain")).split("\n\n")
      .find(block => block.includes("branch refs/heads/pinned-work"))!.split("\n")[0]!.slice("worktree ".length);
    expect(await git(path, "rev-parse", "HEAD")).toBe(pinned);
    const record = await saved(path);
    expect(record.commit).toBe(pinned);
    expect(record.ref).toBeUndefined();
    expect(await listed(primary, path)).toEqual({ kind: "commit", commit: pinned });
    const table = await cli(primary, "ls");
    expect(table.stdout).toMatch(new RegExp(`pinned-work +${pinned.slice(0, 12)} +clean`, "u"));
  });
});

test("new refuses an abbreviated, missing or non-commit hash and creates nothing", async () => {
  await withRepository(async (primary, directory) => {
    await fixture(primary, directory);
    const pinned = await unbranched(primary);
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "tag", "-a", "-m", "release", "v1", pinned);
    const tagObject = await git(primary, "rev-parse", "v1");
    const refs = await branches(primary);
    const trees = await git(primary, "worktree", "list", "--porcelain");
    for (const [input, reason] of [
      [pinned.slice(0, 12), "Abbreviated commit hashes are not accepted"],
      ["f".repeat(40), "is not a commit in this repository"],
      [tagObject, "is not a commit in this repository"],
    ] as const) {
      const result = await cli(primary, "new", "pinned-work", "--base", input, "--no-editor", "--no-agent");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(reason);
    }
    expect(await branches(primary)).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
  });
});

test("base --set saves a commit offline, refuses bad hashes without changing it, and returns to a branch", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await fixture(primary, directory);
    const pinned = await unbranched(primary);
    await offline(primary, directory);
    const set = await cli(primary, "base", branch, "--set", pinned.toUpperCase());
    expect(set.stderr).toBe("");
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain(`Saved base commit ${pinned}`);
    expect(await listed(primary, target)).toEqual({ kind: "commit", commit: pinned });
    const record = await readFile(await metadata(target), "utf8");
    for (const [input, reason] of [
      [pinned.slice(0, 7), "Abbreviated commit hashes are not accepted as a base; give the full commit hash with --set."],
      ["e".repeat(40), "is not a commit in this repository"],
    ] as const) {
      const refused = await cli(primary, "base", branch, "--set", input);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain(reason);
      expect(await readFile(await metadata(target), "utf8")).toBe(record);
    }
    const local = await cli(primary, "base", branch, "--set", "refs/heads/main");
    expect(local.exitCode).toBe(0);
    expect(local.stdout).toContain(`(was commit ${pinned})`);
    expect(Object.keys(await saved(target))).toEqual(["version", "ref", "worktreePath", "commonGitDir", "worktreeGitDir"]);
  });
});

test("rebase onto a saved commit base works offline, never falls back to the configured base, and saves --base hashes", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await fixture(primary, directory);
    const pinned = await unbranched(primary);
    await commit(target, "feature.txt", "feature\n");
    await offline(primary, directory);
    expect((await cli(primary, "base", branch, "--set", pinned)).exitCode).toBe(0);
    const fetchHead = join(await git(primary, "rev-parse", "--absolute-git-dir"), "FETCH_HEAD");
    const fetched = await Bun.file(fetchHead).exists();

    const rebased = await cli(primary, "rebase", branch);
    expect(rebased.stderr).toBe("");
    expect(rebased.exitCode).toBe(0);
    expect(rebased.stdout).toContain(`Commit base: ${pinned}\n`);
    expect(await git(target, "rev-parse", "HEAD~1")).toBe(pinned);
    expect(await Bun.file(fetchHead).exists()).toBe(fetched);
    expect(await listed(primary, target)).toEqual({ kind: "commit", commit: pinned });
    expect((await cli(primary, "rebase", branch)).stdout).toContain("Already up to date.");

    const tip = await git(target, "rev-parse", "HEAD");
    const abbreviated = await cli(primary, "rebase", branch, "--base", pinned.slice(0, 10));
    expect(abbreviated.exitCode).toBe(1);
    expect(abbreviated.stderr).toContain("Abbreviated commit hashes are not accepted");
    expect(await git(target, "rev-parse", "HEAD")).toBe(tip);

    const trunk = await git(primary, "rev-parse", "trunk");
    const explicit = await cli(primary, "rebase", branch, "--base", trunk);
    expect(explicit.exitCode).toBe(0);
    expect(await listed(primary, target)).toEqual({ kind: "commit", commit: trunk });
  });
});

test("rebase refuses a saved commit that no longer exists instead of falling back", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await fixture(primary, directory);
    const pinned = await unbranched(primary);
    expect((await cli(primary, "base", branch, "--set", pinned)).exitCode).toBe(0);
    const file = await metadata(target);
    await writeFile(file, (await readFile(file, "utf8")).replace(pinned, "d".repeat(40)));
    const tip = await git(target, "rev-parse", "HEAD");
    const result = await cli(primary, "rebase", branch);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is not a commit in this repository");
    expect(await git(target, "rev-parse", "HEAD")).toBe(tip);
  });
});

const timber = (cwd: string, ...args: string[]) => execa(process.execPath, ["--no-env-file", join(import.meta.dir, "../src/index.ts"), ...args], {
  cwd, reject: false, timeout: 30_000, env: { CI: "true" },
});
const identity = ["-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid"];

test("done keeps unpublished work when only an unkept commit base contains it, and removes it once a branch keeps that commit", async () => {
  await withRepository(async (primary, directory) => {
    const path = await doneTarget(primary, directory);
    const work = await doneCommit(path);
    // Pinned on top of the work, so it contains it while no branch, including trunk, does.
    const pinned = await git(path, ...identity, "commit-tree", "-p", work, "-m", "release", `${work}^{tree}`);
    expect(await git(primary, "branch", "--all", "--contains", pinned)).toBe("");
    expect(await git(primary, "branch", "--contains", work)).not.toContain("trunk");
    expect((await timber(primary, "base", path, "--set", pinned)).exitCode).toBe(0);
    const before = await snapshot(primary);
    const refused = await done(primary, path);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("The commit base is not contained in any other branch");
    await retained(primary, path, before);

    await git(primary, "branch", "release", pinned);
    const result = await done(primary, path);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    await removed(primary, path, "feature/one", true);
  });
});

test("done never treats the branch's own tip as a commit base that preserves it", async () => {
  await withRepository(async (primary, directory) => {
    const path = await doneTarget(primary, directory);
    const work = await doneCommit(path);
    const before = await snapshot(primary);
    const explicit = await done(primary, path, "--base", work);
    expect(explicit.exitCode).toBe(1);
    await retained(primary, path, before);
    expect((await timber(primary, "base", path, "--set", work)).exitCode).toBe(0);
    const saved = await done(primary, path);
    expect(saved.exitCode).toBe(1);
    await retained(primary, path, before);
    expect(await git(primary, "rev-parse", "feature/one")).toBe(work);
  });
});

test("done refuses a missing saved commit base and accepts a one-off commit --base kept by a tag", async () => {
  await withRepository(async (primary, directory) => {
    const path = await doneTarget(primary, directory);
    const work = await doneCommit(path);
    const pinned = await git(path, ...identity, "commit-tree", "-p", work, "-m", "release", `${work}^{tree}`);
    await git(primary, "tag", "v1", pinned);
    const file = join(await git(path, "rev-parse", "--absolute-git-dir"), "timber", "base.json");
    expect((await timber(primary, "base", path, "--set", pinned)).exitCode).toBe(0);
    await writeFile(file, (await readFile(file, "utf8")).replace(pinned, "c".repeat(40)));
    const record = await readFile(file, "utf8");
    const before = await snapshot(primary);
    const refused = await done(primary, path, "--keep-branch");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/base/i);
    await retained(primary, path, before);
    expect(await readFile(file, "utf8")).toBe(record);
    const override = await done(primary, path, "--base", pinned);
    expect(override.exitCode).toBe(0);
    await removed(primary, path, "feature/one", true);
  });
});

test("a branch with a short hex name still works as a base", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await fixture(primary, directory);
    await git(primary, "push", "origin", "trunk:1234567");
    await git(primary, "fetch", "origin");
    await git(primary, "branch", "abcdef12", "trunk");
    const set = await cli(primary, "base", branch, "--set", "1234567");
    expect(set.stderr).toBe("");
    expect(set.exitCode).toBe(0);
    expect(await listed(primary, target)).toEqual({ kind: "assigned", ref: "refs/remotes/origin/1234567" });
    const created = await cli(primary, "new", "hex-child", "--base", "abcdef12", "--no-editor", "--no-agent");
    expect(created.stderr).toBe("");
    expect(created.exitCode).toBe(0);
  });
});
