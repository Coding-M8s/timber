import { configFileSchema } from "../config";
import type { ConfigFile } from "../config";
import { safeDisplay } from "../display";
import type { CommandIO } from "../services";
import type { ChoiceOption } from "../selection";
import { SetupCancelled } from "./types";
import type { SetupPrompt, SetupTarget } from "./types";

async function choose(prompt: SetupPrompt, message: string, choices: readonly ChoiceOption[]): Promise<string> {
  const result = await prompt.select(message, choices, choices[0]!.value);
  if (result === null) throw new SetupCancelled();
  if (!choices.some(choice => choice.value === result)) throw new Error("Invalid setup choice; no settings saved.");
  return result;
}

async function text(prompt: SetupPrompt, message: string, current = ""): Promise<string> {
  const result = await prompt.text(message, current);
  if (result === null) throw new SetupCancelled();
  return result;
}

async function confirm(prompt: SetupPrompt, message: string, current = false): Promise<boolean> {
  const result = await prompt.confirm(message, current);
  if (result === null) throw new SetupCancelled();
  return result;
}

const option = (value: string, label: string): ChoiceOption => ({ value, label });

function keepLabel(target: SetupTarget, key: keyof ConfigFile): string {
  if (key in target.file.values) return target.file.values[key] === false ? "Keep disabled" : "Keep current setting";
  return key in target.scopes.global.values && target.scope === "repository"
    ? "Use your machine settings" : "Skip for now";
}

async function launcher(
  key: "editor" | "agent", file: ConfigFile, target: SetupTarget, prompt: SetupPrompt,
  io: CommandIO, available: (command: string) => Promise<boolean>,
): Promise<void> {
  const presets = key === "editor"
    ? { code: { command: "code", args: ["--new-window"] }, zed: { command: "zed", args: ["--new"] } }
    : { claude: { command: "claude", args: [] }, codex: { command: "codex", args: [] } };
  const choices = [option("keep", keepLabel(target, key)), ...Object.keys(presets).map(name =>
    option(name, ({ code: "VS Code", zed: "Zed", claude: "Claude", codex: "Codex" } as Record<string, string>)[name]!)),
    option("custom", key === "editor" ? "Another editor" : "Another coding assistant"),
    ...(key in target.file.values ? [option("inherit", target.scope === "repository" ? "Use machine defaults" : "Reset (leave blank)")] : []),
    option("none", key === "editor" ? "Do not open an editor" : "Do not start a coding assistant")];
  const diagnoseEffective = async () => {
    const current = file[key] ?? (target.scope === "repository" ? target.scopes.global.values[key] : undefined);
    if (current && !await available(current.command)) io.stderr(`Configured ${key} executable is unavailable; install it or fix PATH before launching.\n`);
  };

  while (true) {
    const selected = await choose(prompt, key === "editor"
      ? "Which editor should open your workspace?\nSkip to open it yourself later."
      : "Use an AI coding assistant?\nChoose one you already have installed, or skip. It runs in this terminal.", choices);
    if (selected === "keep") {
      await diagnoseEffective();
      return;
    }
    if (selected === "inherit") { delete file[key]; await diagnoseEffective(); return; }
    if (selected === "none") { file[key] = false; return; }
    let command: { command: string; args: string[] };
    if (selected === "custom") {
      const executable = await text(prompt, `${key === "editor" ? "Editor" : "Assistant"} program name or full path`);
      const argsSource = await text(prompt, 'Extra arguments (Enter for none), as JSON, e.g. ["--flag"]', "[]");
      let args: unknown;
      try { args = JSON.parse(argsSource); } catch { args = null; }
      if (!Array.isArray(args) || !args.every(value => typeof value === "string") || !executable.trim()) {
        io.stderr("Enter a nonempty executable and a JSON array containing only strings.\n");
        continue;
      }
      command = { command: executable, args };
    } else {
      command = (presets as Record<string, { command: string; args: string[] }>)[selected]!;
    }
    if (!await available(command.command)) {
      io.stderr(`Selected ${key} executable is unavailable. Install it or fix PATH, then reselect it, choose none, or cancel.\n`);
      const recovery = await choose(prompt, "Executable unavailable", [option("retry", "Reselect"), option("none", "None / off"), option("cancel", "Cancel setup")]);
      if (recovery === "cancel") throw new SetupCancelled();
      if (recovery === "none") { file[key] = false; return; }
      continue;
    }
    if (key === "editor") file.editor = command;
    else file.agent = { ...command, enabled: await confirm(prompt, "Start this assistant automatically when opening a workspace?", false) };
    return;
  }
}

async function scalar(key: "base_branch" | "remote" | "worktree_dir", values: readonly string[], file: ConfigFile,
  target: SetupTarget, prompt: SetupPrompt, io: CommandIO): Promise<void> {
  const selected = await choose(prompt, ({ base_branch: "Which branch should new work start from?\nUsually main or master. Skip to let Git choose automatically.",
    remote: "Which Git remote should Timber use?\nA remote is where your repository is hosted, usually origin. Skip for automatic selection.",
    worktree_dir: "Where should new workspaces be stored?\nSkip to put them beside this repository, in <repository-name>-worktrees." })[key], [option("keep", keepLabel(target, key)),
    option("automatic", "Use automatic settings (leave blank)"),
    ...values.map((value, index) => option(`value:${index}`, safeDisplay(value))), option("custom", "Custom value")]);
  if (selected === "keep") return;
  if (selected === "automatic") { delete file[key]; return; }
  if (selected !== "custom") { file[key] = values[Number(selected.slice(6))]!; return; }
  const label = ({ base_branch: "Branch name", remote: "Remote name", worktree_dir: "Workspace folder" })[key];
  while (true) {
    const result = configFileSchema.shape[key].safeParse(await text(prompt, label, file[key] ?? ""));
    if (result.success && result.data !== undefined) { file[key] = result.data; return; }
    io.stderr(`Enter a nonempty ${label.toLowerCase()}.\n`);
  }
}

