import { realpath } from "node:fs/promises";
import { execa } from "execa";
import { safeDiagnostic } from "../display";
import { arenaAgentLaunch, assertArenaAttemptResumable } from "../arena/launch";
import { recoverArenaParticipant } from "../arena/recovery";
import { listArenaNames, observeArena, readArena, readArenaPick, validateArenaAttempt } from "../arena/storage";
import { inspectArenaRemoval } from "../arena/summary";
import { validateArenaName } from "../arena/participants";
import { nativeArenaTools, nativeArenaToolSpecs, type NativeArenaTool } from "../arena/tools";
import { attemptState, recordedAgent, type ArenaAttemptState } from "../arena/report";
import type { ArenaAttemptRecord, ArenaManifest, ArenaStage } from "../arena/types";
import type { RepositoryConfig, RepositoryContext } from "../types";

export interface RepositoryIdentity { commonGitDir: string; primaryWorktreeRoot: string; currentWorktreeRoot: string }

/** `ok`: Git still has the exact worktree Timber bound. Never inferred from branch names. */
export type ArenaGitAgreement = "ok" | "stale" | "missing" | "unknown";

export interface AppArenaAttempt {
  label: string;
  tool: ArenaAttemptRecord["tool"];
  preset: string;
  model: string | null;
  effort: string | null;
  branch: string;
  path: string;
  state: ArenaAttemptState;
  stage: ArenaStage;
  failedStage: NonNullable<ArenaAttemptRecord["failedStage"]> | null;
  exitCode: number | null;
  signal: string | null;
  archive: { ref: string; commit: string; present: boolean } | null;
  git: ArenaGitAgreement;
}

export interface AppArenaEntry {
  name: string;
  outcome: "read" | "failed";
  diagnostic: string | null;
  id: string | null;
  base: { ref: string; commit: string } | null;
  createdAt: string | null;
  ticket: string | null;
  active: boolean;
  winner: string | null;
  attempts: AppArenaAttempt[];
}

export interface AppArenaListRecord {
  schemaVersion: 1;
  repository: RepositoryIdentity | null;
  diagnostic: string | null;
  arenas: AppArenaEntry[];
}

export interface AppArenaLaunchRecord {
  schemaVersion: 1;
  repository: RepositoryIdentity | null;
  arena: string;
  attempt: string | null;
  outcome: "ready" | "no-agent" | "failed";
  launch: { argv: string[]; cwd: string; environment: Record<string, string>; unset: string[] } | null;
  diagnostic: string | null;
}

export interface AppArenaTool {
  tool: NativeArenaTool;
  label: string;
  executable: string;
  effort: boolean;
}

export interface AppArenaToolsRecord {
  schemaVersion: 1;
  tools: AppArenaTool[];
}

/** The native tools this Timber accepts for `arena new --tool`; needs no repository. */
export function readAppArenaTools(): AppArenaToolsRecord {
  return { schemaVersion: 1, tools: nativeArenaTools.map(tool => {
    const { label, executable, effort } = nativeArenaToolSpecs[tool];
    return { tool, label, executable, effort };
  }) };
}

export interface AppArenaServices {
  discoverRepository(cwd: string): Promise<RepositoryContext>;
  loadConfig(repository: RepositoryContext): Promise<RepositoryConfig>;
  checkExecutable(command: string): Promise<boolean>;
}

const message = (error: unknown, fallback: string) =>
  safeDiagnostic(error instanceof Error ? error.message : fallback);

async function identity(repository: RepositoryContext): Promise<RepositoryIdentity> {
  return { commonGitDir: await realpath(repository.commonGitDir),
    primaryWorktreeRoot: repository.primaryWorktreeRoot, currentWorktreeRoot: repository.currentWorktreeRoot };
}

