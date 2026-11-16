import { open, lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { safeDiagnostic } from "./display";
import { readBaseAssociation, type BaseAssociationRead } from "./git/base-metadata";
import type { RebaseReport } from "./git/rebase";
import type { CommandContext } from "./services";
import type { RepositoryContext, Worktree } from "./types";

/** Experimental v1 transport. Git's registered path remains authoritative. */
export interface MachineReporter {
  repository(repository: RepositoryContext): Promise<void>;
  /** Captures the worktree with the base saved at this moment. */
  worktree(worktree: Worktree, materialized: boolean): Promise<void>;
  /** Reads the captured worktree's saved base again, after the command changed it. */
  refreshBase(): Promise<void>;
  inventory(entries: readonly InventoryEntry[]): Promise<void>;
  /** Attaches the live rebase report; it is read once the handler has finished. */
  rebase(report: RebaseReport): void;
  cancelled(): void;
}

/** A listed worktree with the saved base the listing already read. */
export interface InventoryEntry {
  worktree: Worktree;
  base: BaseAssociationRead;
}

/** Saved-base read; reports invalid metadata as a value and never throws. */
export type BaseReader = (repository: RepositoryContext, worktree: Worktree) => Promise<BaseAssociationRead>;

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
}

export interface MachineRecord {
  schemaVersion: 1;
  command: "ls" | "new" | "open" | "done" | "rebase";
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
}

async function worktreeRecord({ worktree: tree, base }: InventoryEntry): Promise<WorktreeRecord> {
  // Status inspection already checks reciprocal Git identity. Unknown rows must
  // not acquire a different identity through a stale path or replacement symlink.
  const canonicalPath = tree.pathExists && tree.status.kind === "known"
    ? await realpath(tree.path).catch(() => null) : null;
  return { ...tree, detached: tree.branch === null, canonicalPath, base };
}

const unread = { kind: "invalid", reason: "unreadable" } as const;

/** One result after handler completion. Hooks keep their ordinary terminal IO. */
export async function runMachineCommand(
  command: MachineRecord["command"], context: CommandContext,
  action: (context: CommandContext) => Promise<void | number>, resultFile?: string,
  readBase: BaseReader = readBaseAssociation,
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
      record.worktree = { ...tree, detached: tree.branch === null, canonicalPath: null, base: unread };
      record.worktree = await worktreeRecord({ worktree: tree, base: await savedBase(tree) });
    },
    refreshBase: async () => {
      if (captured === null || record.worktree === null) return;
      record.worktree = { ...record.worktree, base: await savedBase(captured) };
    },
    inventory: async trees => { record.worktrees = await Promise.all(trees.map(worktreeRecord)); },
    rebase: report => { record.rebase = report; },
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
