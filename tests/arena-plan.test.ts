import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withRepository, git } from "./helpers/git";
import { discoverRepository } from "../src/git/repository";
import { resolveBase } from "../src/git/branches";
import { resolveArenaParticipants } from "../src/arena/participants";
import type { RepositoryConfig } from "../src/types";
const config: RepositoryConfig = {
  baseBranch: null,
  remote: null,
  worktreeDir: null,
  editor: null,
  agent: null,
};

test("later attempt collision blocks whole arena without refs, worktrees, or metadata writes", async () => {
  const { planArena } = await import("../src/arena/plan");
  await withRepository(async (primary, directory) => {
    const repo = await discoverRepository(primary),
      base = await resolveBase(repo, config, "trunk");
    const root = join(directory, "primary repo-worktrees");
    await mkdir(root);
    const collision = join(root, "arena-demo-manual-2");
    await mkdir(collision);
    await writeFile(join(collision, "keep"), "keep");
    const refs = await git(primary, "show-ref"),
      trees = await git(primary, "worktree", "list", "--porcelain");
    await expect(
      planArena(
        repo,
        config,
        "demo",
        resolveArenaParticipants(config, ["manual:2"]),
        base,
      ),
    ).rejects.toThrow(/exists/);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
    expect(await readFile(join(collision, "keep"), "utf8")).toBe("keep");
  });
});

test("arena validates names and Git ref namespace conflicts before creation", async () => {
  const { planArena } = await import("../src/arena/plan");
  await withRepository(async (primary) => {
    const repo = await discoverRepository(primary),
      base = await resolveBase(repo, config, "trunk");
    const participants = resolveArenaParticipants(config, ["manual:2"]);
    for (const name of ["../escape", "A", "a/other", ""])
      await expect(
        planArena(repo, config, name, participants, base),
      ).rejects.toThrow(/name/);
    await git(primary, "branch", "arena/demo");
    await expect(
      planArena(repo, config, "demo", participants, base),
    ).rejects.toThrow(/namespace/);
  });
});

test("known remote attempt collision blocks destination draft before any fetch or creation", async () => {
  const { planArenaDraft } = await import("../src/arena/plan");
  await withRepository(async (primary) => {
    const repo = await discoverRepository(primary),
      base = await resolveBase(repo, config, "trunk");
    const source = {
      kind: "local" as const,
      selector: base.ref,
      base,
      provenance: "explicit" as const,
      knownRemoteBranches: ["arena/demo/manual-2"],
      ticketBranchMissing: false,
    };
    const refs = await git(primary, "show-ref");
    await expect(
      planArenaDraft(
        repo,
        config,
        "demo",
        resolveArenaParticipants(config, ["manual:2"]),
        source,
      ),
    ).rejects.toThrow(/remote.*collision|collision.*remote/i);
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});
