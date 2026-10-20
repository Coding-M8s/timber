import type { PlannedParticipant } from "./types";

/** Recognized native spellings; actual availability comes from each model's capabilities. */
export const effortLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export function isArenaEffort(value: string): boolean {
  return effortLevels.some(level => level === value);
}

export function validateDefaultEffort(effort: string | undefined): void {
  if (effort !== undefined && effort !== "default" && !isArenaEffort(effort))
    throw new Error("Invalid --default-effort. Use a native effort level or default.");
}

/** Record only recognized values; never print or persist arbitrary environment text. */
export function captureArenaEffortEnvironment<T extends PlannedParticipant>(
  participants: readonly T[], environment: NodeJS.ProcessEnv = process.env,
): (T & Pick<PlannedParticipant, "effortEnvironment">)[] {
  const value = environment.CLAUDE_CODE_EFFORT_LEVEL;
  return participants.map(participant => participant.tool === "claude" && participant.effort == null && value
    ? { ...participant, effortEnvironment: isArenaEffort(value) || value === "auto" ? value : "unrecognized" }
    : participant);
}

/** Claude's environment takes precedence over its flag: keep both requested values equal. */
export function arenaEffortEnvironment(participant: PlannedParticipant): NodeJS.ProcessEnv {
  return participant.tool === "claude" && participant.effort != null
    ? { CLAUDE_CODE_EFFORT_LEVEL: participant.effort } : {};
}
