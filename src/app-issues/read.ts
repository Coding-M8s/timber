import { realpath } from "node:fs/promises";
import { knownSecrets, safeAppDiagnostic } from "../app-config/input";
import { IssueReadFailure } from "../app-issue/trackers";
import type { IssueReadReason, IssueSummary, IssueTrackerRuntime } from "../app-issue/trackers";
import type { IssueLinkRead, LinkedTracker } from "../git/issue-link";
import { githubTicketKey } from "../github/client";
import type { GithubRepository } from "../github/repository";
import { predictTicketBranch } from "../jira/branch";
import type { RepositoryConfig, RepositoryContext, Worktree, WorktreeInventory } from "../types";
import { listGithub } from "./github";
import { listJira } from "./jira";
import { listLinear } from "./linear";
import { NotConfigured } from "./lists";
import type { IssueList, IssueQuery, LinkedPullRequest, ListContext, PullRequestLinks, SprintInfo } from "./lists";

export type IssueListReason = IssueReadReason | "not-configured";

export interface ListedIssue extends IssueSummary {
  /** The registered worktree whose saved issue link names this issue; null when none does. */
  worktree: { path: string; branch: string | null } | null;
  /** Open pull requests the tracker links to this issue; null when the links could not be read. */
  pullRequests: LinkedPullRequest[] | null;
  /** Whether the issue is assigned to the signed-in account; false when unassigned, null when unknown. */
  assignedToMe: boolean | null;
  /**
   * The branch `timber new <tracker>:<key>` would generate for this issue with the
   * current settings and title; null when `new` could not use a generated name
   * without asking, or when the issue is not the one `new` would look up.
   */
  branch: string | null;
}

export interface AppIssuesRecord {
  schemaVersion: 1;
  repository: { commonGitDir: string; primaryWorktreeRoot: string; currentWorktreeRoot: string } | null;
  /** Null only when the query argument was not one Timber knows. */
  query: IssueQuery | null;
  /** Null when no tracker was named and none is configured, or the input was invalid. */
  tracker: LinkedTracker | null;
  outcome: "found" | "none" | "failed";
  /** Non-null only for a found sprint. */
  sprint: SprintInfo | null;
  issues: ListedIssue[];
  truncated: boolean;
  reason: IssueListReason | null;
  diagnostic: string | null;
}

export interface AppIssuesOptions { tracker?: string; limit?: string; assigned?: boolean }

/** Local reads are real Git; tracker access is the seam. `timeoutMs` bounds the login read and every request together. */
export interface AppIssuesServices {
  discoverRepository(cwd: string): Promise<RepositoryContext>;
  loadConfig(repository: RepositoryContext): Promise<RepositoryConfig>;
  listWorktreeInventory(repository: RepositoryContext): Promise<readonly WorktreeInventory[]>;
  readIssueLink(repository: RepositoryContext, worktree: Worktree): Promise<IssueLinkRead>;
  githubRepository(repository: RepositoryContext, config: RepositoryConfig): Promise<GithubRepository>;
  trackers: Omit<IssueTrackerRuntime, "secret">;
  timeoutMs: number;
  now: () => Date;
}

const queries: readonly IssueQuery[] = ["sprint", "assigned", "open", "search"];
const trackers: readonly LinkedTracker[] = ["github", "jira", "linear"];
export const defaultListLimit = 50;
export const defaultSearchLimit = 10;
export const maxListLimit = 100;

class InvalidInput extends Error {}

/** One identity per tracker issue, so a list item and a saved link compare equal across URL spellings. */
export function issueIdentity(issue: { tracker: LinkedTracker; key: string; url: string }): string | null {
  let url: URL;
  try { url = new URL(issue.url); } catch { return null; }
  if (issue.tracker === "github") {
    const [, owner, name, kind, number] = url.pathname.split("/");
    if (!owner || !name || kind !== "issues" || number !== issue.key) return null;
    return `github:${owner.toLowerCase()}/${name.toLowerCase()}#${issue.key}`;
  }
  if (issue.tracker === "jira") return `jira:${url.origin}:${issue.key.toUpperCase()}`;
  return `linear:${issue.key.toUpperCase()}`;
}

