import { captureArenaEffortEnvironment, validateDefaultEffort } from "./effort";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { CommandContext } from "../services";
import type { RepositoryConfig } from "../types";
import type { SetupPrompt } from "../setup/types";
import type {
  ArenaNewOptions,
  ArenaReview,
  ArenaSourceSelection,
  PlannedParticipant,
} from "./types";
import { arenaModelCatalog, normalizeArenaGroups } from "./selection";
import { discoverArenaModels } from "./models";
import type { ModelDiscovery } from "./models";
import { resolveArenaParticipants, resolveArenaGroups } from "./participants";
import {
  collectParticipants,
  reviewArenaPlan,
  chooseArenaSource,
} from "./prompt";

export interface ArenaInput {
  task: Buffer;
  participants: readonly PlannedParticipant[];
  review?(plan: ArenaReview): Promise<boolean>;
  chooseSource?(
    candidates: readonly ArenaSourceSelection[],
  ): Promise<string | null>;
  close?(): void;
}
export function validateTask(task: Uint8Array): Buffer {
  if (task.length > 1024 * 1024)
    throw new Error("Arena task exceeds 1 MiB; use a shorter task file.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(task);
  } catch {
    throw new Error("Arena task must be valid UTF-8.");
  }
  if (!text.trim() || text.includes("\0"))
    throw new Error("Arena task must contain nonblank text without NUL bytes.");
  return Buffer.from(task);
}
/** Bound reads and reject special files/symlinks before they can block unattended creation. */
export async function readArenaTask(
  path: string,
  cwd: string,
): Promise<Buffer> {
  let file;
  try {
    file = await open(
      resolve(cwd, path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error("invalid task file");
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return validateTask(bytes.subarray(0, offset));
  } catch {
    throw new Error(
      "Cannot use arena task file. Supply a readable regular UTF-8 file, 1 MiB or smaller, with nonblank text and no NUL bytes or symlink.",
    );
  } finally {
    await file?.close();
  }
}
export async function collectArenaInput(
  options: ArenaNewOptions,
  config: RepositoryConfig,
  context: CommandContext,
  makePrompt: () => SetupPrompt,
  discover: ModelDiscovery = discoverArenaModels,
): Promise<ArenaInput | null> {
  validateDefaultEffort(options.defaultEffort);
  if (options.prompt !== undefined && options.taskFile !== undefined)
    throw new Error("--prompt and --prompt-file are mutually exclusive; do not combine them.");
  if (!context.interactive) {
    if (options.taskFile === undefined && options.prompt === undefined)
      throw new Error("Noninteractive arena creation requires --prompt-file <path> or --prompt <text>.");
    if (!options.participants?.length && !options.groups?.length)
      throw new Error("Noninteractive arena creation requires --tool/--runs or --preset <name>.");
  }
  if (options.participants?.length && options.defaultEffort !== undefined)
    throw new Error("Legacy participant inputs do not support --default-effort; supply arena groups instead.");
  if (options.groups?.length && options.participants?.length)
    throw new Error("Do not mix normalized arena groups and legacy participants.");
  let prompt: SetupPrompt | undefined;
  const getPrompt = () => (prompt ??= makePrompt());
  const catalog = arenaModelCatalog(config, discover, warning => context.io.stderr(`${warning}\n`));
  let handedOff = false;
  try {
    let task = options.prompt !== undefined ? validateTask(Buffer.from(options.prompt))
      : options.taskFile !== undefined ? await readArenaTask(options.taskFile, context.cwd) : null;
    const groups = options.groups?.length
      ? await normalizeArenaGroups(options.groups, config, catalog, context.interactive ? getPrompt : undefined, options.defaultEffort) : undefined;
    if (groups === null) return null;
    const supplied = groups ? resolveArenaGroups(config, groups)
      : options.participants?.length ? resolveArenaParticipants(config, options.participants) : null;
    if (!context.interactive && supplied?.some(p => p.tool !== "manual") && options.agent !== false)
      throw new Error("Automatic arena agents require an interactive terminal with CI disabled. Use --no-agent to prepare unattended runs.");
    if (task === null) {
      const lines: string[] = [];
      let length = 0;
      while (true) {
        const line = await getPrompt().text(lines.length ? "Task next line (/done to finish)" : "Task instructions; multiple lines supported (/done to finish)");
        if (line === null) return null;
        if (line === "/done") break;
        length += Buffer.byteLength(line) + 1;
        if (length > 1024 * 1024) throw new Error("Arena task exceeds 1 MiB.");
        lines.push(line);
      }
      task = validateTask(Buffer.from(lines.join("\n")));
    }
    const participants = supplied ?? await collectParticipants(config, getPrompt(), catalog, options.defaultEffort);
    if (participants === null) return null;
    handedOff = true;
    return {
      task, participants: captureArenaEffortEnvironment(participants),
      review: plan => reviewArenaPlan(plan, getPrompt()),
      chooseSource: candidates => chooseArenaSource(candidates, getPrompt()),
      close: () => prompt?.close(),
    };
  } finally {
    if (!handedOff) prompt?.close();
  }
}
