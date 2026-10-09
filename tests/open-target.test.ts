import { expect, test } from "bun:test";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverRepository } from "../src/git/repository";
import { resolveOpenTarget } from "../src/git/open-target";
import type { OpenTarget, RepositoryConfig } from "../src/types";
import { git, withRepository } from "./helpers/git";

const config: RepositoryConfig = {
  baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null,
};

const withRemote = (remote: string): RepositoryConfig => ({ ...config, remote });

function targetIdentities(targets: readonly OpenTarget[]): string[] {
  return targets.map(target => target.kind === "worktree"
    ? `worktree:${target.worktree.path}` : `branch:${target.branch.ref}`);
}

async function addOfflineRemote(primary: string, directory: string, remote: string, branch: string): Promise<void> {
  await git(primary, "remote", "add", remote, join(directory, `${remote} unavailable.git`));
  const head = await git(primary, "rev-parse", "HEAD");
  await git(primary, "update-ref", `refs/remotes/${remote}/${branch}`, head);
}

interface PreservedWorktreeState {
  inventory: string;
  refs: string;
  index: Uint8Array;
  tracked: Uint8Array;
  untracked: Uint8Array;
  ignored: Uint8Array;
  head: string;
}

async function preparePreservedWorktree(primary: string, linked: string, branch: string): Promise<void> {
  await git(primary, "worktree", "add", "-b", branch, linked);
  await writeFile(join(linked, "unpublished.txt"), "unpublished commit\n");
  await git(linked, "add", "unpublished.txt");
  await git(linked, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "unpublished");
  await writeFile(join(linked, "tracked.txt"), "modified tracked content\n");
  await writeFile(join(linked, "keep.txt"), "untracked sentinel\n");
  await writeFile(join(linked, ".env"), "ignored fixture only\n");
  await git(primary, "worktree", "lock", linked, "--reason", "preserve during resolution");
}

async function preservedState(primary: string, linked: string): Promise<PreservedWorktreeState> {
  const gitDirectory = await git(linked, "rev-parse", "--absolute-git-dir");
  return {
    inventory: await git(primary, "worktree", "list", "--porcelain", "-z"),
    refs: await git(primary, "show-ref"),
    index: await readFile(join(gitDirectory, "index")),
    tracked: await readFile(join(linked, "tracked.txt")),
    untracked: await readFile(join(linked, "keep.txt")),
    ignored: await readFile(join(linked, ".env")),
    head: await git(linked, "rev-parse", "HEAD"),
  };
}

async function expectPreservedState(
  primary: string, linked: string, before: PreservedWorktreeState,
): Promise<void> {
  expect(await preservedState(primary, linked)).toEqual(before);
}

test("an exact checked-out branch returns its manual worktree", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "manual worktree with spaces");
    await git(primary, "worktree", "add", "-b", "ABU-834-one", linked);
    const repository = await discoverRepository(primary);
    const before = await git(primary, "worktree", "list", "--porcelain", "-z");
    expect(await resolveOpenTarget(repository, "ABU-834-one", config)).toMatchObject({
      kind: "found", value: { kind: "worktree", worktree: { path: linked } },
    });
    expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(before);
  });
});

test("the primary branch and its registered absolute path resolve to the primary worktree", async () => {
  await withRepository(async (primary, directory) => {
    const repository = await discoverRepository(primary);
    const normalizedPath = `${directory}/unused/../primary repo`;
    for (const input of ["trunk", primary, normalizedPath]) {
      expect(await resolveOpenTarget(repository, input, config)).toMatchObject({
        kind: "found", value: { kind: "worktree", worktree: { path: primary, branch: "trunk", isPrimary: true } },
      });
    }
  });
});

test("manual and default-layout worktrees resolve by exact branch name", async () => {
  await withRepository(async (primary, directory) => {
    const manual = join(directory, "manual branch directory");
    const defaultLayout = join(directory, "primary repo-worktrees", "ticket-slug");
    await mkdir(join(directory, "primary repo-worktrees"));
    await git(primary, "worktree", "add", "-b", "manual/feature", manual);
    await git(primary, "worktree", "add", "-b", "layout/feature", defaultLayout);
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, "manual/feature", config)).toMatchObject({
      kind: "found", value: { kind: "worktree", worktree: { path: manual } },
    });
    expect(await resolveOpenTarget(repository, "layout/feature", config)).toMatchObject({
      kind: "found", value: { kind: "worktree", worktree: { path: defaultLayout } },
    });
  });
});

