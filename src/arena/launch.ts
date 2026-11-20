import { arenaEffortEnvironment } from "./effort";
import { buildArenaAgentCommand } from "./participants";
import type { ExecutableCommand } from "../types";
import { arenaResumeRetry } from "./display";
import type { ArenaAttemptRecord, ArenaResumeOptions, PlannedParticipant } from "./types";

/** Where an attempt's agent runs and what it learns about its arena. */
export interface ArenaLaunchTarget {
  arena: string;
  attempt: string;
  taskPath: string;
  repositoryRoot: string;
  worktreePath: string;
  branch: string;
}

export interface ArenaAgentLaunch {
  command: ExecutableCommand;
  /** Overlay on the inherited environment; an undefined value removes the variable. */
  environment: NodeJS.ProcessEnv;
}

/**
 * The one definition of an attempt's agent command and environment, shared by
 * arena new, arena resume and __app-arena launch so they never drift apart.
 * Null means the attempt has no agent (manual).
 */
export function arenaAgentLaunch(participant: PlannedParticipant, target: ArenaLaunchTarget): ArenaAgentLaunch | null {
  const command = buildArenaAgentCommand(participant, target.taskPath);
  if (command === null) return null;
  return {
    command,
    environment: {
      ...arenaEffortEnvironment(participant),
      TIMBER_TASK_FILE: target.taskPath,
      TIMBER_ARENA: target.arena,
      TIMBER_ATTEMPT: target.attempt,
      TIMBER_REPO: target.repositoryRoot,
      TIMBER_WORKTREE: target.worktreePath,
      TIMBER_BRANCH: target.branch,
      TIMBER_WORKFLOW: undefined,
      TIMBER_TASK_ID: undefined,
    },
  };
}

function incompleteSetup(attempt: ArenaAttemptRecord): boolean {
  return attempt.stage === "created" || attempt.stage === "setup-running" ||
    (attempt.stage === "failed" && attempt.failedStage === "setup");
}

/**
 * Resume's refusals before any work: uncertain, uncreated, or (when an agent
 * would launch) incompletely set up attempts are never continued.
 */
export function assertArenaAttemptResumable(
  name: string, selected: ArenaAttemptRecord, launch: boolean, options: ArenaResumeOptions,
): void {
  if (selected.stage !== "failed" && selected.failedStage !== undefined)
    throw new Error(`Arena attempt ${selected.label} has inconsistent lifecycle metadata; inspect and explicitly repair the record before recovery.`);
  if (selected.stage === "launch-running" ||
    (selected.stage === "failed" && selected.failedStage === undefined))
    throw new Error(`Arena attempt ${selected.label} has an uncertain interrupted stage; inspect processes and private metadata before explicit repair. Nothing was relaunched.`);
  if (selected.stage === "planned" || selected.failedStage === "creation" || selected.worktreeGitDir === null)
    throw new Error(`Arena attempt ${selected.label} was not completely created and bound; inspect Git worktrees and private metadata. Nothing was recreated.`);
  if (launch && incompleteSetup(selected) && !options.setup)
    throw new Error(`Arena attempt ${selected.label} has incomplete setup. Deliberately rerun every hook with ${arenaResumeRetry(name, selected.label, true, options)}, or revisit with --no-agent.`);
}
