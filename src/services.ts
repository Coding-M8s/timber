import type { MachineReporter } from "./machine";
import type { ArenaNewOptions, ArenaResumeOptions, ArenaPickOptions } from "./arena/types";
import type {
  AgentCommand, AgentResult, ExecutableCommand, Branch, CleanupInspection, CleanupOptions, CleanupPolicy, CleanupResult, ConfirmCleanupDiscard, CreateWorktreeRequest,
  EditorResult, JiraConfig, JiraTicket, OpenTarget, RepositoryConfig, RepositoryContext, Resolution,
  ResolveOpenTargetOptions, ValidatedBase, Worktree,
} from "./types";
import type { BaseAssociationRead } from "./git/base-metadata";
import type { RebaseReport } from "./git/rebase";
import type { TerminalChooser, TerminalTextPrompt } from "./selection";
import type { GithubRepository } from "./github/repository";
import type { LinearTicket } from "./linear/client";
import type { GithubTicket } from "./github/client";

export interface CommandServices {
  resolveLinearTicket(key: string, allowClosed?: boolean): Promise<LinearTicket>;
  resolveGithubRepository(repository: RepositoryContext, config: RepositoryConfig, remote?: string): Promise<GithubRepository>;
  resolveGithubTicket(repository: GithubRepository, number: number, allowClosed: boolean): Promise<GithubTicket>;
  /** Discover from nested/linked cwd; reject non-repositories and bare repos. */
  discoverRepository(cwd: string): Promise<RepositoryContext>;
  /** Defaults + validated global/repository config; never search relative to caller cwd. */
  loadConfig(repository: RepositoryContext): Promise<RepositoryConfig>;
  /** Resolve one configured Jira Cloud issue; never fall back to a literal branch. */
  resolveJiraTicket(config: JiraConfig, key: string, allowClosed?: boolean): Promise<JiraTicket>;
  /** Return only validated active ticket alternatives for an exact missing/done key. */
  findJiraSuggestions(config: JiraConfig, key: string): Promise<readonly JiraTicket[]>;
  /** Installed Git is authoritative; include manual, detached, stale entries. */
  listWorktrees(repository: RepositoryContext): Promise<readonly Worktree[]>;
  /** Local and cached remote branches, without fetching. */
  listBranches(repository: RepositoryContext): Promise<readonly Branch[]>;
  /** Exact local, exact remote, then delimiter-boundary prefix; no guessing. */
  resolveBranch(repository: RepositoryContext, input: string, config: RepositoryConfig): Promise<Resolution<Branch>>;
  /** Explicit > config > selected remote default > unambiguous main/master. */
  resolveBase(repository: RepositoryContext, config: RepositoryConfig, explicitBase?: string): Promise<ValidatedBase>;
  /** Existing worktree > local branch > remote branch; existing worktrees work offline. */
  resolveOpenTarget(
    repository: RepositoryContext,
    input: string,
    config: RepositoryConfig,
    options?: ResolveOpenTargetOptions,
  ): Promise<Resolution<OpenTarget>>;
  /**
   * Validate refs/path and reject collisions; refresh the selected remote before
   * remote creation. Failed refresh must reject. Never remove pre-existing files/refs.
   * Default path: ../<repository-name>-worktrees/<safe-branch-slug>.
   */
  createWorktree(repository: RepositoryContext, request: CreateWorktreeRequest, config: RepositoryConfig): Promise<Worktree>;
  readBaseAssociation(repository: RepositoryContext, worktree: Worktree): Promise<BaseAssociationRead>;
  writeBaseAssociation(repository: RepositoryContext, worktree: Worktree, ref: string): Promise<void>;
  /** Select a saved/explicit base, fetch remote bases and rebase only a verified, clean registered worktree. */
  rebaseWorktree(repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig,
    explicitBase: string | undefined, io: CommandIO, report?: RebaseReport): Promise<number>;
  /** Snapshot a verified, idle registered worktree into private Git-directory storage; never changes the source. */
  createBackup(repository: RepositoryContext, worktree: Worktree, io: CommandIO): Promise<number>;
  /** Recover a verified backup into a new worktree and recovery branch; never overwrites or runs repository code. */
  restoreBackup(repository: RepositoryContext, id: string, destination: string, cwd: string, io: CommandIO): Promise<number>;
  /** Inspect all file classes and publication/validated-base integration. */
  inspectCleanup(repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig): Promise<CleanupInspection>;
  /** Recheck identity and safety at mutation time. Confirmed upstream absence or
   * explicit interactive discard can authorize loss of local commits and files.
   * Keep options and hard identity/operation failures remain enforced.
   */
  cleanupWorktree(repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig, options: CleanupOptions,
    io?: CommandIO, confirmDiscard?: ConfirmCleanupDiscard, validateApproval?: () => Promise<void>, policy?: CleanupPolicy): Promise<CleanupResult>;
  /** Executable + args, no shell; null config or disabled means skipped. */
  launchEditor(worktree: Worktree, config: RepositoryConfig, disabled: boolean): Promise<EditorResult>;
  /** Sequential trusted POSIX hooks; rejection retains workspace and blocks launch. */
  runSetup(repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig, io: CommandIO,
    workflowName?: string, workflowScripts?: readonly string[]): Promise<void>;
  /** Await the owned foreground child; null command skips launching. */
  launchAgent(worktree: Worktree, command: ExecutableCommand | null, environment?: NodeJS.ProcessEnv): Promise<AgentResult>;
  /** Exact local editor terminals, required setup and startup acknowledgements only. */
  launchEditorTerminals?(launch: EditorTerminalLaunch, io: CommandIO): Promise<void>;
}

