import type { ArenaAttemptRecord, ArenaManifest, ArenaPickRecord, ArenaStage } from "./types";

type FailedStage = NonNullable<ArenaAttemptRecord["failedStage"]>;

export interface ArenaNewAttemptReport {
  label: string;
  tool: ArenaAttemptRecord["tool"];
  preset: string;
  model: string | null;
  effort: string | null;
  branch: string;
  path: string;
  /** True once Timber created and bound this attempt's worktree. */
  created: boolean;
  /** How far the attempt got, as recorded; `ready` is the end with --no-agent. */
  stage: ArenaStage;
  failedStage: FailedStage | null;
}

export interface ArenaNewReport {
  name: string;
  id: string;
  base: { ref: string; commit: string };
  /** The stage and attempt where creation stopped; null when every attempt finished. */
  failure: { stage: FailedStage; attempt: string | null } | null;
  attempts: ArenaNewAttemptReport[];
}

export type ArenaPickOutcome = "winner" | "removed" | "archived" | "kept" | "partly-removed" | "already-removed";

export interface ArenaPickAttemptReport {
  label: string;
  outcome: ArenaPickOutcome;
  /** The refs/timber/arena/... ref holding the attempt's work, when one was saved. */
  archiveRef: string | null;
  /** Why the attempt was kept or only partly removed; null otherwise. */
  reason: string | null;
}

export interface ArenaPickReport {
  name: string;
  winner: string;
  attempts: ArenaPickAttemptReport[];
}

/** Recorded model and effort; version 1 records have neither. */
export function recordedAgent(manifest: ArenaManifest, attempt: ArenaAttemptRecord): { model: string | null; effort: string | null } {
  const recorded = manifest.version === 2 ? manifest.attempts.find(a => a.id === attempt.id) : undefined;
  return { model: recorded?.model ?? null, effort: recorded?.effort ?? null };
}

export function arenaNewReport(manifest: ArenaManifest, failure: ArenaNewReport["failure"]): ArenaNewReport {
  return {
    name: manifest.name, id: manifest.id, base: { ref: manifest.base.ref, commit: manifest.base.commit }, failure,
    attempts: manifest.attempts.map(attempt => ({
      label: attempt.label, tool: attempt.tool, preset: attempt.preset, ...recordedAgent(manifest, attempt),
      branch: attempt.branch, path: attempt.path, created: attempt.worktreeGitDir !== null,
      stage: attempt.stage, failedStage: attempt.failedStage ?? null,
    })),
  };
}

export type ArenaAttemptState = "incomplete" | "prepared" | "setup-failed" | "launched" | "picked" | "archived";

/** One word for the app; the recorded stage stays available beside it. */
export function attemptState(attempt: ArenaAttemptRecord, pick: ArenaPickRecord | null): ArenaAttemptState {
  if (pick?.winnerId === attempt.id) return "picked";
  if (pick?.archives.some(a => a.attemptId === attempt.id)) return "archived";
  // An editor that failed to start left a set-up attempt whose agent never ran.
  if (attempt.stage === "ready" || (attempt.stage === "failed" && attempt.failedStage === "editor")) return "prepared";
  if (attempt.stage === "launch-running" || attempt.stage === "exited") return "launched";
  if (attempt.stage === "failed" && attempt.failedStage === "agent") return "launched";
  if (attempt.stage === "failed" && attempt.failedStage === "setup") return "setup-failed";
  return "incomplete";
}
