import type { GithubRepository } from "../github/repository";
import type { IssueSummary, IssueTrackerRuntime } from "../app-issue/trackers";
import type { IssueListSettings, JiraConfig } from "../types";

export type IssueQuery = "sprint" | "assigned" | "open" | "search";

export type SprintSource = "jira-board" | "jira-jql" | "github-iteration" | "github-milestone" | "linear-cycle";

/** The current sprint a list came from. `name` is null for a saved Jira query, which has no sprint name. */
export interface SprintInfo { name: string | null; source: SprintSource }

export interface IssueList {
  /** Non-null only for the sprint query. */
  sprint: SprintInfo | null;
  issues: IssueSummary[];
  /** True when the tracker had more matching issues than the record holds. */
  truncated: boolean;
  /**
   * Reads the open pull requests the tracker links to these issues into `links`
   * as each answer arrives, so a read cut short keeps what it found. Absent when
   * the tracker has no reader.
   */
  pullRequests?: (issues: readonly IssueSummary[], links: PullRequestLinks) => Promise<void>;
  /** Whether a listed issue is assigned to the signed-in account; null when that is unknown. Absent means unknown for every issue. */
  assignedToMe?: (issue: IssueSummary) => boolean | null;
}

/**
 * Whether the signed-in account is among `assignees`. An unassigned issue is
 * false even when the account is unknown; otherwise unknown assignees or an
 * unknown account give null.
 */
export function mine(assignees: readonly string[] | undefined, me: string | null, same: (a: string, b: string) => boolean): boolean | null {
  if (assignees === undefined) return null;
  if (assignees.length === 0) return false;
  return me === null ? null : assignees.some(id => same(id, me));
}

/** An open pull request the tracker itself links to an issue. Null fields mean the tracker cannot tell. */
export interface LinkedPullRequest {
  number: number;
  url: string;
  /** The pull request's head branch. */
  branch: string;
  /** True when the head is in another repository. */
  fromFork: boolean | null;
  draft: boolean | null;
}

/** Linked pull requests by issue URL; null for an issue whose links could not be read. */
export type PullRequestLinks = Map<string, LinkedPullRequest[] | null>;

/** Issues read per pull request lookup, so a whole sprint needs only a few requests. */
export const pullRequestBatch = 100;

export function batches<T>(items: readonly T[], size = pullRequestBatch): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

/** The list cannot be read because a setting it needs is missing. Nothing was contacted. */
export class NotConfigured extends Error {}

export interface ListContext {
  runtime: IssueTrackerRuntime;
  signal: AbortSignal;
  settings: IssueListSettings;
  jira: JiraConfig | undefined;
  /** The github.com repository of the selected remote; read lazily so other trackers never need one. */
  githubRepository: () => Promise<GithubRepository>;
  /** Most issues to return for assigned, open and search. */
  limit: number;
  /** Search text; empty for the other queries. */
  text: string;
  /** For sprint: keep only issues assigned to the signed-in account. */
  assignedOnly: boolean;
  /** Today, for choosing a GitHub project's current iteration. */
  now: () => Date;
}

/**
 * Largest sprint the record carries. A longer sprint is cut and marked truncated.
 */
export const maxSprintIssues = 500;

/**
 * Search words with tracker query syntax removed, so typed text can never add
 * a qualifier such as another repository.
 */
export function searchWords(text: string): string[] {
  return text.split(/\s+/u).map(word => word.replace(/["'\\:()[\]{}#]/gu, "")).filter(word => word.length > 0).slice(0, 8);
}

/** A tracker list query: `ENG-4`, `eng-4` or `ENG-` names a key; `#12` or `12` a GitHub number. */
export function keyPrefix(text: string): string | null {
  const trimmed = text.trim();
  if (/^#?[1-9][0-9]{0,9}$/u.test(trimmed)) return trimmed.replace(/^#/u, "");
  if (/^[A-Za-z][A-Za-z0-9_]{0,254}-[0-9]{0,10}$/u.test(trimmed)) return trimmed.toUpperCase();
  return null;
}
