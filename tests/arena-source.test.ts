import { expect, test } from "bun:test";
import { join } from "node:path";
import { withRepository, git } from "./helpers/git";
import { discoverRepository } from "../src/git/repository";
import type { RepositoryConfig } from "../src/types";
const config: RepositoryConfig = {
  baseBranch: "trunk",
  remote: null,
  worktreeDir: null,
  editor: null,
  agent: null,
};

test("ticket finds unpublished local branch without worktree and remains offline", async () => {
  const { resolveArenaSource } = await import("../src/arena/source");
  await withRepository(async (primary, directory) => {
    await git(primary, "branch", "feature/TIM-123-api");
    await git(primary, "remote", "add", "offline", join(directory, "missing"));
    const before = await git(primary, "show-ref"),
      trees = await git(primary, "worktree", "list", "--porcelain");
    const result = await resolveArenaSource(
      await discoverRepository(primary),
      config,
      { ticket: "TIM-123" },
    );
    expect(result.kind).toBe("found");
    if (result.kind !== "found") throw new Error("missing source");
    expect(result.value.kind).toBe("local");
    expect(result.value.selector).toBe("refs/heads/feature/TIM-123-api");
    expect(result.value.provenance).toBe("ticket");
    expect(await git(primary, "show-ref")).toBe(before);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
  });
});

test("remote-only uncached ticket branch discovered without fetching or making source worktree", async () => {
  const { resolveArenaSource } = await import("../src/arena/source");
  await withRepository(async (primary, directory) => {
    const bare = join(directory, "upstream.git");
    await git(directory, "init", "--bare", bare);
    await git(primary, "remote", "add", "upstream", bare);
    await git(primary, "push", "upstream", "trunk:feature/TIM-123-api");
    await git(
      primary,
      "update-ref",
      "-d",
      "refs/remotes/upstream/feature/TIM-123-api",
    );
    const before = await git(primary, "show-ref"),
      trees = await git(primary, "worktree", "list", "--porcelain");
    const result = await resolveArenaSource(
      await discoverRepository(primary),
      config,
      { ticket: "TIM-123" },
    );
    expect(result.kind).toBe("found");
    if (result.kind !== "found" || result.value.kind !== "remote")
      throw new Error("missing remote");
    expect(result.value.branch.name).toBe("feature/TIM-123-api");
    expect(result.value.advertisedCommit).toBe(
      await git(primary, "rev-parse", "HEAD"),
    );
    expect(await git(primary, "show-ref")).toBe(before);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
  });
});

test("ticket boundaries produce stable ambiguous selectors and exclude longer keys", async () => {
  const { resolveArenaSource } = await import("../src/arena/source");
  await withRepository(async (primary) => {
    for (const branch of [
      "feature/TIM-123-api",
      "user/TIM-123.test",
      "feature/TIM-1234-other",
      "notTIM-123-work",
    ])
      await git(primary, "branch", branch);
    const result = await resolveArenaSource(
      await discoverRepository(primary),
      config,
      { ticket: "TIM-123" },
    );
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("missing ambiguity");
    expect(result.candidates.map((c) => c.selector)).toEqual([
      "refs/heads/feature/TIM-123-api",
      "refs/heads/user/TIM-123.test",
    ]);
    const explicit = await resolveArenaSource(
      await discoverRepository(primary),
      config,
      { ticket: "TIM-123", base: "feature/TIM-123-api" },
    );
    expect(explicit.kind).toBe("found");
    if (explicit.kind === "found")
      expect(explicit.value.provenance).toBe("explicit");
  });
});

test("missing ticket source falls back only after successful discovery; missing explicit base fails", async () => {
  const { resolveArenaSource } = await import("../src/arena/source");
  await withRepository(async (primary, directory) => {
    const repo = await discoverRepository(primary);
    const result = await resolveArenaSource(repo, config, {
      ticket: "TIM-123",
    });
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.value.selector).toBe("refs/heads/trunk");
      expect(result.value.ticketBranchMissing).toBe(true);
    }
    await expect(
      resolveArenaSource(repo, config, { base: "missing" }),
    ).rejects.toThrow(/missing/i);
    await git(primary, "remote", "add", "offline", join(directory, "absent"));
    await expect(
      resolveArenaSource(await discoverRepository(primary), config, {
        ticket: "TIM-123",
      }),
    ).rejects.toThrow(/remote/i);
  });
});

test("explicit remote selector chooses its live branch despite local branch and multiple remotes", async () => {
  const { resolveArenaSource } = await import("../src/arena/source");
  await withRepository(async (primary, directory) => {
    const bare = join(directory, "upstream.git");
    await git(directory, "init", "--bare", bare);
    await git(primary, "remote", "add", "upstream", bare);
    await git(primary, "push", "upstream", "trunk:feature/source");
    await git(primary, "branch", "feature/source");
    await git(primary, "remote", "add", "offline", join(directory, "missing"));
    const result = await resolveArenaSource(
      await discoverRepository(primary),
      config,
      { base: "upstream/feature/source" },
    );
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.value.kind).toBe("remote");
      expect(result.value.selector).toBe(
        "refs/remotes/upstream/feature/source",
      );
    }
  });
});

