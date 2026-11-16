import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { absent, cli, commit, entry, removed, retained, saveBase, snapshot, target, upstream } from "./helpers/done";

test.each(["saved", "default"])("done refreshes a stale remote base automatically: %s", async selection => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const remote = join(directory, "base.git");
    await git(directory, "init", "--bare", remote);
    await git(primary, "remote", "add", "backup", remote);
    await git(primary, "push", "backup", "trunk");
    const original = await git(primary, "rev-parse", "trunk");
    const feature = await commit(path);
    // A separate checkout merges on the server without refreshing our cached base.
    const publisher = join(directory, "publisher");
    await git(directory, "clone", "--branch", "feature/one", primary, publisher);
    const tip = await commit(publisher, "later.txt", "later server change");
    await git(publisher, "push", remote, "HEAD:refs/heads/trunk");
    await git(publisher, "tag", "server-only-tag");
    await git(publisher, "push", remote, "refs/tags/server-only-tag");
    expect((await execa("git", ["cat-file", "-e", tip], { cwd: primary, reject: false })).exitCode).not.toBe(0);
    expect(feature).not.toBe(tip);
    expect(await git(primary, "rev-parse", "backup/trunk")).toBe(original);
    await git(primary, "symbolic-ref", "refs/remotes/backup/HEAD", "refs/remotes/backup/trunk");
    const config = selection === "saved" ? 'base_branch = "refs/heads/trunk"\n' : "";
    await writeFile(join(primary, ".timber.toml"), config);
    if (selection === "saved") await saveBase(primary, path, "refs/remotes/backup/trunk");
    const remoteRefs = await git(remote, "show-ref");

    const result = await cli(primary, path);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    await removed(primary, path, "feature/one", true);
    expect(await git(primary, "rev-parse", "backup/trunk")).toBe(tip);
    expect(await git(primary, "rev-parse", "trunk")).toBe(original);
    expect(await git(primary, "tag", "--list")).toBe("");
    expect(await git(remote, "show-ref")).toBe(remoteRefs);
    expect(await readFile(join(primary, ".timber.toml"), "utf8")).toBe(config);
  });
});

test("done retains integrated work when its remote base cannot refresh: explicit", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const remote = await upstream(primary, directory, path);
    await git(primary, "push", "backup", "trunk");
    await git(primary, "symbolic-ref", "refs/remotes/backup/HEAD", "refs/remotes/backup/trunk");
    const marker = join(directory, "hook-ran");
    await writeFile(join(primary, ".timber.toml"), `[hooks]\npre_delete = ['touch "${marker}"']\n`);
    await git(primary, "remote", "set-url", "backup", join(directory, "unavailable.git"));
    await writeFile(join(path, ".env"), "preserve ignored bytes\n");
    const before = await snapshot(primary);
    const remoteRefs = await git(remote, "show-ref");

    const result = await cli(primary, path, "--base", "backup/trunk");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/refresh|fetch/i);
    await retained(primary, path, before);
    expect(await absent(marker)).toBe(true);
    expect(await readFile(join(path, ".env"), "utf8")).toBe("preserve ignored bytes\n");
    expect(await git(remote, "show-ref")).toBe(remoteRefs);
  });
});

test.each(["deleted", "fetch-fails", "remote-moves", "tracking-moves", "symbolic"])("done preserves local work on remote base refresh failure: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const remote = await upstream(primary, directory, path);
    await git(primary, "push", "backup", "trunk");
    const original = await git(primary, "rev-parse", "trunk");
    const tip = await commit(path);
    const publisher = join(directory, "publisher");
    await git(directory, "clone", "--branch", "feature/one", primary, publisher);
    await git(publisher, "push", remote, "HEAD:refs/heads/trunk");
    // Keep publication independently valid, to ensure it cannot bypass a failed refresh.
    await git(path, "push", "backup", "feature/one");
    await git(primary, "symbolic-ref", "refs/remotes/backup/HEAD", "refs/remotes/backup/trunk");
    const marker = join(directory, "hook-ran");
    await writeFile(join(primary, ".timber.toml"), `[hooks]\npre_delete = ['touch "${marker}"']\n`);
    await writeFile(join(path, ".env"), "preserve ignored bytes\n");
    if (scenario === "deleted") await git(remote, "update-ref", "-d", "refs/heads/trunk");
    if (scenario === "symbolic") await git(primary, "symbolic-ref", "refs/remotes/backup/trunk", "refs/heads/trunk");
    const wrapperDir = join(directory, "refresh git");
    await mkdir(wrapperDir);
    const realGit = (await execa("which", ["git"])).stdout;
    await writeFile(join(wrapperDir, "git"), [
      "#!/bin/sh",
      'if [ "$1" = fetch ]; then',
      scenario === "fetch-fails" ? '  exit 19' :
      scenario === "remote-moves" ? '  "$TIMBER_REAL_GIT" -C "$TIMBER_TEST_REMOTE" update-ref refs/heads/trunk "$TIMBER_TEST_OLD"' : "  :",
      '  "$TIMBER_REAL_GIT" "$@" || exit "$?"',
      scenario === "tracking-moves" ? '  "$TIMBER_REAL_GIT" update-ref refs/remotes/backup/trunk "$TIMBER_TEST_TIP"' : "  :",
      '  exit 0', 'fi', 'exec "$TIMBER_REAL_GIT" "$@"', "",
    ].join("\n"));
    await chmod(join(wrapperDir, "git"), 0o755);
    const before = await snapshot(primary);
    const result = await execa(process.execPath, [entry, "done", path], {
      cwd: primary, reject: false, timeout: 30_000,
      env: { CI: "true", PATH: `${wrapperDir}:${process.env.PATH}`, TIMBER_REAL_GIT: realGit,
        TIMBER_TEST_REMOTE: remote, TIMBER_TEST_OLD: original, TIMBER_TEST_TIP: tip },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/refresh/i);
    expect(await absent(path)).toBe(false);
    expect((await snapshot(primary)).trees).toBe(before.trees);
    if (scenario !== "tracking-moves") expect((await snapshot(primary)).refs).toBe(before.refs);
    else expect(await git(primary, "rev-parse", "backup/trunk")).toBe(tip);
    expect(await git(primary, "rev-parse", "trunk")).toBe(original);
    expect(await git(path, "rev-parse", "HEAD")).toBe(tip);
    expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature bytes\n");
    expect(await readFile(join(path, ".env"), "utf8")).toBe("preserve ignored bytes\n");
    expect(await absent(marker)).toBe(true);
  });
});