function parseInput(query: string, text: string | undefined, options: AppIssuesOptions, config: RepositoryConfig):
{ query: IssueQuery; tracker: LinkedTracker | null; limit: number; text: string; assignedOnly: boolean } {
  if (!queries.includes(query as IssueQuery)) throw new InvalidInput("Unknown list. Use sprint, assigned, open or search.");
  const known = query as IssueQuery;
  if (options.tracker !== undefined && !trackers.includes(options.tracker as LinkedTracker)) {
    throw new InvalidInput("Unknown tracker. Use github, jira or linear.");
  }
  if (known === "search" && options.tracker === undefined) throw new InvalidInput("A search needs --tracker github, jira or linear.");
  if (known !== "search" && text !== undefined) throw new InvalidInput("Only search takes text.");
  if (options.assigned === true && known !== "sprint") throw new InvalidInput("--assigned applies only to sprint.");
  if (known === "search" && (text === undefined || text.length > 200)) throw new InvalidInput("A search needs text of at most 200 characters after --.");
  let limit = known === "search" ? defaultSearchLimit : defaultListLimit;
  if (options.limit !== undefined) {
    if (known === "sprint") throw new InvalidInput("A sprint is listed whole; --limit applies to assigned, open and search.");
    if (!/^[1-9][0-9]{0,2}$/u.test(options.limit) || Number(options.limit) > maxListLimit) {
      throw new InvalidInput(`--limit must be a whole number from 1 to ${maxListLimit}.`);
    }
    limit = Number(options.limit);
  }
  const fallback = config.defaultTracker === undefined || config.defaultTracker === "none" ? null : config.defaultTracker;
  return { query: known, tracker: (options.tracker as LinkedTracker | undefined) ?? fallback, limit, text: text ?? "",
    assignedOnly: options.assigned === true };
}

async function linkedWorktrees(repository: RepositoryContext, trees: readonly WorktreeInventory[],
  services: AppIssuesServices): Promise<Map<string, ListedIssue["worktree"]>> {
  const linked = new Map<string, ListedIssue["worktree"]>();
  const links = await Promise.all(trees.map(tree => services.readIssueLink(repository,
    { ...tree, pathExists: true, status: { kind: "unknown", reason: "not inspected" } }).catch(() => ({ kind: "none" }) as const)));
  trees.forEach((tree, index) => {
    const link = links[index]!;
    if (link.kind !== "linked") return;
    const identity = issueIdentity(link);
    if (identity !== null && !linked.has(identity)) linked.set(identity, { path: tree.path, branch: tree.branch });
  });
  return linked;
}

/**
 * One read-only issue list for app consumers. Never prompts, writes, fetches
 * or changes a ref, and never changes an issue. No login is read and nothing is
 * contacted when the input or the list's settings are missing.
 */
