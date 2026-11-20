import type { ConfigFile } from "../config";
import type { CommandIO } from "../services";
import type { ChoiceOption } from "../selection";
import type { GithubSetupSession } from "./github";
import type { LinearSetupSession } from "./linear";
import type { BitbucketSetupSession } from "./bitbucket";
import { SetupCancelled } from "./types";
import type { SetupPrompt, SetupTarget } from "./types";

export const trackerNames = { github: "GitHub", linear: "Linear", jira: "Jira", none: "None" } as const;
export interface TrackerConnections {
  editJira?: (configure: boolean) => Promise<void>;
  github?: GithubSetupSession | undefined;
  linear?: LinearSetupSession | undefined;
  /** The Bitbucket pull request login; not an issue tracker, so never a default. */
  bitbucket?: BitbucketSetupSession | undefined;
}

async function select(prompt: SetupPrompt, message: string, choices: ChoiceOption[], current: string): Promise<string> {
  const answer = await prompt.select(message, choices, current);
  if (answer === null) throw new SetupCancelled();
  if (!choices.some(choice => choice.value === answer)) throw new Error("Invalid tracker choice; no settings saved.");
  return answer;
}

export async function editDefaultTracker(file: ConfigFile, target: SetupTarget, prompt: SetupPrompt,
  io: CommandIO, connections: TrackerConnections): Promise<void> {
  const global = target.scope === "repository" ? target.scopes.global.values.default_tracker : undefined;
  const choices: ChoiceOption[] = Object.entries(trackerNames).map(([value, label]) => ({ value, label }));
  choices.push({ value: "inherit", label: target.scope === "repository"
    ? `Inherit machine default (${global ? trackerNames[global] : "literal branch names"})`
    : "No default (literal branch names)" });
  const choice = await select(prompt, "Which issue tracker do you use?", choices, file.default_tracker ?? "inherit");
  if (choice === "inherit") { delete file.default_tracker; return; }
  const provider = choice as keyof typeof trackerNames;
  file.default_tracker = provider;
  if (provider === "jira") await connections.editJira?.(true);
  if (provider === "github") await connections.github?.edit(prompt, io);
  if (provider === "linear") await connections.linear?.edit(prompt, io);
}

export async function editTrackerConnections(prompt: SetupPrompt,
  io: CommandIO, connections: TrackerConnections): Promise<void> {
  const choices: ChoiceOption[] = [
    { value: "jira", label: "Jira site and personal credentials" },
    ...(connections.github ? [{ value: "github", label: "GitHub CLI login" }] : []),
    ...(connections.linear ? [{ value: "linear", label: "Linear personal API key" }] : []),
    ...(connections.bitbucket ? [{ value: "bitbucket", label: "Bitbucket pull request login" }] : []),
    { value: "back", label: "Back to settings" },
  ];
  while (true) {
    const choice = await select(prompt, "Connections (does not change your default issue tracker)", choices, "back");
    if (choice === "back") return;
    if (choice === "jira") await connections.editJira?.(false);
    if (choice === "github") await connections.github?.edit(prompt, io);
    if (choice === "linear") await connections.linear?.edit(prompt, io);
    if (choice === "bitbucket") await connections.bitbucket?.edit(prompt, io);
  }
}