export interface EditorTerminalLaunch {
  repository: RepositoryContext;
  worktree: Worktree;
  config: RepositoryConfig;
  agent: AgentCommand | null;
  setup: boolean;
  workflowName?: string;
  workflowScripts?: readonly string[];
}

export interface CommandIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CommandContext {
  /** Optional experimental reporting, separate from human and hook output. */
  machine?: MachineReporter;
  cwd: string;
  /** Invoking stdin/stdout are terminals and CI is off. Absence means false. */
  interactive?: boolean;
  io: CommandIO;
  /** Present only when stdin and stdout are interactive terminals and CI is disabled. */
  choose?: TerminalChooser;
  /** Present under the same conditions as `choose`; reads one line of free text. */
  ask?: TerminalTextPrompt;
}

export interface NewOptions {
  remote?: string;
  allowClosed?: boolean;
  base?: string;
  workflow?: string;
  /** Explicit enable/disable; omission defers to editor.enabled. */
  editor?: boolean;
  /** Explicit enable/disable; omission defers to agent.enabled. */
  agent?: boolean;
  /** False skips every post_create hook; the caller runs `open --setup` later. */
  setup?: false;
}

export interface OpenOptions {
  workflow?: string;
  editor?: boolean;
  /** True reruns all setup steps for an existing worktree; false skips them even on creation. */
  setup?: boolean;
  /** Explicit enable/disable; omission defers to agent.enabled. */
  agent?: boolean;
}

export interface CommandHandlers {
  rebase?(input: string, options: { base?: string }, context: CommandContext): Promise<number>;
  /** Optional for existing embedders; production entry point wires backups. */
  backupCreate?(input: string, context: CommandContext): Promise<number>;
  backupRestore?(id: string, destination: string, context: CommandContext): Promise<number>;
  /** Optional for existing embedders; production entry point wires arena creation. */
  arenaNew?(name: string, options: ArenaNewOptions, context: CommandContext): Promise<number>;
  /** Existing attempts only; no materialization or ordinary agent substitution. */
  arenaResume?(name: string, options: ArenaResumeOptions, context: CommandContext): Promise<number>;
  arenaPick?(name: string, options: ArenaPickOptions, context: CommandContext): Promise<number>;
  setup(options: { global: boolean }, context: CommandContext): Promise<void>;
  new: (branch: string, options: NewOptions, context: CommandContext) => Promise<void | number>;
  open(input: string, options: OpenOptions, context: CommandContext): Promise<void | number>;
  list(context: CommandContext): Promise<void>;
  done(input: string, options: CleanupOptions, context: CommandContext): Promise<void>;
}
