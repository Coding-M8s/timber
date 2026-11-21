import { defaultAppBitbucketRuntime, defaultGithubRuntime, readAppPullRequests } from "../app-pr/read";
import { loadRepositoryConfig } from "../config";
import { listBranches } from "../git/branches";
import { discoverRepository } from "../git/repository";
import { listWorktreeInventory } from "../git/worktrees";
import type { CommandContext } from "../services";

/**
 * Experimental read-only pull request transport for app consumers. Prints one
 * JSON object to stdout and exits 1 when the repository or any lookup failed.
 */
export async function runAppPullRequests(context: CommandContext, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const record = await readAppPullRequests(context.cwd, {
    discoverRepository: cwd => discoverRepository(cwd),
    loadConfig: repository => loadRepositoryConfig(repository, env),
    listWorktreeInventory: repository => listWorktreeInventory(repository),
    listBranches: repository => listBranches(repository),
    env, github: defaultGithubRuntime(env), bitbucket: defaultAppBitbucketRuntime(env),
  });
  context.io.stdout(JSON.stringify(record) + "\n");
  return record.diagnostic === null && record.worktrees.every(entry => entry.outcome !== "failed") ? 0 : 1;
}
