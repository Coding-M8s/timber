import type { ExecutableCommand, ValidatedBase, RemoteBranch } from "../types";

export type ArenaTool = "codex" | "claude" | "cursor" | "wrapper";
export interface ArenaParticipantConfig extends ExecutableCommand {
  tool: ArenaTool;
  model?: string | undefined;
  effort?: string | undefined;
}
export interface ArenaConfig {
  agents: Readonly<Record<string, ArenaParticipantConfig>>;
}
export type ArenaAttemptGroup =
  | {
      kind: "harness";
      /** Raw tool query until selection normalization. */
      harness: string;
      model: string | null;
      effort?: string | null;
      count: number;
    }
  | { kind: "preset"; preset: string; count: number; effort?: string | null };
export interface ArenaGroupToken {
  option: "tool" | "model" | "effort" | "runs" | "preset";
  value: string;
}
export interface ArenaNewOptions {
  defaultEffort?: string;
  name?: string;
  groups?: readonly ArenaAttemptGroup[];
  taskFile?: string;
  prompt?: string;
  participants?: readonly string[];
  base?: string;
  agent?: false;
  editor?: boolean;
}
export interface PlannedParticipant {
  /** Safe snapshot of an inherited Claude effort setting, not runtime confirmation. */
  effortEnvironment?: string;
  model?: string | null;
  effort?: string | null;
  configSource?: "builtin" | "preset" | "ordinary" | "manual";
  id: string;
  label: string;
  preset: string;
  tool: ArenaTool | "manual";
  command: ExecutableCommand | null;
  configFingerprint: string | null;
}
export interface PlannedAttempt extends PlannedParticipant {
  branch: string;
  path: string;
}
export interface ArenaSourceRecord {
  kind: "local" | "remote";
  selector: string;
  provenance: ArenaSourceProvenance;
  ticketBranchMissing: boolean;
  remote?: string;
}
export interface ArenaDraft {
  ticket?: string;
  name: string;
  attempts: readonly PlannedAttempt[];
  source: ArenaSourceSelection;
}
export type ArenaReview = ArenaDraft | ArenaPlan;
export interface ArenaPlan {
  source?: ArenaSourceRecord;
  ticket?: string;
  name: string;
  base: ValidatedBase;
  attempts: readonly PlannedAttempt[];
}
export type ArenaStage =
  | "planned"
  | "created"
  | "setup-running"
  | "ready"
  | "launch-running"
  | "exited"
  | "failed";
export interface ArenaAttemptRecord {
  id: string;
  label: string;
  preset: string;
  tool: ArenaTool | "manual";
  configFingerprint: string | null;
  branch: string;
  path: string;
  worktreeGitDir: string | null;
  stage: ArenaStage;
  failedStage?: "creation" | "setup" | "editor" | "agent";
  exitCode?: number;
  signal?: NodeJS.Signals | null;
}
export interface ArenaManifestV1 {
  version: 1;
  id: string;
  name: string;
  primaryWorktreeRoot: string;
  commonGitDir: string;
  base: ValidatedBase;
  task: { file: "task.txt"; sha256: string };
  attempts: ArenaAttemptRecord[];
}

export type ArenaSourceProvenance =
  | "explicit"
  | "ticket"
  | "config"
  | "remote-default"
  | "fallback";
interface ArenaSourceContext {
  selector: string;
  provenance: ArenaSourceProvenance;
  knownRemoteBranches: readonly string[];
  ticketBranchMissing: boolean;
}
export type ArenaSourceSelection = ArenaSourceContext &
  (
    | { kind: "local"; base: ValidatedBase }
    | { kind: "remote"; branch: RemoteBranch; advertisedCommit: string }
  );

export interface ArenaAttemptRecordV2 extends ArenaAttemptRecord {
  effortEnvironment?: string;
  effort?: string | null;
  harness: ArenaTool | "manual";
  model: string | null;
  configSource: "builtin" | "preset" | "ordinary" | "manual";
}
export interface ArenaManifestV2
  extends Omit<ArenaManifestV1, "version" | "attempts"> {
  version: 2;
  source: ArenaSourceRecord;
  ticket?: string;
  attempts: ArenaAttemptRecordV2[];
}
export type ArenaManifest = ArenaManifestV1 | ArenaManifestV2;

export interface ArenaResumeOptions {
  /** Exact recorded attempt label; required without an interactive chooser. */
  attempt?: string;
  setup?: true;
  agent?: false;
  editor?: boolean;
}

export interface ArenaPickOptions {
  winner?: string;
  keepBranch?: boolean;
  keepIgnored?: boolean;
  /** Read-only summaries and inspection commands. */
  inspect?: boolean;
  /** With inspect: print the comparison as one JSON record instead. */
  json?: boolean;
}

export interface ArenaPickArchive {
  attemptId: string;
  ref: string;
  commit: string;
}

export interface ArenaPickRecord {
  version: 1;
  arenaId: string;
  winnerId: string;
  archives: ArenaPickArchive[];
}
