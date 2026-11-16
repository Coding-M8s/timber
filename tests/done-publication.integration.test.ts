import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, withRepository } from "./helpers/git";
import { cli, commit, removed, retained, snapshot, target, upstream } from "./helpers/done";

test("done removes published unknown-base review work and its local branch while preserving the remote", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const oid = await commit(path);
    const remote = await upstream(primary, directory, path);
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "absent"\n');
    const remoteRefs = await git(remote, "show-ref");
    const completed = await cli(primary, path);
    expect(completed.exitCode).toBe(0);
    expect(completed.stderr).toBe("");
    expect(completed.stdout).toContain("Deleted local branch feature/one");
    await removed(primary, path, "feature/one", true);
    expect(await git(primary, "for-each-ref", "refs/heads/feature/one")).toBe("");
    expect(await git(remote, "rev-parse", "refs/heads/feature/one")).toBe(oid);
    expect(await git(remote, "show-ref")).toBe(remoteRefs);
  });
});

test("done refuses unpublished unproven work with both options and preserves all refs and bytes", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const remote = await upstream(primary, directory, path);
    const oid = await commit(path);
    const before = await snapshot(primary);
    const remoteRefs = await git(remote, "show-ref");
    const result = await cli(primary, path, "--keep-branch", "--discard-ignored");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/unpublished|publication|published/);
    expect(result.stderr).toContain(oid);
    await retained(primary, path, before);
    expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature bytes\n");
    expect(await git(remote, "show-ref")).toBe(remoteRefs);
  });
});
