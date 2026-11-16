import { assignGithubIssue, checkGithubConnection } from "./github/client";
import type { GithubRepository } from "./github/repository";
import { assignJiraIssue, checkJiraConnection, jiraRuntime } from "./jira/client";
import { assignLinearIssue, checkLinearConnection, linearRuntime } from "./linear/client";
import type { LinkedTracker } from "./git/issue-link";
import type { JiraConfig, TrackerUser } from "./types";

/** The issue `new --assign` writes to, in the repository or site its lookup used. */
export type AssignTarget =
  | { tracker: "github"; repository: GithubRepository; number: number }
  | { tracker: "jira"; config: JiraConfig; key: string; /** Selects the repository's saved login. */ commonGitDir?: string }
  | { tracker: "linear"; key: string; /** Linear's issue ID; the key is used when it is unknown. */ id?: string;
    /** Selects the repository's saved key. */ commonGitDir?: string };

/** The `assignment` object of a `new --assign` result. */
export interface AssignmentReport {
  tracker: LinkedTracker;
  /** The GitHub number, or the Jira or Linear key. */
  key: string;
  /** `not-attempted` until the write runs, and after a refusal or a failure before it. */
  result: "not-attempted" | "assigned" | "reassigned" | "already-mine" | "failed";
  /** The signed-in account's display name. */
  me: string;
  /** Display names of the assignees before Timber wrote anything. */
  previous: string[];
  /** Terminal-safe reason, only when `result` is `failed`. */
  diagnostic: string | null;
}

export type AssignmentPlan =
  | { kind: "already-mine" }
  | { kind: "assign" }
  | { kind: "reassign"; others: readonly TrackerUser[] }
  | { kind: "refuse"; others: readonly TrackerUser[] };

/** GitHub logins compare without case; Jira account IDs and Linear user IDs compare exactly. */
export function sameUser(tracker: LinkedTracker, a: TrackerUser, b: TrackerUser): boolean {
  return tracker === "github" ? a.id.toLowerCase() === b.id.toLowerCase() : a.id === b.id;
}

/**
 * Already mine (alone, or beside others without --reassign) writes nothing.
 * Someone else alone refuses unless `reassign`, which makes me the only assignee.
 */
export function planAssignment(tracker: LinkedTracker, me: TrackerUser, assignees: readonly TrackerUser[],
  reassign: boolean): AssignmentPlan {
  const others = assignees.filter(user => !sameUser(tracker, user, me));
  const mine = others.length < assignees.length;
  if (others.length === 0) return mine ? { kind: "already-mine" } : { kind: "assign" };
  if (mine && !reassign) return { kind: "already-mine" };
  return reassign ? { kind: "reassign", others } : { kind: "refuse", others };
}

/** The signed-in account, read with the same login the lookup used. */
export async function readTrackerUser(target: AssignTarget): Promise<TrackerUser> {
  if (target.tracker === "github") {
    const login = await checkGithubConnection();
    return { id: login, name: login };
  }
  if (target.tracker === "jira") return checkJiraConnection(target.config, jiraRuntime(target.commonGitDir));
  return checkLinearConnection(linearRuntime(target.commonGitDir));
}

export async function assignIssue(target: AssignTarget, me: TrackerUser, replace: boolean): Promise<void> {
  if (target.tracker === "github") return assignGithubIssue(target.repository, target.number, me.id, replace);
  if (target.tracker === "jira") return assignJiraIssue(target.config, target.key, me.id, jiraRuntime(target.commonGitDir));
  return assignLinearIssue(target.id ?? target.key, me.id, linearRuntime(target.commonGitDir));
}
