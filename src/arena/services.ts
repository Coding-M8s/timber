import type { CommandContext, CommandServices } from "../services";
import type {
  RepositoryConfig,
  RepositoryContext,
  ValidatedBase,
  Worktree,
  Resolution,
} from "../types";
import type { ArenaInput } from "./input";
import type { ArenaSession } from "./storage";
import type {
  ArenaAttemptRecord,
  ArenaManifest,
  ArenaNewOptions,
  ArenaPlan,
  ArenaDraft,
  ArenaReview,
  ArenaSourceSelection,
  PlannedParticipant,
} from "./types";

/** Arena orchestration seams; ordinary command doubles stay independent. */
export interface ArenaServices
  extends Pick<
    CommandServices,
    | "discoverRepository"
    | "loadConfig"
    | "createWorktree"
    | "runSetup"
    | "launchEditor"
    | "launchAgent"
  > {
  collectInput(
    options: ArenaNewOptions,
    config: RepositoryConfig,
    context: CommandContext,
  ): Promise<ArenaInput | null>;
  confirmPlan(
    plan: ArenaReview,
    review?: (plan: ArenaReview) => Promise<boolean>,
  ): Promise<boolean>;
  chooseSource(
    candidates: readonly ArenaSourceSelection[],
  ): Promise<string | null>;
  resolveSource(
    repository: RepositoryContext,
    config: RepositoryConfig,
    input: { base?: string; ticket?: string },
  ): Promise<Resolution<ArenaSourceSelection>>;
  finalizeSource(
    repository: RepositoryContext,
    config: RepositoryConfig,
    source: ArenaSourceSelection,
  ): Promise<ValidatedBase>;
  checkExecutable(command: string): Promise<boolean>;
  planDraft(
    repository: RepositoryContext,
    config: RepositoryConfig,
    name: string,
    participants: readonly PlannedParticipant[],
    source: ArenaSourceSelection,
  ): Promise<ArenaDraft>;
  reserveArena(
    repository: RepositoryContext,
    plan: ArenaPlan,
    task: Uint8Array,
  ): Promise<ArenaSession>;
  validateArenaAttempt(
    repository: RepositoryContext,
    manifest: ArenaManifest,
    attempt: ArenaAttemptRecord,
  ): Promise<Worktree>;
}

/** Resume deliberately has no source, creation, binding, or cleanup capabilities. */
export interface ArenaResumeServices extends Pick<CommandServices,
  "discoverRepository" | "loadConfig" | "runSetup" | "launchEditor" | "launchAgent"> {
  readArena(repository: RepositoryContext, name: string): Promise<{ manifest: ArenaManifest; taskPath: string }>;
  openArenaForResume(repository: RepositoryContext, name: string, expected: ArenaManifest): Promise<import("./storage").ArenaResumeSession>;
  validateArenaAttempt(repository: RepositoryContext, manifest: ArenaManifest, attempt: ArenaAttemptRecord): Promise<Worktree>;
  checkExecutable(command: string): Promise<boolean>;
}
