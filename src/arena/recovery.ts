import type { RepositoryConfig } from "../types";
import type { ArenaManifest, ArenaParticipantConfig, PlannedParticipant } from "./types";
import {
  arenaEffortArgs, arenaToolExecutable, configuredArenaEffort, configuredArenaModel,
  participantFingerprint, validateParticipant,
} from "./participants";

/** Replay recorded references only. Current catalogs and native defaults cannot prove history. */
export function recoverArenaParticipant(
  manifest: ArenaManifest, attemptId: string, config: RepositoryConfig,
): PlannedParticipant {
  const attempt = manifest.attempts.find(a => a.id === attemptId);
  const recorded = manifest.version === 2 ? manifest.attempts.find(a => a.id === attemptId) : undefined;
  const failure = () => new Error(
    "Arena participant configuration is missing or changed; restore the original preset/ordinary configuration matching its fingerprint, or revisit with --no-agent. No replacement was selected.",
  );
  if (!attempt) throw failure();
  const identity = {
    id: attempt.id, label: attempt.label, preset: attempt.preset, tool: attempt.tool,
    configFingerprint: attempt.configFingerprint,
    ...(recorded ? {
      configSource: recorded.configSource, model: recorded.model,
      ...(recorded.effort === undefined ? {} : { effort: recorded.effort }),
      ...(recorded.effortEnvironment === undefined ? {} : { effortEnvironment: recorded.effortEnvironment }),
    } : {}),
  };
  if (attempt.tool === "manual") {
    if (attempt.configFingerprint !== null || attempt.preset !== "manual" ||
      (recorded && recorded.configSource !== "manual")) throw failure();
    return { ...identity, command: null };
  }
  let candidate: ArenaParticipantConfig | undefined;
  if (recorded?.configSource === "builtin") {
    if (attempt.tool === "wrapper" || attempt.preset !== attempt.tool) throw failure();
    candidate = { tool: attempt.tool, command: arenaToolExecutable(attempt.tool), args: [],
      ...(recorded.model === null ? {} : { model: recorded.model }) };
  } else if (recorded?.configSource === "ordinary" || (!recorded && attempt.preset === "configured")) {
    if (config.agent && attempt.preset === "configured")
      candidate = { tool: attempt.tool, command: config.agent.command, args: [...config.agent.args] };
  } else if (!recorded || recorded.configSource === "preset") {
    if (config.arena && Object.hasOwn(config.arena.agents, attempt.preset))
      candidate = { ...config.arena.agents[attempt.preset]! };
  }
  if (!candidate || candidate.tool !== attempt.tool) throw failure();
  // Creation may have appended an invocation-wide effort absent from the saved preset.
  if (recorded?.effort != null && configuredArenaEffort(candidate) === null)
    candidate = { ...candidate, effort: recorded.effort };
  try {
    validateParticipant(candidate);
    if (recorded && (configuredArenaModel(candidate) !== recorded.model ||
      (recorded.effort !== undefined && configuredArenaEffort(candidate) !== recorded.effort))) throw failure();
    const command = {
      command: candidate.command,
      args: [...candidate.args,
        ...(candidate.model === undefined ? [] : ["--model", candidate.model]),
        ...(candidate.effort === undefined ? [] : arenaEffortArgs(candidate.tool, candidate.effort))],
    };
    if (participantFingerprint({ ...candidate, ...command }) !== attempt.configFingerprint) throw failure();
    return { ...identity, command };
  } catch { throw failure(); }
}