test("an absolute detached worktree path resolves with a null branch", async () => {
  await withRepository(async (primary, directory) => {
    const detached = join(directory, "manual detached worktree");
    await git(primary, "worktree", "add", "--detach", detached);
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, detached, config)).toMatchObject({
      kind: "found", value: { kind: "worktree", worktree: { path: detached, branch: null } },
    });
  });
});

test("an unborn primary branch resolves by name with a null HEAD", async () => {
  await withRepository(async (_primary, directory) => {
    const unborn = join(directory, "unborn repo");
    await mkdir(unborn);
    await git(unborn, "init", "-b", "waiting");
    const repository = await discoverRepository(unborn);

    expect(await resolveOpenTarget(repository, "waiting", config)).toMatchObject({
      kind: "found", value: { kind: "worktree", worktree: { path: unborn, branch: "waiting", head: null } },
    });
  });
});

test("an unchecked local branch returns its full local ref", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "branch", "feature/one");
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, "feature/one", config)).toEqual({
      kind: "found", value: { kind: "branch", branch: {
        kind: "local", name: "feature/one", ref: "refs/heads/feature/one", upstream: null,
      } },
    });
  });
});

test("a cached remote-only branch resolves offline with its remote and full ref", async () => {
  await withRepository(async (primary, directory) => {
    await addOfflineRemote(primary, directory, "upstream", "feature/one");
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, "upstream/feature/one", config)).toEqual({
      kind: "found", value: { kind: "branch", branch: {
        kind: "remote", remote: "upstream", name: "feature/one", ref: "refs/remotes/upstream/feature/one",
      } },
    });
  });
});

test("an exact local branch wins over a checked-out ticket-prefix branch", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "worktree", "add", "-b", "ABU-834-one", join(directory, "prefix worktree"));
    await git(primary, "branch", "ABU-834");
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, "ABU-834", config)).toMatchObject({
      kind: "found", value: { kind: "branch", branch: { kind: "local", name: "ABU-834", ref: "refs/heads/ABU-834" } },
    });
  });
});

test("an exact remote branch wins over a checked-out ticket-prefix branch", async () => {
  await withRepository(async (primary, directory) => {
    await addOfflineRemote(primary, directory, "upstream", "ABU-834");
    await git(primary, "worktree", "add", "-b", "ABU-834-one", join(directory, "prefix worktree"));
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, "ABU-834", config)).toEqual({
      kind: "found", value: { kind: "branch", branch: {
        kind: "remote", remote: "upstream", name: "ABU-834", ref: "refs/remotes/upstream/ABU-834",
      } },
    });
  });
});

test("a unique ticket prefix reuses its checked-out worktree", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "existing ticket worktree");
    await git(primary, "worktree", "add", "-b", "ABU-834-one", linked);
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, "ABU-834", config)).toMatchObject({
      kind: "found", value: { kind: "worktree", worktree: { path: linked, branch: "ABU-834-one" } },
    });
  });
});

test("a checked-out ticket prefix and an unchecked prefix branch stay fully ambiguous", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "checked out prefix");
    await git(primary, "worktree", "add", "-b", "ABU-834-one", linked);
    await git(primary, "branch", "ABU-834_two");
    const repository = await discoverRepository(primary);
    const result = await resolveOpenTarget(repository, "ABU-834", config);

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(targetIdentities(result.candidates)).toEqual([
        "branch:refs/heads/ABU-834_two", `worktree:${linked}`,
      ]);
    }
  });
});

test("ticket matching includes every delimiter boundary in stable ref order", async () => {
  await withRepository(async (primary, directory) => {
    const names = ["ABU-834-one", "ABU-834_two", "ABU-834.three", "ABU-834/four"];
    for (const name of names) await git(primary, "branch", name);
    const repository = await discoverRepository(primary);
    const result = await resolveOpenTarget(repository, "ABU-834", config);

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(targetIdentities(result.candidates)).toEqual([
        "branch:refs/heads/ABU-834-one",
        "branch:refs/heads/ABU-834.three",
        "branch:refs/heads/ABU-834/four",
        "branch:refs/heads/ABU-834_two",
      ]);
    }
  });
});

