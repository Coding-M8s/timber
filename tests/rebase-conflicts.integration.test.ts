import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { advance, cli, commit, fixture, paused } from "./helpers/rebase";

test.each(["text", "control"])("rebase leaves %s conflicts paused, refuses restart/cleanup, and supports manual continue", async scenario => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const name = scenario === "control" ? "odd \n'\tname" : "tracked.txt";
    await commit(target, name, "feature\n");
    const original = await git(target, "rev-parse", "HEAD");
    await advance(publisher, name, "incoming\n");
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("conflict");
    expect(result.stderr).toContain("rebase --continue");
    expect(result.stderr).toContain("rebase --abort");
    expect(result.stderr).toContain(scenario === "control" ? "\\n" : name);
    expect(result.stderr).not.toContain(name === "tracked.txt" ? "RAW_PRIVATE_HOOK" : name);
    expect(await paused(target)).toBe(true);
    expect(await git(target, "diff", "--name-only", "--diff-filter=U", "-z")).toBe(name + "\0");
    expect((await cli(primary, "rebase", target)).stderr).toContain("rebase --continue");
    expect((await cli(primary, "rebase", "TIM-28-feature")).stderr).toContain("rebase --continue");
    await writeFile(join(target, name), "resolved\n");
    await git(target, "add", "--", name);
    const staged = await git(target, "diff", "--cached", "--binary");
    expect((await cli(primary, "done", target, "--keep-branch")).exitCode).toBe(1);
    expect(await paused(target)).toBe(true);
    expect(await git(target, "diff", "--cached", "--binary")).toBe(staged);
    await execa("git", ["rebase", "--continue"], { cwd: target, env: { GIT_EDITOR: "true" } });
    expect(await paused(target)).toBe(false);
    expect(await git(target, "rev-parse", "HEAD")).not.toBe(original);
    expect(await readFile(join(target, name), "utf8")).toBe("resolved\n");
  });
});

// One rebase stop covers both binary and modify/delete conflict rendering.
test("rebase reports binary and delete conflicts together and stays paused", async () => {
  await withRepository(async (primary, directory) => {
    await commit(primary, "blob.bin", new Uint8Array([0, 1, 2]));
    const { publisher, target } = await fixture(primary, directory);
    await writeFile(join(target, "blob.bin"), new Uint8Array([0, 3, 4]));
    await git(target, "rm", "-q", "tracked.txt");
    await git(target, "add", "blob.bin");
    await git(target, "commit", "-m", "binary edit and delete");
    await advance(publisher, "blob.bin", new Uint8Array([0, 5, 6]));
    await advance(publisher, "tracked.txt", "incoming\n");
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("conflict");
    expect(result.stderr).toContain("blob.bin");
    expect(result.stderr).toContain("tracked.txt");
    expect(result.stderr).toContain("rebase --continue");
    expect(await paused(target)).toBe(true);
    expect(await git(target, "diff", "--name-only", "--diff-filter=U", "-z")).toBe("blob.bin\0tracked.txt\0");
  });
});

test("cleanup refuses a paused rebase after staging a resolution identical to the base", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    await commit(target, "tracked.txt", "feature\n");
    await advance(publisher, "tracked.txt", "incoming\n");
    expect((await cli(primary, "rebase", target)).exitCode).toBe(1);
    await git(target, "checkout", "--ours", "tracked.txt");
    await git(target, "add", "tracked.txt");
    expect(await git(target, "status", "--porcelain=v1")).toBe("");
    const result = await cli(primary, "done", target, "--keep-branch", "--base", "origin/main");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("in-progress rebase");
    expect(await paused(target)).toBe(true);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("incoming\n");
  });
});
