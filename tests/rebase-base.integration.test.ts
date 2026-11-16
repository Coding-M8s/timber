import { expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, withRepository } from "./helpers/git";
import { advance, cli, commit, fixture, paused } from "./helpers/rebase";

// A stale cache must never let rebase silently use the previous remote base.
test("rebase fetches fresh remote base, rewrites only selected branch, and supports up-to-date rerun", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const original = await commit(target, "feature.txt", "feature\n");
    await git(primary, "branch", "same-tip", original);
    await git(primary, "config", "rebase.updateRefs", "true");
    await git(primary, "config", "rebase.autoStash", "true");
    const localMain = await git(primary, "rev-parse", "main");
    const stale = await git(primary, "rev-parse", "origin/main");
    const incoming = await advance(publisher);
    expect(incoming).not.toBe(stale);
    await writeFile(join(primary, "tracked.txt"), "unrelated dirty\n");
    await writeFile(join(primary, "untracked.txt"), "untracked\n");
    await writeFile(join(target, ".env"), "preserve ignored\n");
    const result = await cli(primary, "rebase", "TIM-28");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(incoming);
    expect(result.stdout).toContain("origin/main");
    expect(result.stdout).toContain(target);
    expect(await git(target, "rev-parse", "HEAD^")).toBe(incoming);
    expect(await git(primary, "rev-parse", "main")).toBe(localMain);
    expect(await git(primary, "rev-parse", "same-tip")).toBe(original);
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("unrelated dirty\n");
    expect(await readFile(join(primary, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(await readFile(join(target, ".env"), "utf8")).toBe("preserve ignored\n");
    const rebased = await git(target, "rev-parse", "HEAD");
    expect((await cli(primary, "rebase", target)).exitCode).toBe(0);
    expect(await git(target, "rev-parse", "HEAD")).toBe(rebased);
  });
});

test.each(["deleted", "offline", "ambiguous-remote", "ambiguous-base"])("rebase refuses %s remote/base without touching branch", async scenario => {
  await withRepository(async (primary, directory) => {
    const { remote, publisher, target } = await fixture(primary, directory);
    const before = await git(primary, "show-ref");
    const initial = await git(target, "rev-parse", "HEAD");
    if (scenario === "deleted") await git(publisher, "push", "origin", "--delete", "main");
    if (scenario === "offline") await rm(remote, { recursive: true });
    if (scenario === "ambiguous-remote") await git(primary, "remote", "add", "backup", remote);
    if (scenario === "ambiguous-base") {
      await git(publisher, "push", "origin", "main:master");
      await git(primary, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/unknown-default");
      await writeFile(join(primary, ".timber.toml"), "");
    }
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("unknown command");
    expect(await git(primary, "show-ref")).toBe(before);
    expect(await git(target, "rev-parse", "HEAD")).toBe(initial);
    expect(await paused(target)).toBe(false);
  });
});

test("explicit remote base overrides configured remote and base; Git hook failure is not a conflict", async () => {
  await withRepository(async (primary, directory) => {
    const { remote, publisher, target } = await fixture(primary, directory);
    await commit(target, "feature.txt", "feature\n");
    const incoming = await advance(publisher);
    await git(primary, "remote", "add", "backup", remote);
    await writeFile(join(primary, ".timber.toml"), 'remote = "missing-configured-remote"\nbase_branch = "absent"\n');
    const hook = join(primary, ".git/hooks/pre-rebase");
    await writeFile(hook, "#!/bin/sh\nprintf 'RAW_PRIVATE_HOOK' >&2\nexit 1\n"); await chmod(hook, 0o755);
    const original = await git(target, "rev-parse", "HEAD");
    const result = await cli(primary, "rebase", target, "--base", "backup/main");
    // Git versions return different statuses when a pre-rebase hook rejects.
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain("Git rebase failed");
    expect(result.stdout).toContain(incoming);
    expect(result.stderr).not.toContain("paused with conflicts");
    expect(result.stderr).not.toContain("RAW_PRIVATE_HOOK");
    expect(await git(target, "rev-parse", "HEAD")).toBe(original);
    expect(await paused(target)).toBe(false);
  });
});

test.each(["configured-remote", "remote-default", "remote-fallback"])("rebase base precedence: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const { remote, publisher, target } = await fixture(primary, directory);
    const incoming = await advance(publisher);
    if (scenario === "configured-remote") {
      await git(primary, "remote", "add", "other", remote);
      await writeFile(join(primary, ".timber.toml"), 'remote = "origin"\nbase_branch = "main"\n');
    } else if (scenario === "remote-default") {
      await git(primary, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
      await writeFile(join(primary, ".timber.toml"), "");
    } else await writeFile(join(primary, ".timber.toml"), "");
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(0);
    expect(await git(target, "rev-parse", "HEAD")).toBe(incoming);
  });
});

test("a symbolic remote-tracking ref cannot redirect fetch into an unrelated local branch", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const original = await commit(target, "feature.txt", "feature\n");
    await git(primary, "branch", "untouched", original);
    await git(primary, "symbolic-ref", "refs/remotes/origin/main", "refs/heads/untouched");
    await advance(publisher);
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(0);
    expect(await git(primary, "rev-parse", "untouched")).toBe(original);
    expect(await git(primary, "symbolic-ref", "refs/remotes/origin/main")).toBe("refs/heads/untouched");
    expect(await readFile(join(target, "feature.txt"), "utf8")).toBe("feature\n");
  });
});

test("rebase without any remote refuses and points at a local refs/heads base", async () => {
  await withRepository(async primary => {
    expect(await git(primary, "remote")).toBe("");
    const refsBefore = await git(primary, "show-ref");
    const headBefore = await git(primary, "rev-parse", "HEAD");

    const result = await cli(primary, "rebase", "trunk");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("error: Remote is missing or ambiguous; configure remote, use --base <remote/branch>, or use --base refs/heads/<branch> for a local base.");
    expect(await git(primary, "show-ref")).toBe(refsBefore);
    expect(await git(primary, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(primary, "status", "--porcelain")).toBe("");
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("original\n");
  });
});
