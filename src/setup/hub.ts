import type { LinearSetupSession } from "./linear";
import { configFileSchema, resolveConfig } from "../config";
import type { ConfigFile } from "../config";
import { safeDisplay } from "../display";
import type { CommandIO } from "../services";
import type { ChoiceOption } from "../selection";
import { editSetupSection, questionnaire } from "./questions";
import type { SetupSection } from "./questions";
import { SetupCancelled } from "./types";
import type { SetupPrompt, SetupTarget } from "./types";
import type { JiraSetupSession } from "./jira";
import type { GithubSetupSession } from "./github";

const sections: readonly { value: SetupSection; title: string }[] = [
  { value: "editor", title: "Editor" },
  { value: "agent", title: "Coding assistant" },
  { value: "jira", title: "Jira tickets" },
  { value: "hooks", title: "Setup scripts" },
  { value: "pre_delete", title: "Pre-done scripts" },
  { value: "base_branch", title: "Starting branch" },
  { value: "remote", title: "Git remote" },
  { value: "worktree_dir", title: "Workspace folder" },
];

function inheritedNote(file: ConfigFile, target: SetupTarget, key: keyof ConfigFile): string {
  if (key in file) return "";
  if (target.scope === "repository" && key in target.scopes.global.values) return " · from machine defaults";
  return "";
}

function effectiveConfig(file: ConfigFile, target: SetupTarget) {
  const scope = { ...target.file, values: file };
  const scopes = target.scope === "global"
    ? { global: scope, local: null } : { ...target.scopes, local: scope };
  return resolveConfig(scopes, target.repository?.primaryWorktreeRoot ?? "/");
}

/** Compact live status for one config section in the setup hub. */
export function sectionStatus(key: SetupSection, file: ConfigFile, target: SetupTarget): string {
  const resolved = effectiveConfig(file, target);
  const note = inheritedNote(file, target, key === "pre_delete" ? "hooks" : key);

  switch (key) {
    case "editor": {
      if (file.editor === false) return "off";
      const editor = resolved.editor;
      if (!editor) return `not set${note}`;
      const launch = editor.enabled ? "opens automatically" : "manual";
      const orca = editor.integration === "orca" ? " · Orca terminals" : "";
      return `${safeDisplay(editor.command)} · ${launch}${orca}${note}`;
    }
    case "agent": {
      if (file.agent === false) return "off";
      const agent = resolved.agent;
      if (!agent) return `not set${note}`;
      const launch = agent.enabled ? "starts automatically" : "manual";
      const wait = resolved.editor?.integration === "orca"
        ? `; waits for setup: ${agent.waitForSetup ? "yes" : "no"}` : "";
      return `${safeDisplay(agent.command)} · ${launch}${wait}${note}`;
    }
    case "jira": {
      if (file.jira === false) return "off";
      const jira = file.jira ?? (target.scope === "repository" ? target.scopes.global.values.jira : undefined);
      if (!jira) return `not set${note}`;
      return `${safeDisplay(jira.site_url)}${jira.cloud_id ? " · scoped" : ""}${note}`;
    }
    case "hooks": case "pre_delete": {
      if (file.hooks === false) return "off";
      const hooks = resolved.hooks;
      if (!hooks) return `not set${note}`;
      const count = key === "hooks" ? hooks.postCreate.length : hooks.preDelete?.length ?? 0;
      return `${count} ${key === "hooks" ? "setup" : "pre-done"} script${count === 1 ? "" : "s"}${note}`;
    }
    case "base_branch":
      return `${safeDisplay(resolved.baseBranch ?? "automatic")}${note}`;
    case "remote":
      return `${safeDisplay(resolved.remote ?? "automatic")}${note}`;
    case "worktree_dir": {
      if (file.worktree_dir) return `${safeDisplay(file.worktree_dir)}${note}`;
      if (resolved.worktreeDir) return `${safeDisplay(resolved.worktreeDir)}${note}`;
      return `default sibling directory${note}`;
    }
    default:
      return "-";
  }
}

function hubChoices(file: ConfigFile, target: SetupTarget, github: boolean, linear: boolean): ChoiceOption[] {
  const width = Math.max(...sections.map(section => section.title.length)) + 2;
  return [
    { value: "save", label: "Save and exit" },
    ...sections.map(section => ({
      value: section.value,
      label: `${section.title.padEnd(width)}${sectionStatus(section.value, file, target)}`,
    })),
    ...(github ? [{ value: "github", label: "GitHub issues    Check GitHub CLI login" }] : []),
    ...(linear ? [{ value: "linear", label: "Linear issues    Personal API key" }] : []),
    { value: "guide", label: "Guided walkthrough (editor, assistant, Jira...)" },
    { value: "cancel", label: "Cancel without saving" },
  ];
}

/**
 * Hub-first setup: navigate sections, optional guided walkthrough, then save.
 * Replaces the forced linear questionnaire + separate review loop.
 */
export async function runSetupHub(
  target: SetupTarget,
  prompt: SetupPrompt,
  io: CommandIO,
  available: (command: string) => Promise<boolean>,
  jira?: JiraSetupSession,
  github?: GithubSetupSession,
  linear?: LinearSetupSession,
): Promise<ConfigFile | null> {
  let file: ConfigFile = structuredClone(target.file.values);
  try {
    while (true) {
      jira?.review(io);
      linear?.review(io);
      const scopeLabel = target.scope === "global" ? "machine defaults" : "this repository";
      const workflows = Object.keys(effectiveConfig(file, target).workflows ?? {}).length;
      const choice = await prompt.select(
        `Settings - ${scopeLabel}\n${safeDisplay(target.path)}${workflows ? `\nWorkflows: ${workflows}` : ""}`,
        hubChoices(file, target, github !== undefined, linear !== undefined),
        "save",
      );
      if (choice === null || choice === "cancel") return null;
      if (choice === "linear" && linear) { await linear.edit(prompt, io); continue; }
      if (choice === "github" && github) { await github.edit(prompt, io); continue; }
      if (choice === "save") {
        const parsed = configFileSchema.safeParse(file);
        if (!parsed.success) {
          io.stderr("Setup values are invalid. Correct base_branch, remote, or worktree_dir before saving.\n");
          continue;
        }
        return parsed.data;
      }
      if (choice === "guide") {
        const walked = await questionnaire(
          { ...target, file: { ...target.file, values: file } },
          prompt, io, available, jira, github, linear,
        );
        // Soft cancel (q /cancel) returns to the menu; hard abort (Esc/Ctrl-C) ends setup.
        if (walked === null) {
          if (prompt.signal?.aborted) return null;
          continue;
        }
        file = walked;
        continue;
      }
      const section = sections.find(entry => entry.value === choice);
      if (!section) throw new Error("Invalid setup hub choice; no settings saved.");
      await editSetupSection(section.value, file, target, prompt, io, available, jira);
    }
  } catch (error) {
    if (error instanceof SetupCancelled) return null;
    throw error;
  }
}
