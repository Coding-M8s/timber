import { open, lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { safeDiagnostic } from "./display";
import type { CommandContext } from "./services";
import type { RepositoryContext, Worktree } from "./types";

/** Experimental v1 transport. Git's registered path remains authoritative. */
export interface MachineReporter {
  repository(repository: RepositoryContext): Promise<void>;
  worktree(worktree: Worktree, materialized: boolean): Promise<void>;
  inventory(worktrees: readonly Worktree[]): Promise<void>;
  cancelled(): void;
}

interface RepositoryIdentity {
  commonGitDir: string;
  primaryWorktreeRoot: string;
  currentWorktreeRoot: string;
}

interface WorktreeRecord extends Worktree {
  detached: boolean;
  /** Null when the registered path cannot be verified; never adopt a replacement. */
  canonicalPath: string | null;
}

export interface MachineRecord {
  schemaVersion: 1;
  command: "ls" | "new" | "open" | "done";
  outcome: "succeeded" | "cancelled" | "failed";
  exitCode: number;
  repository: RepositoryIdentity | null;
  worktree: WorktreeRecord | null;
  /** True only after the creation service returned successfully. */
  materialized: boolean;
  diagnostic: string | null;
  worktrees?: WorktreeRecord[];
}

async function worktreeRecord(tree: Worktree): Promise<WorktreeRecord> {
  // Status inspection already checks reciprocal Git identity. Unknown rows must
  // not acquire a different identity through a stale path or replacement symlink.
  const canonicalPath = tree.pathExists && tree.status.kind === "known"
    ? await realpath(tree.path).catch(() => null) : null;
  return { ...tree, detached: tree.branch === null, canonicalPath };
}

/** One result after handler completion. Hooks keep their ordinary terminal IO. */
export async function runMachineCommand(
  command: MachineRecord["command"], context: CommandContext,
  action: (context: CommandContext) => Promise<void | number>, resultFile?: string,
): Promise<number> {
  const destination = resultFile === undefined ? null : resolve(context.cwd, resultFile);
  // Exclusive creation rejects existing files and symlinks before any command work.
  const file = destination === null ? null : await open(destination, "wx", 0o600);
  const record: MachineRecord = { schemaVersion: 1, command, outcome: "succeeded", exitCode: 0,
    repository: null, worktree: null, materialized: false, diagnostic: null,
    ...(command === "ls" ? { worktrees: [] } : {}) };
  const machine: MachineReporter = {
    repository: async repository => {
      record.repository = { commonGitDir: await realpath(repository.commonGitDir),
        primaryWorktreeRoot: repository.primaryWorktreeRoot, currentWorktreeRoot: repository.currentWorktreeRoot };
    },
    worktree: async (tree, materialized) => {
      // Save actual returned state before the optional canonical-path read.
      record.materialized = materialized;
      record.worktree = { ...tree, detached: tree.branch === null, canonicalPath: null };
      record.worktree = await worktreeRecord(tree);
    },
    inventory: async trees => { record.worktrees = await Promise.all(trees.map(worktreeRecord)); },
    cancelled: () => { record.outcome = "cancelled"; },
  };
  let failure: unknown;
  let failed = false;
  try {
    try {
      record.exitCode = (await action({ ...context, machine })) ?? 0;
      if (record.exitCode !== 0) {
        record.outcome = "failed";
        record.diagnostic = "Command returned a nonzero exit status; reconcile the worktree inventory before retrying.";
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
