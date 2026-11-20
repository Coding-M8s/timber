import type { WorktreeReadPhase } from "./git/worktree-read-phase";
import type { AppHandoff } from "./app-handoff";
import type { MachineReporter } from "./machine";
import type { ArenaNewOptions, ArenaResumeOptions, ArenaPickOptions } from "./arena/types";
import type {
  AgentCommand, AgentResult, ExecutableCommand, Branch, CleanupInspection, CleanupOptions, CleanupPolicy, CleanupResult, ConfirmCleanupDiscard, CreateWorktreeRequest,
  EditorResult, JiraConfig, JiraTicket, OpenTarget, RepositoryConfig, RepositoryContext, Resolution,
  ResolveOpenTargetOptions, ValidatedBase, Worktree,
} from "./types";
import type { BaseAssociationRead } from "./git/base-metadata";
import type { NewBranchInspection } from "./git/new-collision";
import type { IssueLink, IssueLinkRead, IssueLinkWrite } from "./git/issue-link";
import type { BackupListRecord } from "./backup/lifecycle";
import type { BaseWording, RebaseReport, RebaseRunOptions } from "./git/rebase";
import type { PublishReport } from "./git/publish";
import type { PullRequestOptions, PullRequestReport } from "./github/pull-request";
import type { TerminalChooser, TerminalTextPrompt } from "./selection";
import type { BackupCreateOptions, BackupRestoreReport } from "./backup/service";
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
  /** Installed Git is authoritative; include manual, detached, stale entries.
   * includeIgnored: false leaves status.ignored empty; use it only for listing. */
  listWorktrees(
    repository: RepositoryContext, options?: { inspectStatus?: boolean; includeIgnored?: boolean; phase?: WorktreeReadPhase },
  ): Promise<readonly Worktree[]>;
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
  /** Read-only local, cached and live remote state for a final new-branch name; unreachable remotes are `unknown`, never absent. */
  inspectNewBranchCollision(repository: RepositoryContext, name: string, config: RepositoryConfig): Promise<NewBranchInspection>;
  readBaseAssociation(repository: RepositoryContext, worktree: Worktree, phase?: WorktreeReadPhase): Promise<BaseAssociationRead>;
  writeBaseAssociation(repository: RepositoryContext, worktree: Worktree, ref: string): Promise<void>;
  /** Remove a saved base; unassigned is a no-op, malformed or unreadable records refuse. */
  clearBaseAssociation(repository: RepositoryContext, worktree: Worktree): Promise<void>;
  /** Validate an explicit base with `rebase --base` forms and checks, without fetching. */
  selectBaseRef(repository: RepositoryContext, config: RepositoryConfig, input: string, cwd: string,
    targetBranch: string | null, wording: BaseWording): Promise<{ ref: string; commit: string; local: boolean }>;
  /** Offline; reports damaged metadata as a value and never throws. */
  readIssueLink(repository: RepositoryContext, worktree: Worktree, phase?: WorktreeReadPhase): Promise<IssueLinkRead>;
  /** Offline; refuses a different existing link unless `replace` is set. */
  writeIssueLink(repository: RepositoryContext, worktree: Worktree, link: IssueLink, options?: { replace?: boolean }): Promise<IssueLinkWrite>;
  /** Select a saved/explicit base, fetch remote bases and rebase only a verified, clean registered worktree. */
  rebaseWorktree(repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig,
    explicitBase: string | undefined, io: CommandIO, report?: RebaseReport, options?: RebaseRunOptions): Promise<number>;
  /** Push a verified registered worktree's branch under its own name; never forces or prompts. */
  publishWorktree(repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig,
    io: CommandIO, report?: PublishReport): Promise<number>;
  /** Publish a verified registered worktree's branch, then open or report its GitHub or Bitbucket pull request; never prompts. */
  openPullRequest(repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig,
    options: PullRequestOptions, io: CommandIO, report?: PullRequestReport): Promise<number>;
  /** Snapshot a verified, idle registered worktree into private Git-directory storage; never changes the source. */
  createBackup(repository: RepositoryContext, worktree: Worktree, io: CommandIO, options: BackupCreateOptions): Promise<number>;
  /** Delete expired, usable, unprotected backups through the confirmed-deletion checks; no prompt. */
  cleanupBackups(repository: RepositoryContext, io: CommandIO): Promise<number>;
  /** Keep one backup indefinitely, or restore its captured retention. */
  setBackupKeep(repository: RepositoryContext, id: string, keep: boolean, io: CommandIO): Promise<number>;
  /** Recover a verified backup into a new worktree and recovery branch; never overwrites or runs repository code. */
  restoreBackup(
    repository: RepositoryContext, id: string, destination: string, cwd: string, io: CommandIO, report?: BackupRestoreReport,
  ): Promise<number>;
  /** Read-only listing of backups, unfinished deletions and unusable entries. */
  listBackups(repository: RepositoryContext, io: CommandIO): Promise<number>;
  /** Read-only JSON form of the backup list; discovery and storage failures become a failed record, never a throw. */
  readBackupList(cwd: string, discover: (cwd: string) => Promise<RepositoryContext>): Promise<BackupListRecord>;
  /** Interactive deletion; requires the text prompt and `y` then Enter per decision. */
  reviewBackupDeletion(repository: RepositoryContext, options: { all: boolean }, io: CommandIO, ask: TerminalTextPrompt | undefined): Promise<number>;
  /** Valid backups recorded from a worktree path, with size and retention; optional so embedders without backups keep `done` unchanged. */
  retainedBackups?(repository: RepositoryContext, worktreePath: string): Promise<readonly { id: string; detail: string }[]>;
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
  /** Present only in an interactive terminal of the Timber app with a usable handoff folder. */
  appHandoff?: AppHandoff;
}