test("ticket input keeps original context and derives independent validated arena identity", async () => {
  const { arenaIdentity } = await import("../src/arena/source");
  expect(arenaIdentity("TIM-123")).toEqual({
    name: "tim-123",
    ticket: "TIM-123",
  });
  expect(arenaIdentity("TIM-123", "api-slice")).toEqual({
    name: "api-slice",
    ticket: "TIM-123",
  });
  expect(arenaIdentity("demo")).toEqual({ name: "demo" });
  expect(() => arenaIdentity("TIM-123", "../escape")).toThrow(/name/);
});

test("confirmed remote refresh pins advertised commit and creates no source worktree", async () => {
  const { resolveArenaSource, finalizeArenaSource } =
    await import("../src/arena/source");
  await withRepository(async (primary, directory) => {
    const bare = join(directory, "upstream.git");
    await git(directory, "init", "--bare", bare);
    await git(primary, "remote", "add", "upstream", bare);
    await git(primary, "push", "upstream", "trunk:feature/TIM-123");
    await git(
      primary,
      "update-ref",
      "-d",
      "refs/remotes/upstream/feature/TIM-123",
    );
    const repo = await discoverRepository(primary),
      selection = await resolveArenaSource(repo, config, {
        base: "upstream/feature/TIM-123",
      });
    if (selection.kind !== "found") throw new Error("missing source");
    const base = await finalizeArenaSource(repo, config, selection.value);
    expect(base.commit).toBe(await git(primary, "rev-parse", "trunk"));
    expect(
      await git(primary, "rev-parse", "refs/remotes/upstream/feature/TIM-123"),
    ).toBe(base.commit);
    expect(
      (await git(primary, "worktree", "list", "--porcelain")).match(
        /^worktree /gm,
      ),
    ).toHaveLength(1);
    await expect(
      git(primary, "show-ref", "--verify", "refs/heads/feature/TIM-123"),
    ).rejects.toThrow();
  });
});

test("remote moves after review: refresh stops before worktrees and names changed cache", async () => {
  const { resolveArenaSource, finalizeArenaSource } =
    await import("../src/arena/source");
  await withRepository(async (primary, directory) => {
    const bare = join(directory, "upstream.git");
    await git(directory, "init", "--bare", bare);
    await git(primary, "remote", "add", "upstream", bare);
    await git(primary, "push", "upstream", "trunk:feature/source");
    const repo = await discoverRepository(primary),
      selection = await resolveArenaSource(repo, config, {
        base: "upstream/feature/source",
      });
    if (selection.kind !== "found") throw new Error("missing source");
    const newer = await git(
      primary,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit-tree",
      await git(primary, "rev-parse", "HEAD^{tree}"),
      "-p",
      await git(primary, "rev-parse", "HEAD"),
      "-m",
      "moved",
    );
    await git(
      primary,
      "push",
      "upstream",
      `${newer}:refs/heads/feature/source`,
    );
    await expect(
      finalizeArenaSource(repo, config, selection.value),
    ).rejects.toThrow(/changed|moved/i);
    expect(
      (await git(primary, "worktree", "list", "--porcelain")).match(
        /^worktree /gm,
      ),
    ).toHaveLength(1);
  });
});

test("failed confirmed fetch never falls back to a cached source or creates worktrees", async () => {
  const { resolveArenaSource, finalizeArenaSource } =
    await import("../src/arena/source");
  await withRepository(async (primary, directory) => {
    const bare = join(directory, "upstream.git");
    await git(directory, "init", "--bare", bare);
    await git(primary, "remote", "add", "upstream", bare);
    await git(primary, "push", "upstream", "trunk:feature/source");
    const repo = await discoverRepository(primary),
      selection = await resolveArenaSource(repo, config, {
        base: "upstream/feature/source",
      });
    if (selection.kind !== "found") throw new Error("missing source");
    const refs = await git(primary, "show-ref");
    await git(
      primary,
      "remote",
      "set-url",
      "upstream",
      join(directory, "missing"),
    );
    await expect(
      finalizeArenaSource(repo, config, selection.value),
    ).rejects.toThrow(/refresh failed/i);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(
      (await git(primary, "worktree", "list", "--porcelain")).match(
        /^worktree /gm,
      ),
    ).toHaveLength(1);
  });
});

test("missing ticket can use configured base on a different remote after discovery", async () => {
  const { resolveArenaSource } = await import("../src/arena/source");
  await withRepository(async (primary, directory) => {
    for (const name of ["origin", "upstream"]) {
      const bare = join(directory, `${name}.git`);
      await git(directory, "init", "--bare", bare);
      await git(primary, "remote", "add", name, bare);
      await git(primary, "push", name, "trunk:main");
    }
    const refs = await git(primary, "show-ref");
    const result = await resolveArenaSource(
      await discoverRepository(primary),
      { ...config, remote: "origin", baseBranch: "upstream/main" },
      { ticket: "TIM-123" },
    );
    expect(result.kind).toBe("found");
    if (result.kind !== "found" || result.value.kind !== "remote")
      throw new Error("missing remote base");
    expect(result.value.selector).toBe("refs/remotes/upstream/main");
    expect(result.value.ticketBranchMissing).toBe(true);
    expect(result.value.provenance).toBe("config");
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});