test("ticket matching rejects numeric, nested, and leading substring collisions", async () => {
  await withRepository(async (primary, directory) => {
    for (const name of ["ABU-8342-wrong", "feature/ABU-834-one", "XABU-834-one"]) {
      await git(primary, "branch", name);
    }
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, "ABU-834", config)).toEqual({ kind: "not-found" });
  });
});

test("a known remote prefix takes precedence over a same-named local branch", async () => {
  await withRepository(async (primary, directory) => {
    await addOfflineRemote(primary, directory, "origin", "feature");
    await git(primary, "worktree", "add", "-b", "origin/feature", join(directory, "checked out local remote-name branch"));
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, "origin/feature", config)).toMatchObject({
      kind: "found", value: { kind: "branch", branch: {
        kind: "remote", remote: "origin", name: "feature", ref: "refs/remotes/origin/feature",
      } },
    });
  });
});

test("the configured remote filters same-named cached remote branches", async () => {
  await withRepository(async (primary, directory) => {
    await addOfflineRemote(primary, directory, "origin", "feature");
    await addOfflineRemote(primary, directory, "upstream", "feature");
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, "feature", withRemote("upstream"))).toEqual({
      kind: "found", value: { kind: "branch", branch: {
        kind: "remote", remote: "upstream", name: "feature", ref: "refs/remotes/upstream/feature",
      } },
    });
  });
});

test("a local branch reusing an exact upstream ref returns its existing worktree", async () => {
  await withRepository(async (primary, directory) => {
    await addOfflineRemote(primary, directory, "upstream", "feature");
    const linked = join(directory, "local branch tracks remote");
    await git(primary, "branch", "local-feature");
    await git(primary, "config", "branch.local-feature.remote", "upstream");
    await git(primary, "config", "branch.local-feature.merge", "refs/heads/feature");
    await git(primary, "worktree", "add", linked, "local-feature");
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, "upstream/feature", config)).toMatchObject({
      kind: "found", value: { kind: "worktree", worktree: { path: linked, branch: "local-feature" } },
    });
  });
});

for (const upstream of [null, "origin"] as const) {
  test(`same-named local branch with ${upstream ?? "no"} upstream does not claim another remote's identity`, async () => {
    await withRepository(async (primary, directory) => {
      await addOfflineRemote(primary, directory, "upstream", "feature");
      if (upstream === "origin") await addOfflineRemote(primary, directory, "origin", "feature");
      await git(primary, "branch", "feature");
      if (upstream === "origin") {
        await git(primary, "config", "branch.feature.remote", "origin");
        await git(primary, "config", "branch.feature.merge", "refs/heads/feature");
      }
      const linked = join(directory, `local feature with ${upstream ?? "no"} upstream`);
      await git(primary, "worktree", "add", linked, "feature");
      const repository = await discoverRepository(primary);

      expect(await resolveOpenTarget(repository, "upstream/feature", config)).toEqual({
        kind: "found", value: { kind: "branch", branch: {
          kind: "remote", remote: "upstream", name: "feature", ref: "refs/remotes/upstream/feature",
        } },
      });
    });
  });
}

test("local and remote ticket-prefix candidates deduplicate when they map to the same path", async () => {
  await withRepository(async (primary, directory) => {
    await addOfflineRemote(primary, directory, "upstream", "ABU-834-one");
    const linked = join(directory, "same local and remote target");
    await git(primary, "worktree", "add", "-b", "ABU-834-one", linked);
    await git(primary, "config", "branch.ABU-834-one.remote", "upstream");
    await git(primary, "config", "branch.ABU-834-one.merge", "refs/heads/ABU-834-one");
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, "ABU-834", withRemote("upstream"))).toMatchObject({
      kind: "found", value: { kind: "worktree", worktree: { path: linked } },
    });
  });
});

test("two checked-out local branches tracking one remote target remain ambiguous", async () => {
  await withRepository(async (primary, directory) => {
    await addOfflineRemote(primary, directory, "upstream", "feature");
    const first = join(directory, "first local worktree");
    const second = join(directory, "second local worktree");
    await git(primary, "branch", "first-local");
    await git(primary, "branch", "second-local");
    for (const branch of ["first-local", "second-local"]) {
      await git(primary, "config", `branch.${branch}.remote`, "upstream");
      await git(primary, "config", `branch.${branch}.merge`, "refs/heads/feature");
    }
    await git(primary, "worktree", "add", first, "first-local");
    await git(primary, "worktree", "add", second, "second-local");
    const repository = await discoverRepository(primary);
    const result = await resolveOpenTarget(repository, "upstream/feature", config);

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(targetIdentities(result.candidates)).toEqual([`worktree:${first}`, `worktree:${second}`]);
    }
  });
});

