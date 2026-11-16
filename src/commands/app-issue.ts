import { defaultIssueTimeoutMs, defaultTrackerRuntime, readAppIssue } from "../app-issue/read";
import { loadRepositoryConfig } from "../config";
import { readIssueLink } from "../git/issue-link";
import { discoverRepository } from "../git/repository";
import { listWorktreeInventory } from "../git/worktrees";
import type { CommandContext } from "../services";
import { repositoryOf } from "../credential-selection";

/**
 * Experimental read-only issue transport for app consumers. Prints one JSON
 * object to stdout and exits 1 only when the outcome is failed.
 */
export async function runAppIssue(worktree: string, context: CommandContext, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const record = await readAppIssue(context.cwd, worktree, {
    discoverRepository: cwd => discoverRepository(cwd),
    loadConfig: repository => loadRepositoryConfig(repository, env),
    listWorktreeInventory: repository => listWorktreeInventory(repository),
    readIssueLink: (repository, tree) => readIssueLink(repository, tree),
    trackers: defaultTrackerRuntime(env, repositoryOf(context.cwd)),
    timeoutMs: defaultIssueTimeoutMs,
  });
  context.io.stdout(JSON.stringify(record) + "\n");
  return record.outcome === "failed" ? 1 : 0;
}
