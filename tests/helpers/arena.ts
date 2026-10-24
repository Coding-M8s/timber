import { join } from "node:path";
import { withRepository } from "./git";
import { discoverRepository } from "../../src/git/repository";
import { resolveBase } from "../../src/git/branches";
import { createWorktree } from "../../src/git/create-worktree";
import { planArena } from "../../src/arena/plan";
import { resolveArenaGroups } from "../../src/arena/participants";
import { reserveArena, readArena } from "../../src/arena/storage";
import type { RepositoryConfig, RepositoryContext } from "../../src/types";
import type { ArenaAttemptGroup, ArenaManifest } from "../../src/arena/types";

export const arenaConfig: RepositoryConfig = {
  baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null,
};
export interface ArenaFixture {
  primary: string;
  directory: string;
  repository: RepositoryContext;
  config: RepositoryConfig;
  manifest: ArenaManifest;
  taskPath: string;
  manifestPath: string;
  lockPath: string;
}
export async function withArena(
  run: (fixture: ArenaFixture) => Promise<void>,
  config: RepositoryConfig = arenaConfig,
  groups: readonly ArenaAttemptGroup[] = [{ kind: "harness", harness: "manual", model: null, count: 2 }],
): Promise<void> {
  await withRepository(async (primary, directory) => {
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config, "trunk");
    const plan = await planArena(repository, config, "demo", resolveArenaGroups(config, groups), base);
    const session = await reserveArena(repository, plan, Buffer.from("PRIVATE_TASK_SENTINEL\n' $(touch NEVER)\n"));
    try {
      for (const a of plan.attempts) {
        const tree = await createWorktree(repository, { kind: "new", branch: a.branch, base, expectedPath: a.path }, config);
        await session.bind(a.id, tree);
      }
      for (const a of session.manifest.attempts) a.stage = "ready";
      await session.save();
    } finally { await session.close(); }
    const saved = await readArena(repository, "demo");
    const recordDirectory = join(repository.commonGitDir, "timber/arenas/demo");
    await run({ primary, directory, repository, config, ...saved,
      manifestPath: join(recordDirectory, "manifest.json"), lockPath: join(recordDirectory, "active.lock") });
  });
}
