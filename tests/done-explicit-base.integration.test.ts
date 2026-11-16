import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { absent, cli, commit, entry, mergedIntoParent, removed, retained, saveBase, snapshot, target, upstream } from "./helpers/done";

test("done uses an explicit non-default base without changing TOML: merge", async () => {
  await withRepository(async (primary, directory) => {
    const { path } = await mergedIntoParent(primary, directory, false, false);
    const config = await readFile(join(primary, ".timber.toml"));
    const parent = await git(primary, "rev-parse", "feature/parent");
    const trunk = await git(primary, "rev-parse", "trunk");
    const before = await snapshot(primary);
    const refused = await cli(primary, path);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("--base");
    await retained(primary, path, before);
    const result = await cli(primary, path, "--base", "feature/parent");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    await removed(primary, path, "feature/one", true);
    expect(await git(primary, "rev-parse", "feature/parent")).toBe(parent);
    expect(await git(primary, "rev-parse", "trunk")).toBe(trunk);
    expect(await readFile(join(primary, ".timber.toml"))).toEqual(config);
  });
});

test.each(["--bad", "feature/one", "refs/heads/feature/one", "ambiguous"])("done rejects explicit invalid/self base even with published work: %s", async base => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    await commit(path);
    await upstream(primary, directory, path);
    if (base === "ambiguous") {
      await git(primary, "remote", "add", "second", join(directory, "upstream.git"));
      await git(primary, "update-ref", "refs/remotes/second/ambiguous", "HEAD");
      await git(primary, "update-ref", "refs/remotes/backup/ambiguous", "HEAD");
    }
    const before = await snapshot(primary);
    const result = await cli(primary, path, "--keep-branch", "--base=" + base);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/base/i);
    await retained(primary, path, before);
    expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature bytes\n");
  });
});

test("done explicit base preserves unsafe work: wrong-base", async () => {
  await withRepository(async (primary, directory) => {
    const { path } = await mergedIntoParent(primary, directory);
    await writeFile(join(path, ".env"), "preserve bytes\n");
    const before = await snapshot(primary);
    const result = await cli(primary, path, "--base", "trunk");
    expect(result.exitCode).toBe(1);
    await retained(primary, path, before);
    expect(await readFile(join(path, ".env"), "utf8")).toBe("preserve bytes\n");
  });
});

// A moving selected base must be caught even if publication independently permits cleanup.
test.each([
  ["explicit", "hook"], ["saved", "after-remove"],
])("done revalidates %s base at %s and preserves the branch", async (selection, phase) => {
  await withRepository(async (primary, directory) => {
    const { path, child } = await mergedIntoParent(primary, directory);
    if (selection === "saved") await saveBase(primary, path, "refs/heads/feature/parent");
    const flags = selection === "explicit" ? ["--base", "feature/parent"] : [];
    await upstream(primary, directory, path);
    const trunk = await git(primary, "rev-parse", "trunk");
    const before = await snapshot(primary);
    let result;
    if (phase === "hook") {
      await writeFile(join(primary, ".timber.toml"), `base_branch = "trunk"\n[hooks]\npre_delete = ['git update-ref refs/heads/feature/parent refs/heads/trunk']\n`);
      result = await cli(primary, path, ...flags);
    } else {
      const wrapperDir = join(directory, "base race git");
      await mkdir(wrapperDir);
      const realGit = (await execa("which", ["git"])).stdout;
      await writeFile(join(wrapperDir, "git"), [
        "#!/bin/sh",
        'if [ "$1" = worktree ] && [ "$2" = remove ]; then',
        '  "$TIMBER_REAL_GIT" "$@" || exit "$?"',
        '  "$TIMBER_REAL_GIT" update-ref refs/heads/feature/parent refs/heads/trunk',
        '  exit "$?"',
        'fi',
        'exec "$TIMBER_REAL_GIT" "$@"', "",
      ].join("\n"));
      await chmod(join(wrapperDir, "git"), 0o755);
      result = await execa(process.execPath, [entry, "done", path, ...flags], {
        cwd: primary, reject: false, timeout: 30_000,
        env: { CI: "true", PATH: `${wrapperDir}:${process.env.PATH}`, TIMBER_REAL_GIT: realGit },
      });
    }
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/base.*changed/i);
    expect(await git(primary, "rev-parse", "feature/one")).toBe(child);
    expect(await git(primary, "rev-parse", "feature/parent")).toBe(trunk);
    expect(await git(primary, "rev-parse", "trunk")).toBe(trunk);
    if (phase === "hook") {
      expect(await absent(path)).toBe(false);
      expect((await snapshot(primary)).trees.replace(/HEAD [0-9a-f]+/gu, "HEAD"))
        .toBe(before.trees.replace(/HEAD [0-9a-f]+/gu, "HEAD"));
      expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature bytes\n");
    } else {
      expect(result.stderr).toContain("worktree was removed");
      await removed(primary, path, "feature/one", false);
    }
  });
});