async function refCommit(repository: RepositoryContext, ref: string): Promise<string | null> {
  const result = await execa("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repository.primaryWorktreeRoot, stdin: "ignore", reject: false, timeout: 8000, env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function agreement(repository: RepositoryContext, manifest: ArenaManifest, attempt: ArenaAttemptRecord): Promise<ArenaGitAgreement> {
  try {
    await validateArenaAttempt(repository, manifest, attempt);
    return "ok";
  } catch {
    const removal = await inspectArenaRemoval(repository, attempt);
    return removal.worktree === "absent" ? "missing" : removal.worktree === "present" ? "stale" : "unknown";
  }
}

async function readEntry(repository: RepositoryContext, name: string): Promise<AppArenaEntry> {
  const entry: AppArenaEntry = { name, outcome: "read", diagnostic: null, id: null, base: null, createdAt: null,
    ticket: null, active: false, winner: null, attempts: [] };
  try {
    const { manifest, active, createdAt } = await observeArena(repository, name);
    const pick = await readArenaPick(repository, name, manifest);
    entry.id = manifest.id;
    entry.base = { ref: manifest.base.ref, commit: manifest.base.commit };
    entry.createdAt = createdAt;
    entry.ticket = manifest.version === 2 ? manifest.ticket ?? null : null;
    entry.active = active;
    entry.winner = manifest.attempts.find(a => a.id === pick?.winnerId)?.label ?? null;
    entry.attempts = await Promise.all(manifest.attempts.map(async attempt => {
      const archived = pick?.archives.find(a => a.attemptId === attempt.id);
      return {
        label: attempt.label, tool: attempt.tool, preset: attempt.preset,
        ...recordedAgent(manifest, attempt),
        branch: attempt.branch, path: attempt.path,
        state: attemptState(attempt, pick), stage: attempt.stage, failedStage: attempt.failedStage ?? null,
        exitCode: attempt.exitCode ?? null, signal: attempt.signal ?? null,
        archive: archived ? { ref: archived.ref, commit: archived.commit,
          present: await refCommit(repository, archived.ref) === archived.commit } : null,
        git: await agreement(repository, manifest, attempt),
      };
    }));
  } catch (error) {
    return { ...entry, outcome: "failed", diagnostic: message(error, "Cannot read arena record."), attempts: [] };
  }
  return entry;
}

/** Read-only: never takes a lock, writes a record, or changes a ref. */
export async function readAppArenaList(cwd: string, services: Pick<AppArenaServices, "discoverRepository">): Promise<AppArenaListRecord> {
  const record: AppArenaListRecord = { schemaVersion: 1, repository: null, diagnostic: null, arenas: [] };
  let repository: RepositoryContext;
  try {
    repository = await services.discoverRepository(cwd);
    record.repository = await identity(repository);
  } catch (error) {
    return { ...record, repository: null, diagnostic: message(error, "Cannot read the repository.") };
  }
  let names: string[];
  try { names = await listArenaNames(repository); }
  catch { return { ...record, diagnostic: "Cannot read private arena storage; inspect <git common dir>/timber/arenas." }; }
  record.arenas = await Promise.all(names.map(name => readEntry(repository, name)));
  return record;
}

/** The command arena resume would launch for one attempt, without running or recording anything. */
export async function readAppArenaLaunch(
  cwd: string, name: string, label: string | undefined, services: AppArenaServices,
): Promise<AppArenaLaunchRecord> {
  const record: AppArenaLaunchRecord = { schemaVersion: 1, repository: null, arena: name, attempt: label ?? null,
    outcome: "failed", launch: null, diagnostic: null };
  try {
    if (label === undefined) throw new Error("Launch requires --attempt <label>.");
    validateArenaName(name);
    const repository = await services.discoverRepository(cwd);
    record.repository = await identity(repository);
    const { manifest, taskPath } = await readArena(repository, name);
    const selected = manifest.attempts.find(a => a.label === label);
    if (!selected) throw new Error(`No attempt ${JSON.stringify(label)} in arena ${name}; use an exact label from __app-arena list.`);
    const launch = selected.tool !== "manual";
    // Guidance names the non-launching resume an app can run for setup itself.
    assertArenaAttemptResumable(name, selected, launch, { agent: false, editor: false });
    const config = await services.loadConfig(repository);
    const participant = launch ? recoverArenaParticipant(manifest, selected.id, config) : null;
    if (participant?.command && !(await services.checkExecutable(participant.command.command)))
      throw new Error(`Arena agent executable is unavailable for ${selected.label}. Restore its recorded executable/PATH.`);
    const tree = await validateArenaAttempt(repository, manifest, selected);
    const agent = participant && arenaAgentLaunch(participant, {
      arena: name, attempt: selected.label, taskPath, repositoryRoot: repository.primaryWorktreeRoot,
      worktreePath: tree.path, branch: selected.branch,
    });
    if (!agent) return { ...record, outcome: "no-agent" };
    const entries = Object.entries(agent.environment);
    return { ...record, outcome: "ready", launch: {
      argv: [agent.command.command, ...agent.command.args], cwd: tree.path,
      environment: Object.fromEntries(entries.filter((e): e is [string, string] => e[1] !== undefined)),
      unset: entries.filter(([, value]) => value === undefined).map(([key]) => key).sort(),
    } };
  } catch (error) {
    return { ...record, outcome: "failed", launch: null, diagnostic: message(error, "Cannot prepare the attempt's launch.") };
  }
}
