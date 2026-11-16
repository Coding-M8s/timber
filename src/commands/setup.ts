import type { LinearSetupSession } from "../setup/linear";
import { safeDisplay } from "../display";
import type { CommandHandlers } from "../services";
import { runSetupHub } from "../setup/hub";
import { renderConfig } from "../setup/render";
import { SetupCancelled, SetupVisibilityError } from "../setup/types";
import type { SetupPrompt, SetupTarget } from "../setup/types";
import type { JiraSetupSession } from "../setup/jira";
import type { GithubSetupSession } from "../setup/github";
import type { BitbucketSetupSession } from "../setup/bitbucket";

export interface SetupServices {
  /** Sessions receive the repository whose credential selection setup may change, or null. */
  linear?: (commonGitDir: string | null) => LinearSetupSession;
  github?: () => GithubSetupSession;
  bitbucket?: () => BitbucketSetupSession;
  inspectTarget(global: boolean, cwd: string): Promise<SetupTarget>;
  prompt(): SetupPrompt;
  checkExecutable(command: string): Promise<boolean>;
  save(target: SetupTarget, source: string, trackedApproved: boolean, signal?: AbortSignal): Promise<void>;
  jira?: (commonGitDir: string | null) => JiraSetupSession;
}

/** Only repository setup changes a repository's credential selection. */
function credentialRepository(target: SetupTarget): string | null {
  return target.scope === "repository" ? target.repository?.commonGitDir ?? null : null;
}

export function createSetupHandler(services: SetupServices): CommandHandlers["setup"] {
  return async (options, context) => {
    if (!context.interactive) throw new Error("timber setup requires an interactive terminal with CI disabled. Run timber setup inside a repository, or timber setup --global in an interactive terminal; for unattended use, edit TOML directly.");
    let global = options.global;
    let target = await services.inspectTarget(global, context.cwd);
    const prompt = services.prompt();
    const setupContext = prompt.notice ? { ...context, io: {
      stdout: (message: string) => prompt.notice!(message),
      stderr: (message: string) => prompt.notice!(message, "error"),
    } } : context;
    let jira = services.jira?.(credentialRepository(target));
    let linear = services.linear?.(credentialRepository(target));
    let bitbucket = services.bitbucket?.();
    const github = services.github?.();
    let closed = false;
    const done = (message: string) => {
      if (!closed) { prompt.close(); closed = true; }
      context.io.stdout(message);
    };
    try {
      while (true) {
        let trackedApproved = false;
        if (target.tracked) {
          const choice = await prompt.select("Tracked configuration\nEdits change a tracked file; the index stays unchanged.", [
            { value: "cancel", label: "Cancel" }, { value: "global", label: "Use machine defaults instead" },
            { value: "edit", label: "Explicitly edit tracked config (index remains unchanged)" },
          ], "cancel");
          if (choice === null || choice === "cancel") throw new SetupCancelled();
          if (choice === "global") { global = true; target = await services.inspectTarget(true, context.cwd); jira = services.jira?.(credentialRepository(target)); linear = services.linear?.(credentialRepository(target)); bitbucket = services.bitbucket?.(); continue; }
          if (choice !== "edit") throw new Error("Invalid tracked-config choice; no settings saved.");
          trackedApproved = true;
        }
        const file = await runSetupHub(target, prompt, setupContext.io, services.checkExecutable, jira, github, linear, bitbucket);
        if (file === null) throw new SetupCancelled();
        const source = renderConfig(file);
        try {
          const publish = () => services.save(target, source, trackedApproved, prompt.signal);
          const publishBitbucket = () => bitbucket ? bitbucket.save(publish, prompt.signal) : publish();
          const publishCredentials = () => linear ? linear.save(publishBitbucket, prompt.signal) : publishBitbucket();
          if (jira) await jira.save(publishCredentials, prompt.signal); else await publishCredentials();
        }
        catch (error) {
          if (!(error instanceof SetupVisibilityError)) throw error;
          setupContext.io.stderr(`${error.message}\n`);
          const choice = await prompt.select("Local config would be visible in Git status", [
            { value: "cancel", label: "Cancel" }, { value: "global", label: "Configure machine defaults instead" },
          ], "cancel");
          if (choice === null || choice === "cancel") throw new SetupCancelled();
          if (choice !== "global") throw new Error("Invalid setup scope choice; no settings saved.");
          global = true;
          target = await services.inspectTarget(global, context.cwd);
          jira = services.jira?.(credentialRepository(target));
          linear = services.linear?.(credentialRepository(target));
          bitbucket = services.bitbucket?.();
          continue;
        }
        done(`Saved ${target.scope === "global" ? "machine defaults" : "repository settings"} at ${safeDisplay(target.path)}\n`);
        return;
      }
    } catch (error) {
      if (error instanceof SetupCancelled) { done("Cancelled.\n"); return; }
      throw error;
    } finally { if (!closed) prompt.close(); }
  };
}