export async function readAppIssues(cwd: string, query: string, text: string | undefined, options: AppIssuesOptions,
  services: AppIssuesServices): Promise<AppIssuesRecord> {
  const record: AppIssuesRecord = { schemaVersion: 1, repository: null, query: null, tracker: null, outcome: "failed",
    sprint: null, issues: [], truncated: false, reason: null, diagnostic: null };
  const secrets = knownSecrets(services.trackers.env);
  const fail = (reason: IssueListReason, error: unknown, fallback: string) => {
    Object.assign(record, { outcome: "failed", sprint: null, issues: [], truncated: false, reason,
      diagnostic: safeAppDiagnostic(error, [...secrets].sort((a, b) => b.length - a.length), fallback) });
    return record;
  };
  if (queries.includes(query as IssueQuery)) record.query = query as IssueQuery;
  let repository: RepositoryContext;
  let config: RepositoryConfig;
  let trees: readonly WorktreeInventory[];
  try {
    repository = await services.discoverRepository(cwd);
    record.repository = { commonGitDir: await realpath(repository.commonGitDir),
      primaryWorktreeRoot: repository.primaryWorktreeRoot, currentWorktreeRoot: repository.currentWorktreeRoot };
    config = await services.loadConfig(repository);
    trees = await services.listWorktreeInventory(repository);
  } catch (error) {
    return fail("failed", error, "Cannot read this repository's settings or worktrees.");
  }
  let input;
  try { input = parseInput(query, text, options, config); } catch (error) { return fail("failed", error, ""); }
  record.tracker = input.tracker;
  if (input.tracker === null) {
    return fail("not-configured", new Error("No tracker named and no default tracker configured. Pass --tracker, or set default_tracker."), "");
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = () => new IssueReadFailure("offline", "The issue tracker did not answer in time; check connectivity and try again.");
  // The race keeps the time limit even if a request ignores its abort signal.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(late()); }, services.timeoutMs);
  });
  // Read once: GitHub lists and the branch prediction both need the selected repository.
  let selected: Promise<GithubRepository> | undefined;
  const githubRepository = () => selected ??= services.githubRepository(repository, config);
  const context: ListContext = {
    runtime: { ...services.trackers, secret: value => { if (value) secrets.push(value); } },
    signal: controller.signal,
    settings: config.issueLists ?? { jira: {}, github: {}, linear: {} },
    jira: config.jira,
    githubRepository: async () => {
      try { return await githubRepository(); }
      catch { throw new IssueReadFailure("failed", "The selected remote is not a github.com repository. Check the remote setting or the origin fetch URL."); }
    },
    limit: input.limit,
    text: input.text,
    assignedOnly: input.assignedOnly,
    now: services.now,
  };
  const list = { github: listGithub, jira: listJira, linear: listLinear }[input.tracker];
  let result: IssueList | null;
  const pullRequests: PullRequestLinks = new Map();
  try {
    try {
      result = await Promise.race([list(input.query, context), deadline]);
    } catch (error) {
      if (error instanceof NotConfigured) return fail("not-configured", error, "");
      if (error instanceof IssueReadFailure) return fail(error.reason, error, "");
      if (controller.signal.aborted) return fail("offline", late(), "");
      return fail("failed", new Error("Issue list failed."), "");
    }
    // Links share the list's time limit. A failure keeps the links already read and leaves the rest
    // null; reading links never fails the list.
    if (result !== null && result.issues.length > 0 && result.pullRequests !== undefined) {
      await Promise.race([result.pullRequests(result.issues, pullRequests), deadline]).catch(() => {});
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  if (result === null) return Object.assign(record, { outcome: "none" });
  const linked = result.issues.length === 0 ? new Map<string, ListedIssue["worktree"]>()
    : await linkedWorktrees(repository, trees, services);
  // `timber new github:<n>` looks the number up in the selected remote's repository, so an issue
  // from another repository (a project iteration can hold them) has no prediction.
  let ownGithub: string | null = null;
  if (input.tracker === "github" && result.issues.length > 0) {
    const own = await githubRepository().catch(() => null);
    if (own !== null) ownGithub = `github:${own.owner.toLowerCase()}/${own.name.toLowerCase()}#`;
  }
  const maximum = config.maxGeneratedBranchNameLength;
  const branch = (issue: IssueSummary, identity: string | null): string | null => {
    if (issue.tracker !== "github") return predictTicketBranch(issue.key, issue.title, maximum);
    if (ownGithub === null || identity !== `${ownGithub}${issue.key}`) return null;
    return predictTicketBranch(githubTicketKey(issue.key), issue.title, maximum);
  };
  return Object.assign(record, { outcome: "found", sprint: result.sprint, truncated: result.truncated,
    issues: result.issues.map(issue => {
      const identity = issueIdentity(issue);
      return { ...issue, worktree: identity === null ? null : linked.get(identity) ?? null,
        pullRequests: pullRequests.get(issue.url) ?? null, assignedToMe: result.assignedToMe?.(issue) ?? null,
        branch: branch(issue, identity) };
    }) });
}
