import type {
  AgentResult, ExecutableCommand, Branch, CleanupInspection, CleanupOptions, CleanupResult, CreateWorktreeRequest,
  EditorResult, JiraConfig, JiraTicket, OpenTarget, RepositoryConfig, RepositoryContext, Resolution,
  ResolveOpenTargetOptions, ValidatedBase, Worktree,
} from "./types";
import type { WorkflowAssociationRead } from "./git/workflow-metadata";
import type { TerminalChooser } from "./selection";

/** Function seams for command implementations; no concrete Git engine in TIM-11. */
export interface CommandServices {
  /** TIM-1: discover from nested/linked cwd; reject non-repositories and bare repos. */
  discoverRepository(cwd: string): Promise<RepositoryContext>;
  /** Defaults + validated global/repository config; never search relative to caller cwd. */
  loadConfig(repository: RepositoryContext): Promise<RepositoryConfig>;
  /** TIM-10: resolve one configured Jira Cloud issue; never fall back to a literal branch. */
  resolveJiraTicket(config: JiraConfig, key: string): Promise<JiraTicket>;
  /** TIM-10: return only validated active ticket alternatives for an exact missing/done key. */
  findJiraSuggestions(config: JiraConfig, key: string): Promise<readonly JiraTicket[]>;
  /** TIM-1/TIM-4: installed Git is authoritative; include manual, detached, stale entries. */
  listWorktrees(repository: RepositoryContext): Promise<readonly Worktree[]>;
  /** TIM-2: exact local, exact remote, then delimiter-boundary prefix; no guessing. */
  resolveBranch(repository: RepositoryContext, input: string, config: RepositoryConfig): Promise<Resolution<Branch>>;
  /** TIM-2: explicit > config > selected remote default > unambiguous main/master. */
  resolveBase(repository: RepositoryContext, config: RepositoryConfig, explicitBase?: string): Promise<ValidatedBase>;
  /** TIM-4: existing worktree > local branch > remote branch; existing worktrees work offline. */
  resolveOpenTarget(
    repository: RepositoryContext,
    input: string,
    config: RepositoryConfig,
    options?: ResolveOpenTargetOptions,
  ): Promise<Resolution<OpenTarget>>;
  /**
   * TIM-3: validate refs/path and reject collisions; refresh the selected remote before
   * remote creation. Failed refresh must reject. Never remove pre-existing files/refs.
   * Default path: ../<repository-name>-worktrees/<safe-branch-slug>.
   */
  createWorktree(repository: RepositoryContext, request: CreateWorktreeRequest, config: RepositoryConfig): Promise<Worktree>;
  readWorkflowAssociation(repository: RepositoryContext, worktree: Worktree): Promise<WorkflowAssociationRead>;
  writeWorkflowAssociation(repository: RepositoryContext, worktree: Worktree, name: string): Promise<void>;
  /** TIM-5: inspect all file classes and publication/validated-base integration. */
  inspectCleanup(repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig): Promise<CleanupInspection>;
  /**
   * TIM-5: recheck safety at mutation time, never trust an earlier inspection.
   * Refuse primary, dirty/untracked, and unintegrated unpublished/unproven work.
   * Ignored content blocks only when discardIgnored is false (--keep-ignored).
   * Base ancestry or content integration can prove publication safety, but the
   * target branch must not be the validated base. Local branch deletion requires
   * integration or verified live upstream publication; keepBranch skips deletion only. No destructive force, remote
   * deletion, stash, or process killing.
   */
  cleanupWorktree(repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig, options: CleanupOptions): Promise<CleanupResult>;
  /** TIM-8: executable + args, no shell; null config or disabled means skipped. */
  launchEditor(worktree: Worktree, config: RepositoryConfig, disabled: boolean): Promise<EditorResult>;
  /** TIM-7: sequential trusted /bin/sh hooks; rejection retains workspace and blocks launch. */
  runSetup(repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig, io: CommandIO,
    workflowName?: string, workflowScripts?: readonly string[]): Promise<void>;
  /** TIM-9: await the owned foreground child; null command skips launching. */
  launchAgent(worktree: Worktree, command: ExecutableCommand | null): Promise<AgentResult>;
}

export interface CommandIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CommandContext {
  cwd: string;
  /** Invoking stdin/stdout are terminals and CI is off. Absence means false. */
  interactive?: boolean;
  io: CommandIO;
  /** Present only when stdin and stdout are interactive terminals and CI is disabled. */
  choose?: TerminalChooser;
}

export interface NewOptions {
  base?: string;
  workflow?: string;
  /** False from --no-editor; undefined defers to config (off when unconfigured). */
  editor?: false;
  /** Explicit enable/disable; omission defers to agent.enabled. */
  agent?: boolean;
}

export interface OpenOptions {
  workflow?: string;
  editor?: false;
  /** Explicitly rerun all setup steps for an existing worktree. */
  setup?: true;
  /** Explicit enable/disable; omission defers to agent.enabled. */
  agent?: boolean;
}

export interface CommandHandlers {
  setup(options: { global: boolean }, context: CommandContext): Promise<void>;
  new: (branch: string, options: NewOptions, context: CommandContext) => Promise<void | number>;
  open(input: string, options: OpenOptions, context: CommandContext): Promise<void | number>;
  list(context: CommandContext): Promise<void>;
  done(input: string, options: CleanupOptions, context: CommandContext): Promise<void>;
}