test("two registered paths for one branch remain ambiguous", async () => {
  await withRepository(async (primary, directory) => {
    const first = join(directory, "first shared-branch worktree");
    const second = join(directory, "second shared-branch worktree");
    await git(primary, "branch", "shared-branch");
    await git(primary, "worktree", "add", first, "shared-branch");
    await git(primary, "worktree", "add", "--force", second, "shared-branch");
    const repository = await discoverRepository(primary);
    const result = await resolveOpenTarget(repository, "shared-branch", config);

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(targetIdentities(result.candidates)).toEqual([`worktree:${first}`, `worktree:${second}`]);
    }
  });
});

test("an unregistered absolute path is not treated as a branch name", async () => {
  await withRepository(async (primary, directory) => {
    const repository = await discoverRepository(primary);
    expect(await resolveOpenTarget(repository, join(directory, "unregistered directory"), config))
      .toEqual({ kind: "not-found" });
  });
});

test("an absolute symlink path does not alias a registered worktree path", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "registered worktree");
    const alias = join(directory, "worktree alias");
    await git(primary, "worktree", "add", "-b", "registered", linked);
    await symlink(linked, alias);
    const repository = await discoverRepository(primary);

    expect(await resolveOpenTarget(repository, alias, config)).toEqual({ kind: "not-found" });
  });
});

test("empty and unknown branch inputs return not-found", async () => {
  await withRepository(async (primary, directory) => {
    const repository = await discoverRepository(primary);
    expect(await resolveOpenTarget(repository, "", config)).toEqual({ kind: "not-found" });
    expect(await resolveOpenTarget(repository, "not-a-branch", config)).toEqual({ kind: "not-found" });
  });
});

for (const inputKind of ["exact branch", "absolute path", "unique ticket prefix"] as const) {
  test(`a uniquely selected missing ${inputKind} rejects without pruning or changing other work`, async () => {
    await withRepository(async (primary, directory) => {
      const protectedTree = join(directory, "protected worktree");
      const stale = join(directory, "stale ABU-834 target");
      await preparePreservedWorktree(primary, protectedTree, "protected-work");
      await git(primary, "worktree", "add", "-b", "ABU-834-one", stale);
      await rm(stale, { recursive: true });
      const repository = await discoverRepository(primary);
      const before = await preservedState(primary, protectedTree);
      const input = inputKind === "exact branch" ? "ABU-834-one"
        : inputKind === "absolute path" ? stale : "ABU-834";

      await expect(resolveOpenTarget(repository, input, config)).rejects.toThrow(stale);
      await expect(access(stale)).rejects.toThrow();
      expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(before.inventory);
      expect(await git(primary, "show-ref")).toBe(before.refs);
      await expectPreservedState(primary, protectedTree, before);
    });
  });
}

test("an ambiguous prefix retains healthy and missing worktree candidates", async () => {
  await withRepository(async (primary, directory) => {
    const healthy = join(directory, "a healthy prefix worktree");
    const stale = join(directory, "z stale prefix worktree");
    await preparePreservedWorktree(primary, healthy, "ABU-834-good");
    await git(primary, "worktree", "add", "-b", "ABU-834-stale", stale);
    await rm(stale, { recursive: true });
    const repository = await discoverRepository(primary);
    const before = await preservedState(primary, healthy);
    const result = await resolveOpenTarget(repository, "ABU-834", config);

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(targetIdentities(result.candidates)).toEqual([`worktree:${healthy}`, `worktree:${stale}`]);
      expect(result.candidates).toMatchObject([
        { kind: "worktree", worktree: { path: healthy, pathExists: true, status: { kind: "known" } } },
        { kind: "worktree", worktree: { path: stale, pathExists: false, status: { kind: "unknown" } } },
      ]);
    }
    expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(before.inventory);
    expect(await git(primary, "show-ref")).toBe(before.refs);
    await expect(access(stale)).rejects.toThrow();
    await expectPreservedState(primary, healthy, before);
  });
});

