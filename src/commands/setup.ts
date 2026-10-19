import { resolveConfig } from "../config";
import type { ConfigFile } from "../config";
import { safeDisplay } from "../display";
import type { CommandContext, CommandHandlers } from "../services";
import { editSetupSection, questionnaire } from "../setup/questions";
import { renderConfig } from "../setup/render";
import { SetupCancelled, SetupVisibilityError } from "../setup/types";
import type { SetupPrompt, SetupTarget } from "../setup/types";
import type { JiraSetupSession } from "../setup/jira";

export interface SetupServices {
  inspectTarget(global: boolean, cwd: string): Promise<SetupTarget>;
  prompt(): SetupPrompt;
  checkExecutable(command: string): Promise<boolean>;
  save(target: SetupTarget, source: string, trackedApproved: boolean, signal?: AbortSignal): Promise<void>;
  jira?: () => JiraSetupSession;
}

const sections: readonly { value: keyof ConfigFile; label: string }[] = [
  { value: "editor", label: "Edit editor" },
  { value: "agent", label: "Edit coding assistant" },
  { value: "jira", label: "Edit Jira ticket naming" },
  { value: "hooks", label: "Edit creation and pre-deletion scripts" },
  { value: "base_branch", label: "Edit starting branch" },
  { value: "remote", label: "Edit Git remote" },
  { value: "worktree_dir", label: "Edit workspace folder" },
];

function summary(target: SetupTarget, file: ConfigFile, context: CommandContext): void {
  const scope = { ...target.file, values: file };
  const scopes = target.scope === "global" ? { global: scope, local: null } : { ...target.scopes, local: scope };
  const config = resolveConfig(scopes, target.repository?.primaryWorktreeRoot ?? context.cwd);
  context.io.stdout(`\nSummary — ${target.scope === "global" ? "defaults for all repositories on this machine" : "this repository"}\n`);
  context.io.stdout(`Destination: ${safeDisplay(target.path)}\n`);
  const orca = config.editor?.integration === "orca";
  context.io.stdout(`Editor: ${config.editor ? `${safeDisplay(config.editor.command)}${orca ? " (Orca terminals)" : ""}` : "off"}\n`);
  context.io.stdout(`Agent: ${config.agent ? safeDisplay(config.agent.command) : "off"}; launch by default: ${config.agent?.enabled ? "yes" : "no"}`
    + `${orca && config.agent ? `; waits for setup: ${config.agent.waitForSetup ? "yes" : "no"}` : ""}\n`);
  context.io.stdout(`Post-create hooks: ${config.hooks?.postCreate.length ?? 0}; Pre-delete hooks: ${config.hooks?.preDelete?.length ?? 0}; Jira: ${config.jira ? "enabled" : "off"}\n`);
  context.io.stdout(`Workflows: ${Object.keys(config.workflows ?? {}).length}\n`);
  context.io.stdout(`Base: ${safeDisplay(config.baseBranch ?? "automatic")}; remote: ${safeDisplay(config.remote ?? "automatic")}; worktree directory: ${safeDisplay(file.worktree_dir ?? config.worktreeDir ?? "default sibling directory")}\n`);
  context.io.stdout(target.scope === "global"
    ? "Relative worktree directories resolve from each repository's primary checkout.\n"
    : target.tracked ? "This configuration is tracked: ignore rules cannot hide its changes. The index will be preserved.\n"
      : "Configuration is excluded through Git-local info/exclude; shared .gitignore is preserved.\n");
  context.io.stdout("Exclusion is not encryption or protection from forced adds. Keep secrets outside configuration. Edit the destination directly later.\n");
}

export function createSetupHandler(services: SetupServices): CommandHandlers["setup"] {
  return async (options, context) => {
    if (!context.interactive) throw new Error("timber setup requires an interactive terminal with CI disabled. Run timber setup inside a repository, or timber setup --global in an interactive terminal; for unattended use, edit TOML directly.");
    let global = options.global;
    let target = await services.inspectTarget(global, context.cwd);
    const prompt = services.prompt();
    let jira = services.jira?.();
    try {
      while (true) {
        let trackedApproved = false;
        context.io.stdout(`Configure ${target.scope === "global" ? "machine defaults for all repositories" : "this repository"}: ${safeDisplay(target.path)}\n`);
        if (target.tracked) {
          context.io.stdout(".timber.toml is tracked. An ignore rule cannot hide tracked changes; Timber never untracks it.\n");
          const choice = await prompt.select("Tracked configuration", [
            { value: "cancel", label: "Cancel" }, { value: "global", label: "Use machine defaults instead" },
            { value: "edit", label: "Explicitly edit tracked config (index remains unchanged)" },
          ], "cancel");
          if (choice === null || choice === "cancel") throw new SetupCancelled();
          if (choice === "global") { global = true; target = await services.inspectTarget(true, context.cwd); jira = services.jira?.(); continue; }
          if (choice !== "edit") throw new Error("Invalid tracked-config choice; no settings saved.");
          trackedApproved = true;
        }
        const file = await questionnaire(target, prompt, context.io, services.checkExecutable, jira);
        if (file === null) throw new SetupCancelled();
        while (true) {
          summary(target, file, context);
          jira?.review(context.io);
          const choice = await prompt.select("Review settings: save, edit a section, or cancel", [
            { value: "save", label: target.file.source === null ? "Save these settings" : "Save and replace existing configuration" },
            ...sections,
            { value: "cancel", label: "Cancel without saving" },
          ], "cancel");
          if (choice === null || choice === "cancel") throw new SetupCancelled();
          if (choice === "save") break;
          const section = sections.find(section => section.value === choice);
          if (!section) throw new Error("Invalid setup review choice; no settings saved.");
          await editSetupSection(section.value, file, target, prompt, context.io, services.checkExecutable, jira);
        }
        const source = renderConfig(file);
        try {
          const publish = () => services.save(target, source, trackedApproved, prompt.signal);
          if (jira) await jira.save(publish, prompt.signal); else await publish();
        }
        catch (error) {
          if (!(error instanceof SetupVisibilityError)) throw error;
          context.io.stderr(`${error.message}\n`);
          const choice = await prompt.select("Local config would be visible in Git status", [
            { value: "cancel", label: "Cancel" }, { value: "global", label: "Configure machine defaults instead" },
          ], "cancel");
          if (choice === null || choice === "cancel") throw new SetupCancelled();
          if (choice !== "global") throw new Error("Invalid setup scope choice; no settings saved.");
          global = true;
          target = await services.inspectTarget(global, context.cwd);
          jira = services.jira?.();
          continue;
        }
        context.io.stdout(`Saved ${target.scope === "global" ? "machine defaults" : "repository settings"} at ${safeDisplay(target.path)}\n`);
        return;
      }
    } catch (error) {
      if (error instanceof SetupCancelled) { context.io.stdout("Cancelled.\n"); return; }
      throw error;
    } finally { prompt.close(); }
  };
}
