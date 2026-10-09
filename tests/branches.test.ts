import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { discoverRepository } from "../src/git/repository";
import { refreshRemoteBranch, resolveBase, resolveBranch, validateNewBranchName } from "../src/git/branches";
import type { RepositoryConfig } from "../src/types";

const config = (remote: string | null = null): RepositoryConfig => ({
  baseBranch: null, remote, worktreeDir: null, editor: null, agent: null,
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout;
}

async function fixture(run: (repo: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "timber branches "));
  const repo = join(directory, "repo with spaces");
  try {
    await mkdir(repo);
    await git(repo, "init", "-b", "trunk");
    await git(repo, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
    await run(repo, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("exact local wins; ticket prefix respects delimiter and reports all matches", async () => {
  await fixture(async repo => {
    await git(repo, "branch", "ABU-834");
    await git(repo, "branch", "ABU-834-one");
    await git(repo, "branch", "ABU-834_two");
    await git(repo, "branch", "ABU-8342-wrong");
    const context = await discoverRepository(repo);

    expect(await resolveBranch(context, "ABU-834", config())).toEqual({
      kind: "found", value: { kind: "local", name: "ABU-834", ref: "refs/heads/ABU-834", upstream: null },
    });
    await git(repo, "branch", "-d", "ABU-834");
    expect(await resolveBranch(context, "ABU-834", config())).toEqual({
      kind: "ambiguous", candidates: [
        { kind: "local", name: "ABU-834-one", ref: "refs/heads/ABU-834-one", upstream: null },
        { kind: "local", name: "ABU-834_two", ref: "refs/heads/ABU-834_two", upstream: null },
      ],
    });
    expect(await resolveBranch(context, "ABU-835", config())).toEqual({ kind: "not-found" });
  });
});

test("remote tracking refs resolve explicitly and configured remote filters unqualified names", async () => {
  await fixture(async (repo, directory) => {
    const origin = join(directory, "origin.git");
    const upstream = join(directory, "upstream.git");
    await git(directory, "init", "--bare", origin);
    await git(directory, "init", "--bare", upstream);
    await git(repo, "remote", "add", "origin", origin);
    await git(repo, "remote", "add", "upstream", upstream);
    await git(repo, "branch", "feature/one");
    await git(repo, "push", "origin", "feature/one");
    await git(repo, "push", "upstream", "feature/one");
    await git(repo, "branch", "-d", "feature/one");
    await git(repo, "fetch", "origin");
    await git(repo, "fetch", "upstream");
    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature/one");
    const context = await discoverRepository(repo);

    await git(repo, "branch", "origin/feature/one");

    expect(await resolveBranch(context, "origin/feature/one", config("upstream"))).toEqual({
      kind: "found", value: { kind: "remote", remote: "origin", name: "feature/one", ref: "refs/remotes/origin/feature/one" },
    });
    expect(await resolveBranch(context, "feature/one", config("upstream"))).toEqual({
      kind: "found", value: { kind: "remote", remote: "upstream", name: "feature/one", ref: "refs/remotes/upstream/feature/one" },
    });
    expect(await resolveBranch(context, "feature/one", config())).toEqual({
      kind: "ambiguous", candidates: [
        { kind: "remote", remote: "origin", name: "feature/one", ref: "refs/remotes/origin/feature/one" },
        { kind: "remote", remote: "upstream", name: "feature/one", ref: "refs/remotes/upstream/feature/one" },
      ],
    });
    expect(await resolveBranch(context, "origin/HEAD", config())).toEqual({ kind: "not-found" });
    await expect(resolveBranch(context, "feature/one", config("missing"))).rejects.toThrow(/remote.*missing/i);
  });
});

test("refresh updates selected tracking ref and fails closed when remote is unavailable", async () => {
  await fixture(async (repo, directory) => {
    const bare = join(directory, "remote.git");
    await git(directory, "init", "--bare", bare);
    await git(repo, "remote", "add", "upstream", bare);
    await git(repo, "branch", "feature");
    await git(repo, "push", "upstream", "feature");
    const before = await git(repo, "rev-parse", "refs/heads/feature");
    await git(repo, "checkout", "feature");
    await git(repo, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "next");
    const after = await git(repo, "rev-parse", "HEAD");
    await git(repo, "push", "upstream", "feature");
    await git(repo, "checkout", "trunk");
    await git(repo, "update-ref", "refs/remotes/upstream/feature", before);
    const context = await discoverRepository(repo);
    const branch = { kind: "remote" as const, remote: "upstream", name: "feature", ref: "refs/remotes/upstream/feature" };

    expect(await refreshRemoteBranch(context, branch)).toEqual(branch);
    expect(await git(repo, "rev-parse", branch.ref)).toBe(after);

    const marker = join(repo, "keep.txt");
    await writeFile(marker, "preserve");
    await git(repo, "remote", "set-url", "upstream", join(directory, "missing.git"));
    await expect(refreshRemoteBranch(context, branch)).rejects.toThrow(/refresh.*upstream.*feature/i);
    expect(await git(repo, "rev-parse", branch.ref)).toBe(after);
    expect(await readFile(marker, "utf8")).toBe("preserve");

    await git(repo, "remote", "set-url", "upstream", bare);
    await git(repo, "push", "upstream", "--delete", "feature");
    await git(repo, "update-ref", branch.ref, after);
    await expect(refreshRemoteBranch(context, branch)).rejects.toThrow(/refresh.*upstream.*feature/i);
    expect(await git(repo, "rev-parse", branch.ref)).toBe(after);
  });
});

test("refresh preserves unrelated local refs despite configured fetch mappings", async () => {
  await fixture(async (repo, directory) => {
    const bare = join(directory, "remote.git");
    await git(directory, "init", "--bare", bare);
    await git(repo, "remote", "add", "upstream", bare);
    await git(repo, "branch", "feature");
    await git(repo, "push", "upstream", "feature");
    await git(repo, "checkout", "-b", "saved-work");
    await git(repo, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "unpublished");
    const saved = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "trunk");
    await git(repo, "config", "--add", "remote.upstream.fetch", "+refs/heads/feature:refs/heads/saved-work");
    await git(repo, "config", "fetch.prune", "true");
    await git(repo, "update-ref", "refs/remotes/upstream/stale", saved);
    const context = await discoverRepository(repo);

    await refreshRemoteBranch(context, { kind: "remote", remote: "upstream", name: "feature", ref: "refs/remotes/upstream/feature" });
    expect(await git(repo, "rev-parse", "refs/heads/saved-work")).toBe(saved);
    expect(await git(repo, "rev-parse", "refs/remotes/upstream/stale")).toBe(saved);
  });
});

test("Git validates new branch names without creating refs", async () => {
  await fixture(async repo => {
    const context = await discoverRepository(repo);
    await expect(validateNewBranchName(context, "feature/valid-name")).resolves.toBeUndefined();
    await expect(validateNewBranchName(context, "bad name")).rejects.toThrow(/invalid.*branch/i);
    await expect(validateNewBranchName(context, "../escape")).rejects.toThrow(/invalid.*branch/i);
    await expect(validateNewBranchName(context, "-option")).rejects.toThrow(/invalid.*branch/i);
    await git(repo, "checkout", "-b", "other");
    await git(repo, "checkout", "trunk");
    await expect(validateNewBranchName(context, "@{-1}")).rejects.toThrow(/invalid.*branch/i);
    expect(await git(repo, "show-ref", "--verify", "--quiet", "refs/heads/feature/valid-name").catch(() => "missing")).toBe("missing");
  });
});

test("base precedence honors explicit, config, remote default, then local fallback", async () => {
  await fixture(async (repo, directory) => {
    const initial = await git(repo, "rev-parse", "HEAD");
    await git(repo, "branch", "main");
    const bare = join(directory, "upstream.git");
    await git(directory, "init", "--bare", bare);
    await git(repo, "remote", "add", "upstream", bare);
    await git(repo, "branch", "release");
    await git(repo, "push", "upstream", "release");
    await git(repo, "fetch", "upstream");
    await git(repo, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/release");
    const context = await discoverRepository(repo);
    await git(repo, "branch", "upstream/release");

    expect(await resolveBase(context, { ...config(), baseBranch: "main" }, "trunk")).toEqual({
      ref: "refs/heads/trunk", commit: initial, source: "explicit",
    });
    expect(await resolveBase(context, config(), "upstream/release")).toEqual({
      ref: "refs/remotes/upstream/release", commit: initial, source: "explicit",
    });
    expect(await resolveBase(context, { ...config(), baseBranch: "main" })).toEqual({
      ref: "refs/heads/main", commit: initial, source: "config",
    });
    expect(await resolveBase(context, config("upstream"))).toEqual({
      ref: "refs/remotes/upstream/release", commit: initial, source: "remote-default",
    });
    await git(repo, "symbolic-ref", "--delete", "refs/remotes/upstream/HEAD");
    expect(await resolveBase(await discoverRepository(repo), config())).toEqual({
      ref: "refs/heads/main", commit: initial, source: "fallback",
    });
  });
});

test("base resolution rejects missing chosen refs and ambiguous fallback", async () => {
  await fixture(async repo => {
    await git(repo, "branch", "main");
    await git(repo, "branch", "master");
    const context = await discoverRepository(repo);
    await expect(resolveBase(context, config())).rejects.toThrow(/ambiguous.*main.*master/i);
    await expect(resolveBase(context, { ...config(), baseBranch: "missing" })).rejects.toThrow(/base.*missing/i);
    await expect(resolveBase(context, config(), "missing")).rejects.toThrow(/base.*missing/i);
    expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(await git(repo, "rev-parse", "refs/heads/master"));
  });
});
