import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { knownSecrets, safeAppDiagnostic } from "../app-config/input";
import { readGithubToken } from "../github/auth";
import type { IssueLinkRead } from "../git/issue-link";
import { loadSavedCredentials } from "../jira/credentials";
import { readLinearKey } from "../linear/auth";
import { samePath } from "../platform/paths";
import type { RepositoryConfig, RepositoryContext, Worktree, WorktreeInventory } from "../types";
import { IssueReadFailure, readLinkedIssue } from "./trackers";
import type { IssueReadReason, IssueSummary, IssueTrackerRuntime } from "./trackers";

export interface AppIssueRecord {
  schemaVersion: 1;
  repository: { commonGitDir: string; primaryWorktreeRoot: string; currentWorktreeRoot: string } | null;
  /** The selected worktree; null when the repository could not be read or nothing matched. */
  worktree: { path: string; branch: string | null; isPrimary: boolean } | null;
  outcome: "found" | "none" | "failed";
  /** Non-null only when found. */
  issue: IssueSummary | null;
  /** Non-null only when failed. */
  reason: IssueReadReason | null;
  diagnostic: string | null;
}

/** Local reads are real Git; tracker access is the seam. `timeoutMs` bounds the login read and the request together. */
export interface AppIssueServices {
  discoverRepository(cwd: string): Promise<RepositoryContext>;
  loadConfig(repository: RepositoryContext): Promise<RepositoryConfig>;
  listWorktreeInventory(repository: RepositoryContext): Promise<readonly WorktreeInventory[]>;
  readIssueLink(repository: RepositoryContext, worktree: Worktree): Promise<IssueLinkRead>;
  trackers: Omit<IssueTrackerRuntime, "secret">;
  timeoutMs: number;
}

export const defaultIssueTimeoutMs = 15_000;

const invalidLink: Record<Exclude<IssueLinkRead, { kind: "linked" | "none" }>["reason"], string> = {
  stale: "The saved issue link belongs to another worktree registration. Link this worktree again with timber open --issue <issue> --replace-issue.",
  malformed: "The saved issue link is malformed; inspect the worktree's private Git metadata before linking an issue again.",
  unreadable: "The saved issue link cannot be read; check the permissions of the worktree's private Git metadata.",
};

async function selectWorktree(trees: readonly WorktreeInventory[], input: string): Promise<WorktreeInventory | undefined> {
  if (!isAbsolute(input)) return trees.find(tree => tree.branch === input);
  const direct = trees.find(tree => samePath(tree.path, input));
  if (direct) return direct;
  // A symlinked spelling of a registered path still names that worktree.
  const real = await realpath(input).catch(() => null);
  if (real === null) return undefined;
  for (const tree of trees) {
    if (await realpath(tree.path).then(path => samePath(path, real), () => false)) return tree;
  }
  return undefined;
}

/**
 * One read-only answer for the issue linked to one worktree, named by absolute
 * path or exact branch. Never prompts, writes, fetches or changes a ref. No
 * tracker is contacted and no login is read unless a valid link exists.
 */
export async function readAppIssue(cwd: string, input: string, services: AppIssueServices): Promise<AppIssueRecord> {
  const record: AppIssueRecord = { schemaVersion: 1, repository: null, worktree: null,
    outcome: "failed", issue: null, reason: null, diagnostic: null };
  const secrets = knownSecrets(services.trackers.env);
  const fail = (reason: IssueReadReason, error: unknown, fallback: string) => {
    Object.assign(record, { outcome: "failed", issue: null, reason,
      diagnostic: safeAppDiagnostic(error, [...secrets].sort((a, b) => b.length - a.length), fallback) });
    return record;
  };
  let repository: RepositoryContext;
  let config: RepositoryConfig;
  let tree: WorktreeInventory | undefined;
  try {
    repository = await services.discoverRepository(cwd);
    record.repository = { commonGitDir: await realpath(repository.commonGitDir),
      primaryWorktreeRoot: repository.primaryWorktreeRoot, currentWorktreeRoot: repository.currentWorktreeRoot };
    config = await services.loadConfig(repository);
    tree = await selectWorktree(await services.listWorktreeInventory(repository), input);
  } catch (error) {
    return fail("failed", error, "Cannot read this repository's worktrees.");
  }
  if (!tree) {
    return fail("failed", new Error("No registered worktree matches that path or branch. Pass an absolute worktree path or an exact branch name from timber ls --json."), "");
  }
  record.worktree = { path: tree.path, branch: tree.branch, isPrimary: tree.isPrimary };
  const link = await services.readIssueLink(repository, { ...tree, pathExists: true,
    status: { kind: "unknown", reason: "not inspected" } });
  if (link.kind === "none") return Object.assign(record, { outcome: "none" });
  if (link.kind === "invalid") return fail("failed", new Error(invalidLink[link.reason]), "");

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = () => new IssueReadFailure("offline", "The issue tracker did not answer in time; check connectivity and try again.");
  // The race keeps the time limit even if a request ignores its abort signal.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(late()); }, services.timeoutMs);
  });
  const runtime: IssueTrackerRuntime = { ...services.trackers, secret: value => { if (value) secrets.push(value); } };
  try {
    const issue = await Promise.race([readLinkedIssue({ tracker: link.tracker, key: link.key, url: link.url },
      config.jira, runtime, controller.signal), deadline]);
    return Object.assign(record, { outcome: "found", issue });
  } catch (error) {
    if (error instanceof IssueReadFailure) return fail(error.reason, error, "");
    if (controller.signal.aborted) return fail("offline", late(), "");
    return fail("failed", new Error("Issue lookup failed."), "");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function defaultTrackerRuntime(env: NodeJS.ProcessEnv): AppIssueServices["trackers"] {
  return {
    env,
    fetch: (url, init) => fetch(url, init),
    githubToken: signal => readGithubToken(signal, { env }),
    linearToken: signal => readLinearKey(env, undefined, signal),
    jiraCredentials: config => loadSavedCredentials(config, env),
  };
}