async function jiraSettings(file: ConfigFile, target: SetupTarget, prompt: SetupPrompt, io: CommandIO): Promise<void> {
  const jira = await choose(prompt,
    "Use Jira tickets to name branches?\nJira is a work ticket tracker. This lets timber new TEAM-123 use the ticket title. Skip if you don't use Jira.",
    [option("keep", keepLabel(target, "jira")), option("configure", "Yes, connect my team's Jira"),
      ...("jira" in target.file.values ? [option("inherit", target.scope === "repository" ? "Use machine defaults" : "Reset (leave blank)")] : []),
      option("none", "Do not use Jira")]);
  if (jira === "inherit") delete file.jira;
  if (jira === "none") file.jira = false;
  if (jira === "configure") {
    io.stdout("\nUse JIRA_EMAIL and JIRA_API_TOKEN environment variables for login. Setup never asks for your password or token.\n");
    while (true) {
      const site_url = await text(prompt, "Your team's Jira address, e.g. https://my-team.atlassian.net");
      const scoped = await confirm(prompt, "Does your Jira API token use scopes? Most users can press Enter to skip.");
      const cloud_id = scoped ? await text(prompt, "Jira cloud ID (UUID for your scoped token)") : "";
      const input = { jira: { site_url, ...(cloud_id ? { cloud_id } : {}) } };
      const result = configFileSchema.safeParse(input);
      if (result.success) { file.jira = result.data.jira; break; }
      io.stderr("Enter an HTTPS Jira address ending in .atlassian.net and, if needed, a valid cloud UUID.\n");
    }
  }
}

async function hookSettings(file: ConfigFile, target: SetupTarget, prompt: SetupPrompt, io: CommandIO): Promise<void> {
  const hooks = await choose(prompt,
    "Run scripts when a workspace is first created?\nFor example, install project dependencies. These are trusted shell commands run with your permissions.",
    [option("keep", keepLabel(target, "hooks")), option("custom", "Add setup scripts"),
      ...("hooks" in target.file.values ? [option("inherit", target.scope === "repository" ? "Use machine defaults" : "Reset (leave blank)")] : []),
      option("none", "Do not run scripts")]);
  if (hooks === "inherit") delete file.hooks;
  if (hooks === "none") file.hooks = false;
  if (hooks === "custom") {
    const commands: string[] = [];
    while (true) {
      const source = await text(prompt, "Setup command, e.g. bun install");
      if (!source.trim() || source.includes("\0")) { io.stderr("Enter a nonempty command without NUL characters.\n"); continue; }
      commands.push(source);
      if (await choose(prompt, "Add another setup command?", [option("finish", "Done"), option("add", "Add another command")]) === "finish") break;
    }
    file.hooks = { post_create: commands };
  }
}

/** Edit only one section, using current draft values for keep/reset choices. */
export async function editSetupSection(section: keyof ConfigFile, file: ConfigFile, target: SetupTarget,
  prompt: SetupPrompt, io: CommandIO, available: (command: string) => Promise<boolean>): Promise<void> {
  const current = { ...target, file: { ...target.file, values: file } };
  switch (section) {
    case "editor": case "agent": await launcher(section, file, current, prompt, io, available); break;
    case "jira": await jiraSettings(file, current, prompt, io); break;
    case "hooks": await hookSettings(file, current, prompt, io); break;
    case "base_branch": await scalar(section, target.branches, file, current, prompt, io); break;
    case "remote": await scalar(section, target.repository?.remotes.map(remote => remote.name) ?? [], file, current, prompt, io); break;
    case "worktree_dir": await scalar(section, [], file, current, prompt, io); break;
  }
}

export async function questionnaire(target: SetupTarget, prompt: SetupPrompt, io: CommandIO,
  available: (command: string) => Promise<boolean>): Promise<ConfigFile | null> {
  const file: ConfigFile = structuredClone(target.file.values);
  try {
    for (const section of ["editor", "agent", "jira"] as const) {
      await editSetupSection(section, file, target, prompt, io, available);
    }
    if (await confirm(prompt, "Advanced settings: add workspace setup scripts or change Git/folder defaults? Skip if you're unsure.")) {
      for (const section of ["hooks", "base_branch", "remote", "worktree_dir"] as const) {
        await editSetupSection(section, file, target, prompt, io, available);
      }
    }
    const parsed = configFileSchema.safeParse(file);
    if (!parsed.success) throw new Error("Setup values are invalid. Correct base_branch, remote, or worktree_dir and rerun setup; no settings saved.");
    return parsed.data;
  } catch (error) {
    if (error instanceof SetupCancelled) return null;
    throw error;
  }
}
