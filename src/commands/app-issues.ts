import { defaultIssueTimeoutMs, defaultTrackerRuntime } from "../app-issue/read";
import { readAppIssues } from "../app-issues/read";
import type { AppIssuesOptions } from "../app-issues/read";
import { loadRepositoryConfig } from "../config";
import { resolveGithubRepository } from "../github/repository";
import { readIssueLink } from "../git/issue-link";
import { discoverRepository } from "../git/repository";
import { listWorktreeInventory } from "../git/worktrees";
import type { CommandContext } from "../services";
import { repositoryOf } from "../credential-selection";

/**
 * Experimental read-only issue lists for app consumers. Prints one JSON object
 * to stdout and exits 1 only when the outcome is failed.
 */
export async function runAppIssues(query: string, text: string | undefined, options: AppIssuesOptions, context: CommandContext,
  env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const record = await readAppIssues(context.cwd, query, text, options, {
    discoverRepository: cwd => discoverRepository(cwd),
    loadConfig: repository => loadRepositoryConfig(repository, env),
    listWorktreeInventory: repository => listWorktreeInventory(repository),
    readIssueLink: (repository, tree) => readIssueLink(repository, tree),
    githubRepository: (repository, config) => resolveGithubRepository(repository, config),
    trackers: defaultTrackerRuntime(env, repositoryOf(context.cwd)),
    timeoutMs: defaultIssueTimeoutMs,
    now: () => new Date(),
  });
  context.io.stdout(JSON.stringify(record) + "\n");
  return record.outcome === "failed" ? 1 : 0;
}