for (const replacement of ["unrelated repository", "symlink", "copied sibling gitfile"] as const) {
  test(`opening a selected path replaced by a ${replacement} refuses and preserves both locations`, async () => {
    await withRepository(async (primary, directory) => {
      const selected = join(directory, "selected ABU-834 worktree");
      const sibling = join(directory, "protected sibling worktree");
      await preparePreservedWorktree(primary, sibling, "protected-sibling");
      await git(primary, "worktree", "add", "-b", "ABU-834-one", selected);
      await rm(selected, { recursive: true });
      const selectedSentinel = join(selected, "selected-sentinel.txt");
      const siblingSentinel = join(sibling, "sibling-sentinel.txt");
      await writeFile(siblingSentinel, "sibling sentinel\n");
      if (replacement === "unrelated repository") {
        await mkdir(selected);
        await git(selected, "init", "-b", "unrelated");
        await writeFile(selectedSentinel, "selected sentinel\n");
      } else if (replacement === "symlink") {
        await symlink(sibling, selected);
        await writeFile(selectedSentinel, "selected sentinel through alias\n");
      } else {
        await mkdir(selected);
        await writeFile(join(selected, ".git"), await readFile(join(sibling, ".git")));
        await git(selected, "checkout-index", "--all");
        await writeFile(selectedSentinel, "selected sentinel\n");
      }

      const repository = await discoverRepository(primary);
      const before = await preservedState(primary, sibling);
      await expect(resolveOpenTarget(repository, "ABU-834-one", config)).rejects.toThrow(selected);
      expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(before.inventory);
      expect(await git(primary, "show-ref")).toBe(before.refs);
      expect(await readFile(siblingSentinel, "utf8")).toBe("sibling sentinel\n");
      expect(await readFile(selectedSentinel, "utf8")).toBe(
        replacement === "symlink" ? "selected sentinel through alias\n" : "selected sentinel\n",
      );
      await expectPreservedState(primary, sibling, before);
    });
  });
}

test("offline exact, path, prefix, and upstream reuse preserve a locked dirty worktree", async () => {
  await withRepository(async (primary, directory) => {
    await addOfflineRemote(primary, directory, "upstream", "ABU-834-one");
    const remoteUrl = join(directory, "upstream unavailable.git");
    const linked = join(directory, "locked\nwith\tcontrols");
    await preparePreservedWorktree(primary, linked, "ABU-834-one");
    await git(primary, "config", "branch.ABU-834-one.remote", "upstream");
    await git(primary, "config", "branch.ABU-834-one.merge", "refs/heads/ABU-834-one");
    const gitDirectory = await git(linked, "rev-parse", "--absolute-git-dir");
    await writeFile(join(gitDirectory, "index"), "corrupt index fixture\n");
    const repository = await discoverRepository(primary);
    const before = await preservedState(primary, linked);
    expect(await git(primary, "remote", "get-url", "upstream")).toBe(remoteUrl);

    for (const input of ["ABU-834-one", linked, "ABU-834", "upstream/ABU-834-one"]) {
      const result = await resolveOpenTarget(repository, input, withRemote("upstream"));
      expect(result).toMatchObject({
        kind: "found", value: { kind: "worktree", worktree: {
          path: linked, branch: "ABU-834-one", locked: { reason: "preserve during resolution" },
          status: { kind: "unknown" },
        } },
      });
      await expectPreservedState(primary, linked, before);
      expect(await git(primary, "remote", "get-url", "upstream")).toBe(remoteUrl);
    }
  });
});

test("an offline remote-only target returns its cached branch without refreshing refs", async () => {
  await withRepository(async (primary, directory) => {
    await addOfflineRemote(primary, directory, "upstream", "cached-only");
    const repository = await discoverRepository(primary);
    const refsBefore = await git(primary, "show-ref");
    const remoteUrl = await git(primary, "remote", "get-url", "upstream");
    await expect(access(remoteUrl)).rejects.toThrow();

    expect(await resolveOpenTarget(repository, "upstream/cached-only", config)).toEqual({
      kind: "found", value: { kind: "branch", branch: {
        kind: "remote", remote: "upstream", name: "cached-only", ref: "refs/remotes/upstream/cached-only",
      } },
    });
    expect(await git(primary, "show-ref")).toBe(refsBefore);
    expect(await git(primary, "remote", "get-url", "upstream")).toBe(remoteUrl);
  });
});
