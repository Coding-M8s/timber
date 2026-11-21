import { open, lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { safeDiagnostic } from "./display";
import { readBaseAssociation, type BaseAssociationRead } from "./git/base-metadata";
import { readIssueLink, type IssueLinkRead } from "./git/issue-link";
import type { AppConfigReport } from "./app-config/settings";
import type { ArenaNewReport, ArenaPickReport } from "./arena/report";
import type { BackupDeleteReport } from "./backup/lifecycle";
import type { BackupRestoreReport } from "./backup/service";
import type { RebaseReport } from "./git/rebase";
import type { BaseChangeReport } from "./commands/base";
import type { PublishReport } from "./git/publish";
import type { PullRequestReport } from "./github/pull-request";
import type { AssignmentReport } from "./issue-assignment";
import type { CommandContext } from "./services";
import type { RepositoryContext, Worktree } from "./types";

/** Experimental v1 transport. Git's registered path remains authoritative. */
export interface MachineReporter {
  repository(repository: RepositoryContext): Promise<void>;
  /** Captures the worktree with the base and issue link saved at this moment. */
  worktree(worktree: Worktree, materialized: boolean): Promise<void>;
  /** Reads the captured worktree's saved base and issue link again, after the command changed them. */
  refreshMetadata(): Promise<void>;
  inventory(entries: readonly InventoryEntry[]): Promise<void>;
  /** Attaches the live rebase report; it is read once the handler has finished. */
  rebase(report: RebaseReport): void;
  /** Attaches the live publish report; it is read once the handler has finished. */
  publish(report: PublishReport): void;
  /** Attaches the live base change report; it is read once the handler has finished. */
  baseChange(report: BaseChangeReport): void;
  /** Attaches the live pull request report; it is read once the handler has finished. */
  pr(report: PullRequestReport): void;
  /** Attaches the live settings report; it is read once the handler has finished. */
  config(report: AppConfigReport): void;
  /** Attaches the live backup restore report; it is read once the handler has finished. */
  backupRestore(report: BackupRestoreReport): void;
  /** Attaches the live backup deletion report; it is read once the handler has finished. */
  backupDelete(report: BackupDeleteReport): void;
  /** Attaches the live arena creation report; it is read once the handler has finished. */
  arenaNew(report: ArenaNewReport): void;
  /** Attaches the live arena pick report; it is read once the handler has finished. */
  arenaPick(report: ArenaPickReport): void;
  /** Attaches the live `new --assign` report; it is read once the handler has finished. */
  assignment(report: AssignmentReport): void;
  /** `new` or `open` with --no-setup left configured post_create hooks for the caller to run. */
  setupSkipped(): void;
  cancelled(): void;
}

/** A listed worktree with the saved base and issue link the listing already read. */
export interface InventoryEntry {
  worktree: Worktree;
  base: BaseAssociationRead;
  issue: IssueLinkRead;
}

/** Saved-base read; reports invalid metadata as a value and never throws. */
export type BaseReader = (repository: RepositoryContext, worktree: Worktree) => Promise<BaseAssociationRead>;
/** Issue-link read; reports invalid metadata as a value and never throws. */
export type IssueReader = (repository: RepositoryContext, worktree: Worktree) => Promise<IssueLinkRead>;

interface RepositoryIdentity {
  commonGitDir: string;
  primaryWorktreeRoot: string;
  currentWorktreeRoot: string;
}

interface WorktreeRecord extends Worktree {
  detached: boolean;
  /** Null when the registered path cannot be verified; never adopt a replacement. */
  canonicalPath: string | null;
  /** Saved canonical base ref as stored; its existence is not checked. */
  base: BaseAssociationRead;
  /** Saved tracker issue as stored; the tracker is never contacted. */
  issue: IssueLinkRead;
}

export interface MachineRecord {
  schemaVersion: 1;
  command: "ls" | "new" | "open" | "done" | "rebase" | "base" | "publish" | "pr" | "config" | "backup-restore" | "backup-delete" | "arena-new" | "arena-pick";
  outcome: "succeeded" | "cancelled" | "failed";
  exitCode: number;
  repository: RepositoryIdentity | null;
  worktree: WorktreeRecord | null;
  /** True only after the creation service returned successfully. */
  materialized: boolean;
  diagnostic: string | null;
  worktrees?: WorktreeRecord[];
  /** Present only for rebase. */
  rebase?: RebaseReport;
  /** Present only for publish. */
  publish?: PublishReport;
  /** Present only for base: the saved base before and after. */
  baseChange?: BaseChangeReport;
  /** Present only for pr. */
  pr?: PullRequestReport;
  /** Present only for a settings apply. */
  config?: AppConfigReport;
  /** Present only for backup-restore. */
  backupRestore?: BackupRestoreReport;
  /** Present only for backup-delete. */
  backupDelete?: BackupDeleteReport;
  /** Present only for arena-new, once the arena was reserved. */
  arenaNew?: ArenaNewReport;
  /** Present only for arena-pick, once a winner was chosen. */
  arenaPick?: ArenaPickReport;
  /** Present only for new with --assign or --reassign, once the issue and the signed-in account were read. */
  assignment?: AssignmentReport;
  /** Present, and true, only when --no-setup skipped configured post_create hooks. */
  setupSkipped?: true;
}

async function worktreeRecord({ worktree: tree, base, issue }: InventoryEntry): Promise<WorktreeRecord> {
  // Status inspection already checks reciprocal Git identity. Unknown rows must
  // not acquire a different identity through a stale path or replacement symlink.
  const canonicalPath = tree.pathExists && tree.status.kind === "known"
    ? await realpath(tree.path).catch(() => null) : null;
  return { ...tree, detached: tree.branch === null, canonicalPath, base, issue };
}

const unread = { kind: "invalid", reason: "unreadable" } as const;

/** One result after handler completion. Hooks keep their ordinary terminal IO. */
export async function runMachineCommand(
  command: MachineRecord["command"], context: CommandContext,
  action: (context: CommandContext) => Promise<void | number>, resultFile?: string,
  readBase: BaseReader = readBaseAssociation, readIssue: IssueReader = readIssueLink,
): Promise<number> {
  const destination = resultFile === undefined ? null : resolve(context.cwd, resultFile);
  // Exclusive creation rejects existing files and symlinks before any command work.
  const file = destination === null ? null : await open(destination, "wx", 0o600);
  const record: MachineRecord = { schemaVersion: 1, command, outcome: "succeeded", exitCode: 0,
    repository: null, worktree: null, materialized: false, diagnostic: null,
    ...(command === "ls" ? { worktrees: [] } : {}) };
  let discovered: RepositoryContext | null = null;
  let captured: Worktree | null = null;
  // Without a discovered repository there is no identity to read metadata against.
  const savedBase = async (tree: Worktree): Promise<BaseAssociationRead> =>
    discovered === null ? unread : readBase(discovered, tree);
  const savedIssue = async (tree: Worktree): Promise<IssueLinkRead> =>
    discovered === null ? unread : readIssue(discovered, tree);
  const machine: MachineReporter = {
    repository: async repository => {
      discovered = repository;
      record.repository = { commonGitDir: await realpath(repository.commonGitDir),
        primaryWorktreeRoot: repository.primaryWorktreeRoot, currentWorktreeRoot: repository.currentWorktreeRoot };
    },
    worktree: async (tree, materialized) => {
      // Save actual returned state before the optional canonical-path and metadata reads.
      record.materialized = materialized;
      captured = tree;
      record.worktree = { ...tree, detached: tree.branch === null, canonicalPath: null, base: unread, issue: unread };
      record.worktree = await worktreeRecord({ worktree: tree, base: await savedBase(tree), issue: await savedIssue(tree) });
    },
    refreshMetadata: async () => {
      if (captured === null || record.worktree === null) return;
      record.worktree = { ...record.worktree, base: await savedBase(captured), issue: await savedIssue(captured) };
    },
    inventory: async trees => { record.worktrees = await Promise.all(trees.map(worktreeRecord)); },
    rebase: report => { record.rebase = report; },
    publish: report => { record.publish = report; },
    baseChange: report => { record.baseChange = report; },
    pr: report => { record.pr = report; },
    config: report => { record.config = report; },
    backupRestore: report => { record.backupRestore = report; },
    backupDelete: report => { record.backupDelete = report; },
    arenaNew: report => { record.arenaNew = report; },
    arenaPick: report => { record.arenaPick = report; },
    assignment: report => { record.assignment = report; },
    setupSkipped: () => { record.setupSkipped = true; },
    cancelled: () => { record.outcome = "cancelled"; },
  };
  let failure: unknown;
  let failed = false;
  try {
    try {
      record.exitCode = (await action({ ...context, machine })) ?? 0;
      if (record.exitCode !== 0) {
        record.outcome = "failed";
        record.diagnostic = record.rebase?.result === "conflicts"
          ? "Rebase paused with conflicts; resolve and stage them, then continue or abort with Git in the worktree."
          : record.rebase !== undefined
            ? "Git rebase failed or was interrupted; inspect the worktree with Git before retrying."
            : "Command returned a nonzero exit status; reconcile the worktree inventory before retrying.";
      }
    } catch (error) {
      failed = true;
      failure = error;
      record.outcome = "failed";
      record.exitCode = 1;
      record.diagnostic = safeDiagnostic(error instanceof Error ? error.message : "Command failed unexpectedly");
    }
    const json = JSON.stringify(record) + "\n";
    if (file === null) {
      context.io.stdout(json);
    } else {
      const owned = await file.stat();
      const assertOwned = async () => {
        const current = await lstat(destination!).catch(() => null);
        if (!current?.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) {
          throw new Error("Result file was removed or replaced. Workspace state is retained; reconcile timber ls --json before retrying.");
        }
      };
      await assertOwned();
      if ((await file.stat()).size !== 0) {
        throw new Error("Result file was modified. Workspace state is retained; reconcile timber ls --json before retrying.");
      }
      try {
        await file.writeFile(json, "utf8");
        await file.sync();
      } catch {
        throw new Error("Could not write the machine result. Workspace state is retained; reconcile timber ls --json before retrying.");
      }
      await assertOwned();
    }
  } finally {
    await file?.close();
  }
  if (failed) throw failure;
  return record.exitCode;
}
