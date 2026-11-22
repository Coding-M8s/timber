import type { ChoiceOption } from "../selection";
import type { SetupPrompt } from "../setup/types";
import type { RepositoryConfig } from "../types";
import { validateDefaultEffort } from "./effort";
import { resolveChoice } from "../search";
import { safeDiagnostic } from "../display";
import { configuredArenaModel, configuredArenaEffort, validateArenaModel } from "./participants";
import { applyArenaEffort, discoverArenaModels } from "./models";
import type { ArenaModelCatalog, ModelDiscovery } from "./models";
import type { ArenaAttemptGroup, ArenaTool } from "./types";
import { nativeArenaTools, nativeArenaToolSpecs, type NativeArenaTool } from "./tools";

export const arenaTools: readonly ChoiceOption[] = [
  ...nativeArenaTools.map(value => ({ value, label: nativeArenaToolSpecs[value].label })),
  { value: "manual", label: "Manual worktrees (no automatic agent)" },
];

export async function resolveArenaChoice(query: string, choices: readonly ChoiceOption[], label: string, prompt?: () => SetupPrompt): Promise<string | null> {
  const result = resolveChoice(query, choices);
  if (result.kind === "match") return result.choice.value;
  if (result.kind === "none") throw new Error(`No matching ${label}. Choices: ${choices.map(c => safeDiagnostic(c.value)).join(", ") || "none configured"}.`);
  if (!prompt) throw new Error(`Ambiguous ${label}. Use an exact value: ${result.choices.map(c => safeDiagnostic(c.value)).join(", ")}.`);
  const selected = await prompt().select(`Choose ${label}`, result.choices, result.choices[0]!.value, { search: true, query });
  if (selected !== null && !result.choices.some(choice => choice.value === selected)) throw new Error("Invalid arena selection.");
  return selected;
}

/** One discovery per tool per invocation; configured exact IDs supplement native choices. */
export function arenaModelCatalog(config: RepositoryConfig, discover: ModelDiscovery = discoverArenaModels, warn: (text: string) => void = () => {}): ModelDiscovery {
  const catalogs = new Map<ArenaTool, Promise<ArenaModelCatalog>>();
  return tool => {
    if (!catalogs.has(tool)) catalogs.set(tool, (async () => {
      const catalog = await discover(tool);
      if (catalog.warning) warn(catalog.warning);
      const models = [...catalog.models];
      for (const preset of Object.values(config.arena?.agents ?? {})) {
        const id = preset.tool === tool ? configuredArenaModel(preset) : null;
        if (id && !models.some(model => model.value === id)) models.push({ value: id, label: `${id} (saved preset)` });
      }
      return { ...catalog, models };
    })());
    return catalogs.get(tool)!;
  };
}

export async function normalizeArenaGroups(groups: readonly ArenaAttemptGroup[], config: RepositoryConfig, catalog: ModelDiscovery, prompt?: () => SetupPrompt, defaultEffort?: string): Promise<ArenaAttemptGroup[] | null> {
  validateDefaultEffort(defaultEffort);
  const normalized: ArenaAttemptGroup[] = [];
  for (const group of groups) {
    if (group.kind === "preset") {
      const choices = Object.keys(config.arena?.agents ?? {}).sort().map(value => ({ value, label: value }));
      const preset = await resolveArenaChoice(group.preset, choices, "agent preset", prompt);
      if (preset === null) return null;
      const selected = config.arena!.agents[preset]!;
      // Wrappers and tools without Timber effort support never inherit the arena default.
      const inherits = selected.tool !== "wrapper" && nativeArenaToolSpecs[selected.tool].effort;
      const effort = configuredArenaEffort(selected) ?? group.effort ?? (!inherits || defaultEffort === "default" ? null : defaultEffort ?? null);
      if (effort !== null) applyArenaEffort(selected.tool, configuredArenaModel(selected), effort, (await catalog(selected.tool)).models);
      normalized.push({ ...group, preset, ...(effort === null ? {} : { effort }) });
      continue;
    }
    const tool = await resolveArenaChoice(group.harness, arenaTools, "agent tool", prompt);
    if (tool === null) return null;
    if (tool === "manual") {
      if (group.model !== null || group.effort != null) throw new Error("Manual runs have no model or effort.");
      normalized.push({ ...group, harness: tool }); continue;
    }
    const spec = nativeArenaToolSpecs[tool as NativeArenaTool];
    if (!spec.effort && group.effort != null && group.effort !== "default")
      throw new Error(`${spec.label} effort is not supported in arena; use its native default.`);
    // Tools without Timber effort support keep their native setting under an arena default.
    const requested = spec.effort ? group.effort ?? defaultEffort : null;
    const effort = requested === "default" ? null : requested ?? null;
    let model = group.model;
    const models = model !== null || effort !== null ? (await catalog(tool as ArenaTool)).models : [];
    if (model !== null) {
      const result = resolveChoice(model, models);
      // An unknown exact/custom ID stays literal; native tool validates its availability.
      if (result.kind !== "none") {
        model = await resolveArenaChoice(model, models, `${tool} model`, prompt);
        if (model === null) return null;
      }
      validateArenaModel(model);
    }
    if (effort !== null) applyArenaEffort(tool as ArenaTool, model, effort, models);
    normalized.push({ ...group, harness: tool, model, effort });
  }
  return normalized;
}
