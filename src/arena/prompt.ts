import { validateDefaultEffort } from "./effort";
import { arenaModelCatalog, normalizeArenaGroups } from "./selection";
import { applyArenaEffort } from "./models";
import { arenaReviewText } from "./display";
import type { ModelDiscovery } from "./models";
import type { RepositoryConfig } from "../types";
import type { SetupPrompt } from "../setup/types";
import type {
  ArenaParticipantConfig,
  ArenaReview,
  ArenaSourceSelection,
  ArenaTool,
  PlannedParticipant,
  ArenaAttemptGroup,
} from "./types";
import {
  resolveArenaGroups,
  configuredArenaModel,
  validateArenaModel,
} from "./participants";

export async function collectParticipants(
  config: RepositoryConfig,
  prompt: SetupPrompt,
  catalog: ModelDiscovery = arenaModelCatalog(config),
  defaultEffort?: string,
): Promise<readonly PlannedParticipant[] | null> {
  validateDefaultEffort(defaultEffort);
  const inherited = defaultEffort === "default" ? null : defaultEffort ?? null;
  const agents: Record<string, ArenaParticipantConfig> = {
    ...config.arena?.agents,
  };
  const groups: ArenaAttemptGroup[] = [];
  while (true) {
    const tools = [
      { value: "manual", label: "Manual worktrees (no automatic agent)" },
      { value: "codex", label: "Codex CLI — select model" },
      { value: "claude", label: "Claude Code — select model" },
      { value: "cursor", label: "Cursor CLI — select model" },
      ...(Object.keys(agents).length
        ? [
            {
              value: "preset",
              label: "Agent preset (saved tool/model/arguments)",
            },
          ]
        : []),
      ...(config.agent
        ? [
            {
              value: "configured",
              label: "Reuse ordinary [agent] executable and arguments",
            },
          ]
        : []),
    ];
    const tool = await prompt.select(
      "Choose agent tool for this group of runs",
      tools,
      "manual",
      { search: true },
    );
    if (tool === null) return null;
    if (!tools.some((t) => t.value === tool))
      throw new Error("Invalid arena tool selection.");
    let group: ArenaAttemptGroup;
    if (tool === "configured") {
      if (agents.configured === undefined) {
        const handoff = await prompt.select(
          "Choose task handoff for ordinary agent (tool is never guessed)",
          [
            { value: "codex", label: "Codex interactive positional prompt" },
            { value: "claude", label: "Claude interactive positional prompt" },
            { value: "cursor", label: "Cursor interactive positional prompt" },
            {
              value: "wrapper",
              label: "Custom wrapper reading TIMBER_TASK_FILE",
            },
          ],
          "wrapper",
          { search: true },
        );
        if (handoff === null) return null;
        if (!config.agent || !["codex", "claude", "cursor", "wrapper"].includes(handoff))
          throw new Error("Invalid ordinary agent selection.");
        agents.configured = {
          tool: handoff as ArenaTool,
          command: config.agent.command,
          args: config.agent.args,
        };
      }
      group = { kind: "preset", preset: "configured", count: 1 };
    } else if (tool === "preset") {
      const choices = Object.keys(agents)
        .sort()
        .map((name) => ({
          value: name,
          label: `${name} (${agents[name]!.tool}; ${configuredArenaModel(agents[name]!) ?? "configured default / wrapper"})`,
        }));
      const preset = await prompt.select(
        "Choose agent preset",
        choices,
        choices[0]!.value,
        { search: true },
      );
      if (preset === null) return null;
      if (!choices.some((c) => c.value === preset))
        throw new Error("Invalid arena preset selection.");
      group = { kind: "preset", preset, count: 1 };
    } else {
      let model: string | null = null;
      let effort: string | null = null;
      if (tool !== "manual") {
        const models = (await catalog(tool as ArenaTool)).models;
        const choices = [
          { value: "default", label: "Use tool's configured model default" },
          ...models.map((m) => ({ value: `model:${m.value}`, label: m.label })),
          { value: "custom", label: "Enter another model ID" },
        ];
        const selected = await prompt.select(
          "Choose model (native choices and saved presets)",
          choices,
          "default",
          { search: true },
        );
        if (selected === null) return null;
        if (!choices.some((c) => c.value === selected))
          throw new Error("Invalid arena model selection.");
        if (selected === "custom") {
          model = await prompt.text("Model ID");
          if (model === null) return null;
          validateArenaModel(model);
        } else if (selected !== "default")
          model = selected.slice("model:".length);
        const metadata = models.find(choice => choice.value === model);
        if (metadata?.efforts?.length || inherited !== null) {
          const levels = [
            ...(inherited === null ? [] : [{ value: "inherit", label: `Use arena effort default (${inherited})` }]),
            { value: "default", label: "Use tool/model effort default" },
            ...(metadata?.efforts ?? []).map(value => ({ value, label: value })),
          ];
          const level = await prompt.select("Choose effort for this model", levels, inherited === null ? "default" : "inherit");
          if (level === null) return null;
          if (!levels.some(choice => choice.value === level)) throw new Error("Invalid arena effort selection.");
          const selectedEffort = level === "inherit" ? inherited : level === "default" ? null : level;
          if (selectedEffort !== null) {
            // Explicit picker choice can select another advertised Cursor variant.
            model = metadata?.variants?.[selectedEffort] ?? model;
            applyArenaEffort(tool as ArenaTool, model, selectedEffort, models);
            effort = selectedEffort;
          }
        }
      }
      group = {
        kind: "harness",
        harness: tool as "codex" | "claude" | "cursor" | "manual",
        model,
        effort,
        count: 1,
      };
    }
    if (group.kind === "preset") {
      const normalized = await normalizeArenaGroups([group], { ...config, arena: { agents } }, catalog, undefined, defaultEffort);
      if (normalized === null) return null;
      group = normalized[0]!;
    }
    while (true) {
      const answer = await prompt.text(
        "Number of runs for this tool/model",
        "1",
      );
      if (answer === null) return null;
      if (/^[1-9][0-9]*$/u.test(answer) && Number.isSafeInteger(Number(answer))) {
        group.count = Number(answer);
        break;
      }
    }
    groups.push(group);
    const total = groups.reduce((sum, g) => sum + g.count, 0);
    if (!Number.isSafeInteger(total))
      throw new Error("Total arena attempts must be a safe whole count.");
    if (total < 2) continue;
    const more = await prompt.confirm(
      "Add another tool/model or preset group?",
      false,
    );
    if (more === null) return null;
    if (!more) {
      // Wizard choices are exact, including custom IDs; never run fuzzy matching again.
      return resolveArenaGroups({ ...config, arena: { agents } }, groups);
    }
  }
}

