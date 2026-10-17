import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { ChoiceOption } from "../selection";
import type { ArenaTool } from "./types";
import { validateArenaModel, arenaEffortArgs } from "./participants";
import { effortLevels } from "./effort";

export interface ArenaModel extends ChoiceOption {
  efforts?: readonly string[];
  effort?: string;
  variants?: Readonly<Record<string, string>>;
}
export interface ArenaModelCatalog { models: readonly ArenaModel[]; warning?: string }
export type ModelDiscovery = (tool: ArenaTool) => Promise<ArenaModelCatalog>;
const validId = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try { validateArenaModel(value); return true; } catch { return false; }
};
const safeLevels = (values: readonly unknown[]) => effortLevels.filter(level => values.includes(level));

export function parseCursorModels(text: string): ArenaModel[] {
  const models: ArenaModel[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([^\s]+) - (.+)$/u.exec(line);
    if (match && validId(match[1]) && !models.some(m => m.value === match[1]))
      models.push({ value: match[1], label: `${match[2]} (${match[1]})` });
  }
  const effortVariant = new RegExp(`^(.*)-(${effortLevels.join("|")})(-fast)?$`, "u");
  for (const model of models) {
    const match = effortVariant.exec(model.value);
    if (!match) continue;
    const variants: Record<string, string> = {};
    for (const level of effortLevels) {
      const id = `${match[1]}-${level}${match[3] ?? ""}`;
      if (models.some(m => m.value === id)) variants[level] = id;
    }
    model.effort = match[2]!;
    model.efforts = Object.keys(variants);
    model.variants = variants;
  }
  return models;
}

export function parseCodexModels(source: string): ArenaModel[] {
  const data: unknown = JSON.parse(source);
  if (!data || typeof data !== "object" || !("models" in data) || !Array.isArray(data.models)) return [];
  return data.models.flatMap((model: any) => {
    if (!model || !validId(model.slug) || (model.visibility && model.visibility !== "list")) return [];
    const levels = Array.isArray(model.supported_reasoning_levels)
      ? safeLevels(model.supported_reasoning_levels.map((entry: any) => entry?.effort)) : [];
    return [{ value: model.slug, label: `${typeof model.display_name === "string" ? model.display_name : model.slug} (${model.slug})`, efforts: levels }];
  });
}

/** Read only native model metadata; never start a task, print credentials, or persist a catalog. */
export const discoverArenaModels: ModelDiscovery = async tool => {
  try {
    if (tool === "codex") {
      const models = parseCodexModels(await readFile(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json"), "utf8"));
      return { models, ...(models.length ? {} : { warning: "Codex model cache has no selectable models. Use native default, a saved preset, or an exact custom model ID." }) };
    }
    if (tool === "cursor" || tool === "claude") {
      const { stdout } = await execa(tool === "cursor" ? "cursor-agent" : "claude", tool === "cursor" ? ["models"] : ["--help"], {
        stdin: "ignore", timeout: 8000, maxBuffer: 1024 * 1024,
        env: { NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      if (tool === "claude") {
        // Global --help describes accepted syntax, not the capabilities of a resolved alias.
        const models = stdout.includes("--model")
          ? ["sonnet", "opus", "haiku", ...(stdout.includes("'fable'") ? ["fable"] : [])].map(value => ({ value, label: `${value} (native alias; account availability checked by Claude)` }))
          : [];
        return { models, warning: "Claude model-specific effort capabilities are unavailable. Use native effort defaults; select effort inside Claude when supported." };
      }
      const models = parseCursorModels(stdout);
      return { models, ...(models.length ? {} : { warning: "Tool returned no model choices. Use native default, a saved preset, or an exact custom model ID." }) };
    }
    return { models: [] };
  } catch {
    return { models: [], warning: "Model discovery unavailable. Use native default, a saved preset, or an exact custom model ID. Effort overrides require known model capabilities." };
  }
};

export function applyArenaEffort(tool: ArenaTool, model: string | null, effort: string, models: readonly ArenaModel[]): { model: string; args: string[] } {
  const selected = models.find(choice => choice.value === model);
  if (!selected?.efforts?.includes(effort))
    throw new Error(`Effort is not supported for this tool/model. Choose a known model; supported levels: ${selected?.efforts?.join(", ") || "unknown; use native default"}.`);
  if (tool === "cursor" && selected.effort !== effort)
    throw new Error("Effort conflicts with selected Cursor model variant. Select the matching variant or omit --effort.");
  return { model: selected.value, args: arenaEffortArgs(tool, effort) };
}
