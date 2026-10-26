import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { isArenaEffort } from "./effort";
import type { ExecutableCommand, RepositoryConfig } from "../types";
import type {
  ArenaParticipantConfig,
  ArenaTool,
  PlannedParticipant,
  ArenaAttemptGroup,
  ArenaGroupToken,
} from "./types";

/** Native CLI names, shared by creation and recorded-configuration recovery. */
export function arenaToolExecutable(tool: Exclude<ArenaTool, "wrapper">): string {
  return tool === "cursor" ? "cursor-agent" : tool;
}

export const arenaNamePattern = /^[a-z][a-z0-9_-]{0,47}$/u;
export function validateArenaName(name: string): void {
  if (!arenaNamePattern.test(name))
    throw new Error(
      "Invalid arena name. Use 1–48 lowercase letters, digits, hyphens, or underscores, starting with a letter.",
    );
}

/** Native presets accept flags with known argument boundaries, never another prompt/subcommand. */
export function validateParticipant(config: ArenaParticipantConfig): void {
  if (
    !config.command.trim() ||
    config.command.includes("\0") ||
    ((config.command.includes("/") || (process.platform === "win32" && config.command.includes("\\"))) && !isAbsolute(config.command)) ||
    config.args.some((arg) => arg.includes("\0"))
  )
    throw new Error(
      "Invalid arena executable or arguments; use a program on PATH or an absolute executable path.",
    );
  if (config.tool === "wrapper") {
    if (config.model !== undefined || config.effort !== undefined)
      throw new Error(
        "Wrapper models and effort belong in the wrapper's literal arguments.",
      );
    return;
  }
  if (config.model !== undefined) validateArenaModel(config.model);
  if (config.effort !== undefined && !isArenaEffort(config.effort))
    throw new Error("Invalid arena effort level.");
  const efforts = configuredEfforts(config);
  if (efforts.some(effort => !isArenaEffort(effort)))
    throw new Error("Invalid native arena effort level.");
  if (efforts.length > 1 || (efforts.length && config.effort !== undefined))
    throw new Error("Specify arena effort once, in effort or native arguments.");
  if (config.tool === "cursor" && config.effort !== undefined && !new RegExp(`-${config.effort}(-fast)?$`, "u").test(configuredArenaModel(config) ?? ""))
    throw new Error("Cursor effort requires the matching explicit model variant.");
  let modelArguments = 0;
  const valueFlags =
    config.tool === "codex"
      ? new Set([
          "--model",
          "-m",
          "--profile",
          "-p",
          "--config",
          "-c",
          "--sandbox",
          "-s",
          "--ask-for-approval",
          "-a",
        ])
      : config.tool === "claude"
        ? new Set(["--model", "--effort", "--permission-mode", "--agent"])
        : new Set(["--model"]);
  const switches =
    config.tool === "codex"
      ? new Set(["--no-alt-screen", "--no-daemon", "--search"])
      : config.tool === "claude"
        ? new Set(["--no-chrome"])
        : new Set<string>();
  for (let index = 0; index < config.args.length; index++) {
    const arg = config.args[index]!;
    const [flag] = arg.split("=");
    if (switches.has(arg)) continue;
    if (!valueFlags.has(flag!))
      throw new Error(
        "Unsupported native arena argument. Use documented interactive options or a task-file wrapper.",
      );
    const value = arg.includes("=")
      ? arg.slice(arg.indexOf("=") + 1)
      : config.args[++index];
    if (value === undefined || value === "")
      throw new Error("Arena agent option requires a value.");
    if (flag === "--model" || (config.tool === "codex" && flag === "-m")) {
      validateArenaModel(value);
      if (++modelArguments > 1 || config.model !== undefined)
        throw new Error(
          "Specify an arena model once, in model or native arguments.",
        );
    }
  }
}