export async function reviewArenaPlan(
  plan: ArenaReview,
  prompt: SetupPrompt,
): Promise<boolean> {
  const message = arenaReviewText(plan);
  const headingLines = message.split("\n").flatMap((line, index) =>
    line.startsWith("Arena ") || line.startsWith("Run ") ? [index] : []);
  const labelLines = message.split("\n").flatMap((line, index) => /^  [A-Za-z]+ +/u.test(line) ? [index] : []);
  return (await prompt.confirm(message, false, { headingLines, labelLines })) === true;
}
export async function confirmArenaPlan(
  plan: ArenaReview,
  makePrompt: () => SetupPrompt,
): Promise<boolean> {
  const prompt = makePrompt();
  try {
    return await reviewArenaPlan(plan, prompt);
  } finally {
    prompt.close();
  }
}

export async function chooseArenaSource(
  candidates: readonly ArenaSourceSelection[],
  prompt: SetupPrompt,
): Promise<string | null> {
  const label = (source: ArenaSourceSelection) => ({
    value: source.selector,
    label: `${source.selector} @ ${source.kind === "local" ? source.base.commit : source.advertisedCommit}`,
  });
  const cancel = { value: "cancel", label: "Cancel without changes" };
  const choice = await prompt.select(
    "Multiple starting branches match; choose committed progress",
    [
      cancel,
      ...candidates.slice(0, 5).map(label),
      ...(candidates.length > 5
        ? [
            {
              value: "all",
              label: `Show all ${candidates.length} starting branches`,
            },
          ]
        : []),
    ],
    "cancel",
  );
  if (choice === "all") {
    if (
      (await prompt.confirm(
        `This will display all ${candidates.length} matches. Continue?`,
        false,
      )) !== true
    )
      return null;
    const selected = await prompt.select(
      "Choose starting branch",
      [cancel, ...candidates.map(label)],
      "cancel",
    );
    return selected === "cancel" ? null : selected;
  }
  return choice === "cancel" ? null : choice;
}
