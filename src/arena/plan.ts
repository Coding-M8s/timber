import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { planWorktree } from "../git/worktree-plan";
import type {
  RepositoryConfig,
  RepositoryContext,
  ValidatedBase,
} from "../types";
import type {
  ArenaPlan,
  ArenaDraft,
  ArenaSourceSelection,
  PlannedParticipant,
} from "./types";
import { validateArenaName } from "./participants";

/** Validate the complete batch before reserving metadata or creating its first worktree. */
async function planDestinations(
  repository: RepositoryContext,
  config: RepositoryConfig,
  name: string,
  participants: readonly PlannedParticipant[],
  knownRemoteBranches: readonly string[] = [],
): Promise<{ name: string; attempts: ArenaPlan["attempts"] }> {
  validateArenaName(name);
  if (participants.length < 2)
    throw new Error("An arena requires at least 2 attempts.");
  const common = await realpath(repository.commonGitDir);
  try {
    await lstat(join(common, "timber", "arenas", name));
    throw new Error(
      "Arena already exists; inspect its retained state or choose another name.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const attempts = [];
  const paths = new Set<string>();
  for (const participant of participants) {
    const branch = `arena/${name}/${participant.label}`;
    if (
      knownRemoteBranches.some(
        (remote) =>
          remote === branch ||
          remote.startsWith(branch + "/") ||
          branch.startsWith(remote + "/"),
      )
    ) {
      throw new Error(
        "Known remote attempt branch collision; choose another arena name. Existing remote work was not reused.",
      );
    }
    const planned = await planWorktree(
      repository,
      { kind: "new", branch },
      config,
    );
    if (paths.has(planned.path))
      throw new Error("Arena attempt destinations collide.");
    paths.add(planned.path);
    attempts.push({ ...participant, branch, path: planned.path });
  }
  return { name, attempts };
}

export async function planArena(
  repository: RepositoryContext,
  config: RepositoryConfig,
  name: string,
  participants: readonly PlannedParticipant[],
  base: ValidatedBase,
): Promise<ArenaPlan> {
  return {
    ...(await planDestinations(repository, config, name, participants)),
    base,
  };
}
export async function planArenaDraft(
  repository: RepositoryContext,
  config: RepositoryConfig,
  name: string,
  participants: readonly PlannedParticipant[],
  source: ArenaSourceSelection,
): Promise<ArenaDraft> {
  return {
    ...(await planDestinations(
      repository,
      config,
      name,
      participants,
      source.knownRemoteBranches,
    )),
    source,
  };
}
