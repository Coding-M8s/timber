/** Absolute filesystem paths. Git's common directory identifies a repository. */
export interface RepositoryContext {
  currentWorktreeRoot: string;
  primaryWorktreeRoot: string;
  commonGitDir: string;
  /** Null means detached HEAD; an unborn branch still has a name. */
  currentBranch: string | null;
  remotes: readonly Remote[];
}

export interface Remote {
  name: string;
  /** Full remote-tracking ref, e.g. refs/remotes/upstream/main; null if unknown. */
  defaultBranchRef: string | null;
}

export type Branch =
  | { kind: "local"; name: string; ref: string; upstream: RemoteBranch | null }
  | RemoteBranch;

export interface RemoteBranch {
  kind: "remote";
  remote: string;
  name: string;
  /** Full ref, e.g. refs/remotes/origin/feature/foo. */
  ref: string;
}

/** Absence and ambiguity are values, not permission to guess. */
export type Resolution<T> =
  | { kind: "found"; value: T }
  | { kind: "not-found" }
  | { kind: "ambiguous"; candidates: readonly T[] };

export type WorktreeStatus =
  | { kind: "known"; modified: readonly string[]; untracked: readonly string[]; ignored: readonly string[] }
  | { kind: "unknown"; reason: string };

export interface Worktree {
  path: string;
  /** Null means detached HEAD. */
  branch: string | null;
  head: string | null;
  isPrimary: boolean;
  /** A missing worktree must still be listed. */
  pathExists: boolean;
  locked: { reason: string | null } | null;
  prunable: { reason: string | null } | null;
  status: WorktreeStatus;
}

/** Validated existing commit, not an unchecked user-provided base string. */
export interface ValidatedBase {
  ref: string;
  commit: string;
  source: "explicit" | "config" | "remote-default" | "fallback";
}

export interface ExecutableCommand {
  command: string;
  args: readonly string[];
}

/** Normalized repository configuration. Relative paths resolve from primaryWorktreeRoot. */
export interface AgentConfig extends ExecutableCommand {
  enabled: boolean;
}

/** Jira Cloud site used for ticket lookup; credentials are supplied at runtime. */
export interface JiraConfig {
  siteUrl: string;
  cloudId?: string;
}

/** Ticket details needed to name a generated branch and build its browse URL. */
export interface JiraTicket {
  key: string;
  title: string;
  url: string;
}

export interface RepositoryConfig {
  baseBranch: string | null;
  remote: string | null;
  worktreeDir: string | null;
  /** Null means off; no default executable. */
  editor: ExecutableCommand | null;
  /** Parsed in 0.1, but launched only starting in 0.2. */
  agent: AgentConfig | null;
  /** Trusted 0.2 shell source. Absent hooks mean setup is off. */
  hooks?: { postCreate: readonly string[] };
  /** Absent means Jira ticket lookup is disabled for this repository. */
  jira?: JiraConfig;
}

export type OpenTarget =
  | { kind: "worktree"; worktree: Worktree }
  | { kind: "branch"; branch: Branch };

export type CreateWorktreeRequest =
  | { kind: "new"; branch: string; base: ValidatedBase }
  | { kind: "local"; branch: Extract<Branch, { kind: "local" }> }
  | { kind: "remote"; branch: RemoteBranch };

export type PublicationState =
  | { kind: "published"; upstreamRef: string }
  | { kind: "unpublished"; commits: readonly string[] }
  | { kind: "unknown"; reason: string };

export type AncestryState =
  | { kind: "contained"; base: ValidatedBase }
  | { kind: "not-contained"; base: ValidatedBase; commits: readonly string[] }
  | { kind: "unknown"; reason: string };

export type ContentIntegrationState =
  | { kind: "equivalent"; base: ValidatedBase }
  | { kind: "not-proven" };

/** Evidence for explaining cleanup, never a reusable authorization to delete. */
export interface CleanupInspection {
  worktree: Worktree;
  publication: PublicationState;
  ancestry: AncestryState;
  /** Content integration is separate from commit ancestry. Detached HEAD requires ancestry. */
  integration: ContentIntegrationState;
}

export interface CleanupOptions {
  keepBranch: boolean;
  discardIgnored: boolean;
}

export interface CleanupResult {
  removedWorktreePath: string;
  /** Set when the local branch was deleted. Mutually exclusive with retainedLocalBranch. */
  deletedLocalBranch: string | null;
  /** Set when a local branch existed and was kept. Null for detached HEAD or deleted branches. */
  retainedLocalBranch: string | null;
}

/** Openability checks are for `open`; cleanup commands skip them and recheck at mutation time. */
export interface ResolveOpenTargetOptions {
  assertOpenable?: boolean;
  /** Discover live remote heads when open cannot resolve a single local target. */
  discoverRemote?: boolean;
}

export type EditorResult =
  | { kind: "skipped" }
  | { kind: "launched" }
  | { kind: "failed"; message: string; retryCommand: string };
