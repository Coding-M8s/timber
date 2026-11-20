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