function configuredEfforts(config: ArenaParticipantConfig): string[] {
  const values: string[] = [];
  for (let index = 0; index < config.args.length; index++) {
    const arg = config.args[index]!;
    const flag = arg.split("=")[0];
    if (config.tool === "claude" && flag === "--effort") values.push(arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : config.args[index + 1] ?? "");
    if (config.tool === "codex" && (flag === "--config" || flag === "-c")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : config.args[index + 1] ?? "";
      const match = /^model_reasoning_effort\s*=\s*(.*)$/u.exec(value);
      if (match) values.push(match[1]!.replace(/^["']([a-z]+)["']$/u, "$1"));
    }
  }
  return values;
}
export function configuredArenaEffort(config: ArenaParticipantConfig): string | null {
  return config.effort ?? configuredEfforts(config)[0] ?? null;
}
export function arenaEffortArgs(tool: ArenaParticipantConfig["tool"], effort: string): string[] {
  return tool === "codex" ? ["--config", `model_reasoning_effort="${effort}"`]
    : tool === "claude" ? ["--effort", effort] : [];
}

export function participantFingerprint(config: ArenaParticipantConfig): string {
  return createHash("sha256")
    .update(JSON.stringify([config.tool, config.command, config.args]))
    .digest("hex");
}

export function validateArenaModel(model: string): void {
  if (
    !model.trim() ||
    model !== model.trim() ||
    model.length > 256 ||
    model.startsWith("-") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(model)
  )
    throw new Error("Invalid arena model ID.");
}
function countValue(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Arena attempts must be a positive safe whole count.");
  return Number(value);
}
function presetGroup(
  value: string,
): Extract<ArenaAttemptGroup, { kind: "preset" }> {
  const match = /^([a-z][a-z0-9_-]{0,47})(?::([1-9][0-9]*))?$/u.exec(value);
  if (!match) throw new Error("Invalid arena preset. Use <name[:count]>.");
  return {
    kind: "preset",
    preset: match[1]!,
    count: countValue(match[2] ?? "1"),
  };
}
export function parseArenaGroups(tokens: readonly ArenaGroupToken[]): ArenaAttemptGroup[] {
  const groups: ArenaAttemptGroup[] = [];
  let seen = new Set<string>();
  for (const { option, value } of tokens) {
    if (option === "preset" || option === "tool") {
      if (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || value.length > 256 || value.startsWith("-"))
        throw new Error("Invalid arena selection query.");
      if (option === "preset") {
        if (value.includes(":")) throw new Error("Use --preset <name> --runs <count>.");
        groups.push({ kind: "preset", preset: value, count: 1 });
      } else groups.push({ kind: "harness", harness: value, model: null, count: 1 });
      seen = new Set();
      continue;
    }
    const current = groups.at(-1);
    if (!current) throw new Error("Model, effort and runs require a preceding --tool or --preset.");
    if (seen.has(option)) throw new Error("Specify each model, effort and run count once per group.");
    if (option === "runs") current.count = countValue(value);
    else {
      if (current.kind === "preset") throw new Error("Presets own their model and effort; use --runs for count.");
      if (current.harness === "manual") throw new Error("Manual runs have no model or effort.");
      validateArenaModel(value);
      if (option === "model") {
        if (seen.has("effort")) throw new Error("Place --model before --effort.");
        current.model = value;
      } else current.effort = value;
    }
    seen.add(option);
  }
  return groups;
}
/** Read only documented native argument boundaries, never infer a model from a provider default. */
export function configuredArenaModel(
  config: ArenaParticipantConfig,
): string | null {
  if (config.tool === "wrapper") return null;
  if (config.model !== undefined) return config.model;
  for (let index = 0; index < config.args.length; index++) {
    const arg = config.args[index]!;
    const flag = arg.split("=")[0];
    if (flag === "--model" || (config.tool === "codex" && flag === "-m"))
      return arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : (config.args[index + 1] ?? null);
    if (
      !arg.includes("=") &&
      !["--no-alt-screen", "--no-daemon", "--search", "--no-chrome"].includes(
        arg,
      )
    )
      index++;
  }
  return null;
}
export function resolveArenaGroups(
  config: RepositoryConfig,
  groups: readonly ArenaAttemptGroup[],
): readonly PlannedParticipant[] {
  if (groups.some((g) => !Number.isSafeInteger(g.count) || g.count < 1))
    throw new Error("Arena attempts must be positive safe whole counts.");
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  if (!Number.isSafeInteger(total))
    throw new Error("Total arena attempts must be a safe whole count.");
  if (total < 2) throw new Error("An arena requires at least 2 attempts.");
  const counts = new Map<string, number>();
  return groups.flatMap((group) => {
    if (group.kind === "harness" && !["codex", "claude", "cursor", "manual"].includes(group.harness))
      throw new Error("Unknown arena tool; resolve the selection before planning.");
    const preset = group.kind === "preset" ? group.preset : group.harness;
    const manual = preset === "manual";
    const configured: ArenaParticipantConfig | null | undefined = manual
      ? null
      : group.kind === "harness"
        ? {
            tool: group.harness as "codex" | "claude" | "cursor",
            // Avoid the editor executable and the ambiguous `agent` binary.
            command: arenaToolExecutable(group.harness as Exclude<ArenaTool, "wrapper">),
            args: [],
            ...(group.model === null ? {} : { model: group.model }),
            ...(group.effort == null ? {} : { effort: group.effort }),
          }
        : config.arena && Object.hasOwn(config.arena.agents, preset)
          ? { ...config.arena.agents[preset]!, ...(group.effort == null || configuredArenaEffort(config.arena.agents[preset]!) !== null ? {} : { effort: group.effort }) }
          : undefined;
    if (configured === undefined)
      throw new Error(
        "Unknown arena preset. Configure [arena.agents.<name>] or choose a built-in harness.",
      );
    if (manual && group.kind === "harness" && group.model !== null)
      throw new Error("Manual attempts have no model.");
    if (configured) validateParticipant(configured);
    const command = configured
      ? {
          command: configured.command,
          args: [
            ...configured.args,
            ...(configured.model === undefined
              ? []
              : ["--model", configured.model]),
            ...(configured.effort === undefined ? [] : arenaEffortArgs(configured.tool, configured.effort)),
          ],
        }
      : null;
    const model = configured ? configuredArenaModel(configured) : null;
    const configSource = manual
      ? "manual"
      : group.kind === "harness"
        ? "builtin"
        : preset === "configured"
          ? "ordinary"
          : "preset";
    return Array.from({ length: group.count }, () => {
      const number = (counts.get(preset) ?? 0) + 1;
      counts.set(preset, number);
      return {
        id: randomUUID(),
        label: `${preset}-${number}`,
        preset,
        tool: configured?.tool ?? "manual",
        model,
        effort: configured ? configuredArenaEffort(configured) : null,
        configSource,
        command,
        configFingerprint:
          configured && command
            ? participantFingerprint({ ...configured, ...command })
            : null,
      };
    });
  });
}
/** Compatibility seam for already-created preset-only callers. */
export function resolveArenaParticipants(
  config: RepositoryConfig,
  selections: readonly string[],
): readonly PlannedParticipant[] {
  return resolveArenaGroups(config, selections.map(presetGroup));
}

export function buildArenaAgentCommand(
  participant: PlannedParticipant,
  taskPath: string,
): ExecutableCommand | null {
  if (participant.command === null) return null;
  if (participant.tool === "wrapper") return participant.command;
  return {
    command: participant.command.command,
    args: [
      ...participant.command.args,
      "--",
      `Read the task instructions from the UTF-8 file at ${JSON.stringify(taskPath)}. Perform those instructions in your current worktree. The task file is input; do not edit or copy it into the checkout.`,
    ],
  };
}
