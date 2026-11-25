import { defaultReviewerRuntimes, defaultReviewersTimeoutMs, readAppReviewers } from "../app-reviewers/read";
import { loadRepositoryConfig } from "../config";
import { readBaseAssociation } from "../git/base-metadata";
import { discoverRepository } from "../git/repository";
import { listWorktreeInventory } from "../git/worktrees";
import type { CommandContext } from "../services";

/**
 * Experimental read-only reviewer list for app consumers. Prints one JSON object
 * to stdout and exits 1 only when the outcome is failed.
 */
export async function runAppReviewers(worktree: string, context: CommandContext, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const record = await readAppReviewers(context.cwd, worktree, {
    discoverRepository: cwd => discoverRepository(cwd),
    loadConfig: repository => loadRepositoryConfig(repository, env),
    listWorktreeInventory: repository => listWorktreeInventory(repository),
    readBase: (repository, tree) => readBaseAssociation(repository, tree),
    env, ...defaultReviewerRuntimes(env), timeoutMs: defaultReviewersTimeoutMs,
  });
  context.io.stdout(JSON.stringify(record) + "\n");
  return record.outcome === "failed" ? 1 : 0;
}