/** Exactly one of `set` or `clear`. */
export type BaseOptions = { set: string; clear?: undefined } | { clear: true; set?: undefined };

export interface RebaseOptions {
  base?: string;
  /** Explicit per-invocation request for AI conflict assistance. */
  resolve?: boolean;
  /** Extra instructions for this run; requires `resolve`. */
  resolveNote?: string;
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
  /** Tracker issue selector to link, such as jira:ENG-1, github:12, or a default tracker key. */
  issue?: string;
  /** Replace a different existing link instead of refusing. Requires `issue`. */
  replaceIssue?: boolean;
  workflow?: string;
  editor?: boolean;
  /** True reruns all setup steps for an existing worktree; false skips them even on creation. */
  setup?: boolean;
  /** Explicit enable/disable; omission defers to agent.enabled. */
  agent?: boolean;
}

export interface CommandHandlers {
  /** Optional for existing embedders; production entry point wires updates. */
  update?(options: { check?: boolean; version?: string }, context: CommandContext): Promise<number>;
  updateCheck?(context: CommandContext): Promise<number>;
  rebase?(input: string, options: RebaseOptions, context: CommandContext): Promise<number>;
  /** Optional for existing embedders; production entry point wires publishing. */
  publish?(input: string, context: CommandContext): Promise<number>;
  /** Optional for existing embedders; production entry point wires base changes. */
  base?(input: string, options: BaseOptions, context: CommandContext): Promise<number>;
  /** Optional for existing embedders; production entry point wires pull requests. */
  pr?(input: string, options: PullRequestOptions, context: CommandContext): Promise<number>;
  /** Optional for existing embedders; production entry point wires backups. */
  backupCreate?(input: string, context: CommandContext, options?: { keep: boolean }): Promise<number>;
  backupCleanup?(context: CommandContext): Promise<number>;
  backupKeep?(id: string, keep: boolean, context: CommandContext): Promise<number>;
  backupRestore?(id: string, destination: string, context: CommandContext): Promise<number>;
  backupList?(context: CommandContext, options?: { json?: boolean }): Promise<number>;
  backupDone?(options: { all: boolean }, context: CommandContext): Promise<number>;
  /** Optional for existing embedders; production entry point wires arena creation. */
  arenaNew?(name: string, options: ArenaNewOptions, context: CommandContext): Promise<number>;
  /** Existing attempts only; no materialization or ordinary agent substitution. */
  arenaResume?(name: string, options: ArenaResumeOptions, context: CommandContext): Promise<number>;
  arenaPick?(name: string, options: ArenaPickOptions, context: CommandContext): Promise<number>;
  /** Optional for existing embedders; production entry point wires uninstall. */
  uninstall?(options: { yes?: boolean; removeSettings?: boolean }, context: CommandContext): Promise<number>;
  setup(options: { global: boolean }, context: CommandContext): Promise<void>;
  new: (branch: string, options: NewOptions, context: CommandContext) => Promise<void | number>;
  open(input: string, options: OpenOptions, context: CommandContext): Promise<void | number>;
  list(context: CommandContext): Promise<void>;
  done(input: string, options: CleanupOptions, context: CommandContext): Promise<void>;
}
