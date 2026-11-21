import type { LinearSetupSession } from "./linear";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { configFileSchema, jiraSiteSchema } from "../config";
import type { ConfigFile } from "../config";
import { safeDisplay } from "../display";
import type { CommandIO } from "../services";
import type { ChoiceOption } from "../selection";
import { SetupCancelled } from "./types";
import type { SetupPrompt, SetupTarget } from "./types";
import type { JiraSetupSession } from "./jira";
import type { GithubSetupSession } from "./github";
import { editDefaultTracker } from "./trackers";
import { editBackupSetting } from "./backups";

async function choose(prompt: SetupPrompt, message: string, choices: readonly ChoiceOption[], defaultValue = choices[0]!.value): Promise<string> {
  const result = await prompt.select(message, choices, defaultValue);
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

function effectiveSetting<K extends keyof ConfigFile>(key: K, file: ConfigFile, target: SetupTarget): ConfigFile[K] {
  return file[key] ?? (target.scope === "repository" ? target.scopes.global.values[key] : undefined);
}

function integrationChoices(key: "editor" | "agent" | "jira", file: ConfigFile, target: SetupTarget,
  configure: ChoiceOption[]): ChoiceOption[] {
  const current = effectiveSetting(key, file, target);
  const inherited = target.scope === "repository" ? target.scopes.global.values[key] : undefined;
  const none = option("none", "None");
  return [
    current ? option("keep", key in file ? "Keep current setting" : "Use machine defaults") : none,
    ...configure,
    ...(key in file && inherited && !isDeepStrictEqual(current, inherited)
      ? [option("inherit", "Use machine defaults")] : []),
    ...(current ? [none] : []),
  ];
}

function disableIntegration(key: "editor" | "agent" | "jira", file: ConfigFile, target: SetupTarget): void {
  if (file[key] === false) return;
  if (target.scope === "repository" && target.scopes.global.values[key]) file[key] = false;
  else delete file[key];
}

type LauncherPreset = { command: string; args: string[]; integration?: "orca" | "vscode" };

/** The editor that applies after this file: a file table wins, a repository inherits machine defaults. */
function effectiveEditor(file: ConfigFile, target: SetupTarget) {
  const editor = file.editor ?? (target.scope === "repository" ? target.scopes.global.values.editor : undefined);
  return editor || undefined;
}

const waitQuestion = "Wait for setup scripts to finish before starting the assistant? Choose no to start it alongside setup.";

async function launcher(
  key: "editor" | "agent", file: ConfigFile, target: SetupTarget, prompt: SetupPrompt,
  io: CommandIO, available: (command: string) => Promise<boolean>,
): Promise<void> {
  const presets: Record<string, LauncherPreset> = key === "editor"
    ? { code: { command: "code", args: ["--new-window"] }, zed: { command: "zed", args: ["--new"] },
      orca: { command: "orca-ide", args: [], integration: "orca" },
      vscodeTerminals: { command: "code", args: ["--new-window"], integration: "vscode" } }
    : { claude: { command: "claude", args: [] }, codex: { command: "codex", args: [] } };
  const labels: Record<string, string> = {
    code: "VS Code (opens the window; setup and assistant stay in this terminal)",
    zed: "Zed (opens the window; setup and assistant stay in this terminal)",
    orca: "Orca terminals (setup and assistant in the Orca window)",
    vscodeTerminals: "VS Code terminals (setup and assistant in VS Code; needs the Timber extension)",
    claude: "Claude", codex: "Codex",
  };
  const orca = key === "agent" && effectiveEditor(file, target)?.integration !== undefined;
  const choices = integrationChoices(key, file, target, [
    ...Object.keys(presets).map(name => option(name, labels[name]!)),
    option("custom", key === "editor" ? "Another editor" : "Another coding assistant"),
  ]);
  const diagnoseEffective = async () => {
    const current = file[key] ?? (target.scope === "repository" ? target.scopes.global.values[key] : undefined);
    if (current && !await available(current.command)) io.stderr(`Configured ${key} executable is unavailable; install it or fix PATH before launching.\n`);
  };
  const configureDependency = async () => {
    if (!orca) return;
    const agent = file.agent ?? (target.scope === "repository" ? target.scopes.global.values.agent : undefined);
    if (!agent) return;
    const inheritedWait = agent.wait_for_setup ?? false;
    const wait = await confirm(prompt, waitQuestion, inheritedWait);
    // An unchanged inherited preference stays inherited. A changed preference
    // replaces the whole table, keeping its executable/arguments and enablement together.
    if (file.agent || wait !== inheritedWait) file.agent = { ...agent, args: [...agent.args], wait_for_setup: wait };
  };

  while (true) {
    const selected = await choose(prompt, key === "editor"
      ? "Which editor should open your workspace?\nChoose None to open it yourself later."
      : "Use an AI coding assistant?\nChoose one you already have installed, or None. It runs in this terminal, or in Orca or VS Code when that integration is enabled.", choices);
    if (selected === "keep") {
      await configureDependency();
      await diagnoseEffective();
      return;
    }
    if (selected === "inherit") { delete file[key]; await configureDependency(); await diagnoseEffective(); return; }
    if (selected === "none") { disableIntegration(key, file, target); return; }
    let command: LauncherPreset;
    if (selected === "custom") {
      const executable = await text(prompt, `${key === "editor" ? "Editor" : "Assistant"} program name or full path`);
      const argsSource = await text(prompt, 'Extra arguments (Enter for none), as JSON, e.g. ["--flag"]', "[]");
      let args: unknown;
      try { args = JSON.parse(argsSource); } catch { args = null; }
      if (!Array.isArray(args) || !args.every(value => typeof value === "string") || !executable.trim()) {
        io.stderr("Enter a nonempty executable and a JSON array containing only strings.\n");
        continue;
      }
      if ((executable.includes("/") || (process.platform === "win32" && executable.includes("\\"))) && !isAbsolute(executable)) {
        io.stderr("Use a program name on PATH or an absolute path. Relative executable paths change meaning in another workspace.\n");
        continue;
      }
      command = { command: executable, args };
    } else {
      command = presets[selected]!;
    }
    if (!await available(command.command)) {
      if (process.platform === "win32") io.stderr("Use a native .exe on Windows. Command scripts require an explicit powershell.exe -File wrapper; cmd/bat shims cannot be launched directly.\n");
      io.stderr(`Selected ${key} executable is unavailable. Install it or fix PATH, then reselect it, choose none, or cancel.\n`);
      const recovery = await choose(prompt, "Executable unavailable", [option("retry", "Reselect"), option("none", "None / off"), option("cancel", "Cancel setup")]);
      if (recovery === "cancel") throw new SetupCancelled();
      if (recovery === "none") { disableIntegration(key, file, target); return; }
      continue;
    }
    if (key === "editor") {
      file.editor = { ...command, enabled: await confirm(prompt, command.integration !== undefined
        ? `Run setup scripts and the assistant in ${command.integration === "orca" ? "Orca" : "VS Code"} terminals automatically when opening a workspace?`
        : "Open this editor automatically when opening a workspace?", false) };
      if (command.integration === "vscode") {
        io.stdout("VS Code terminals need the Timber Terminals extension; see docs/editor-terminals.md#vs-code to install it. "
          + "Trust the folder that holds your worktrees once in VS Code (Manage in the Restricted Mode banner, then Add Folder), "
          + "or each new worktree window opens in Restricted Mode and Timber stops before starting terminals.\n");
      }
      return;
    }
    const previous = file.agent ?? (target.scope === "repository" ? target.scopes.global.values.agent : undefined);
    const kept = previous ? previous.wait_for_setup : undefined;
    const enabled = await confirm(prompt, "Start this assistant automatically when opening a workspace?", false);
    const wait_for_setup = orca ? await confirm(prompt, waitQuestion, kept ?? false) : kept;
    // Selecting a command, even the same preset, drops any --resolve handoff: its argument grammar may differ.
    file.agent = { ...command, enabled, ...(wait_for_setup === undefined ? {} : { wait_for_setup }) };
    return;
  }
}

/**
 * Optional `timber rebase --resolve` handoff for an [agent] table in this file.
 * The tool is never guessed from the executable; skipping leaves --resolve refusing.
 */
async function configureResolve(file: ConfigFile, target: SetupTarget, prompt: SetupPrompt, io: CommandIO): Promise<void> {
  const agent = file.agent;
  if (!agent) {
    io.stderr(file.agent === undefined && target.scope === "repository" && target.scopes.global.values.agent
      ? "The coding assistant comes from machine defaults. Set its --resolve handoff with timber setup --global.\n"
      : "Configure a coding assistant first; --resolve uses it.\n");
    return;
  }
  const current = agent.resolve_handoff;
  const handoffs = [
    option("codex", "Codex: task given as its first prompt"),
    option("claude", "Claude: task given as its first prompt"),
    option("cursor", "Cursor: task given as its first prompt"),
    option("wrapper", "Custom wrapper that reads the TIMBER_TASK_FILE environment variable"),
  ];
  const selected = await choose(prompt,
    "Use this assistant for timber rebase --resolve?\nChoose how Timber hands it the conflict task. It only runs when you pass --resolve.",
    [...(current ? [option("keep", `Keep current (${current})`)] : []), ...handoffs, option("none", "Do not use it for --resolve")]);
  const { resolve_handoff: _handoff, resolve_instructions: previous, ...rest } = agent;
  if (selected === "none") { file.agent = rest; return; }
  const handoff = selected === "keep" ? current! : selected as NonNullable<typeof current>;
  if (previous !== undefined) {
    const kept = await choose(prompt, "Extra instructions for --resolve are set.", [
      option("keep", "Keep them"), option("edit", "Replace them"), option("remove", "Remove them"),
    ]);
    if (kept !== "edit") {
      file.agent = { ...rest, resolve_handoff: handoff, ...(kept === "keep" ? { resolve_instructions: previous } : {}) };
      return;
    }
  }
  while (true) {
    const extra = (await text(prompt, "Extra instructions for the assistant during --resolve (Enter for none)")).trim();
    if (extra.length > 4000 || extra.includes("\0")) { io.stderr("Use at most 4000 characters of plain text.\n"); continue; }
    file.agent = { ...rest, resolve_handoff: handoff, ...(extra ? { resolve_instructions: extra } : {}) };
    return;
  }
}

async function scalar(key: "base_branch" | "remote" | "worktree_dir", values: readonly string[], file: ConfigFile,
  target: SetupTarget, prompt: SetupPrompt, io: CommandIO): Promise<void> {
  const inherits = target.scope === "repository" && key in target.scopes.global.values;
  const question = ({ base_branch: "Which branch should new work start from?\nUsually main or master.",
    remote: "Which Git remote should Timber use?\nA remote is where your repository is hosted, usually origin.",
    worktree_dir: "Where should new workspaces be stored?" })[key];
  const resetHelp = inherits ? 'Choose "Use machine defaults" to inherit this setting.' : ({
    base_branch: 'Choose "Use automatic settings" to let Git choose the branch.',
    remote: 'Choose "Use automatic settings" for automatic remote selection.',
    worktree_dir: 'Choose "Use automatic settings" to put workspaces beside this repository, in <repository-name>-worktrees.',
  })[key];
  const current = effectiveSetting(key, file, target);
  const keep = key in file;
  const automatic = !keep || current !== (inherits ? target.scopes.global.values[key] : undefined);
  const selected = await choose(prompt, `${question}${automatic ? `\n${resetHelp}` : ""}`, [
    ...(keep ? [option("keep", `Keep ${safeDisplay(current!)}`)] : []),
    ...(automatic ? [option("automatic", inherits ? "Use machine defaults" : "Use automatic settings (leave blank)")] : []),
    ...values.flatMap((value, index) => value === current ? [] : [option(`value:${index}`, safeDisplay(value))]),
    option("custom", "Custom value")]);
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

export async function editJiraSettings(file: ConfigFile, target: SetupTarget, prompt: SetupPrompt, io: CommandIO,
  session?: JiraSetupSession, configure = false): Promise<void> {
  const jira = configure ? "configure" : await choose(prompt,
    "Use Jira tickets to name branches?\nJira is a work ticket tracker. This lets timber new TEAM-123 use the ticket title. Choose None if you don't use Jira.",
    integrationChoices("jira", file, target, [option("configure", "Connect my team's Jira")]));
  if (jira === "inherit") delete file.jira;
  if (jira === "none") {
    const wasConfigured = effectiveSetting("jira", file, target);
    disableIntegration("jira", file, target);
    if (wasConfigured) io.stdout("Jira disabled here. Shared personal credentials are retained for other repositories.\n");
  }
  if (jira === "configure") {
    while (true) {
      const current = file.jira || (target.scope === "repository" ? target.scopes.global.values.jira : undefined);
      const site = jiraSiteSchema.safeParse(await text(prompt, "Your team's Jira address, e.g. https://my-team.atlassian.net", current ? current.site_url : ""));
      if (!site.success) { io.stderr("Invalid Jira URL.\nUse https://your-team.atlassian.net (site address only).\n"); continue; }
      const site_url = site.data;
      const scoped = await confirm(prompt, "Does your Jira API token use scopes? Choose yes only for a scoped token.", !!current && current.cloud_id !== undefined);
      if (scoped) io.stdout("Find your cloud ID: https://<your-site>.atlassian.net/_edge/tenant_info\nScoped tokens use api.atlassian.com/ex/jira/<cloud-id>.\n");
      const cloud_id = scoped ? await text(prompt, "Jira cloud ID (UUID for your scoped token)", current ? current.cloud_id ?? "" : "") : "";
      if (scoped && !cloud_id) { io.stderr("A scoped token requires a cloud UUID. Enter it or choose unscoped token mode.\n"); continue; }
      const input = { jira: { site_url, ...(cloud_id ? { cloud_id } : {}) } };
      const result = configFileSchema.safeParse(input);
      // Keep issue list settings (board, sprint_jql, project) that setup does not ask about.
      if (result.success && result.data.jira) {
        const { board, sprint_jql, project } = file.jira || {};
        file.jira = { ...result.data.jira, ...(board === undefined ? {} : { board }),
          ...(sprint_jql === undefined ? {} : { sprint_jql }), ...(project === undefined ? {} : { project }) };
        break;
      }
      io.stderr("Enter an HTTPS Jira address ending in .atlassian.net and, if needed, a valid cloud UUID.\n");
    }
  }
  const effective = file.jira ?? (target.scope === "repository" ? target.scopes.global.values.jira : undefined);
  if (effective && session) await session.edit({ siteUrl: effective.site_url,
    ...(effective.cloud_id ? { cloudId: effective.cloud_id } : {}) }, prompt, io);
}

function copyHookLists(hooks: { post_create: readonly string[]; pre_delete?: readonly string[] | undefined }) {
  return {
    post_create: [...hooks.post_create],
    ...(hooks.pre_delete === undefined ? {} : { pre_delete: [...hooks.pre_delete] }),
  };
}

async function hookSettings(stage: "post_create" | "pre_delete", file: ConfigFile, target: SetupTarget,
  prompt: SetupPrompt, io: CommandIO): Promise<void> {
  const preDone = stage === "pre_delete";
  const label = preDone ? "pre-done" : "setup";
  const effective = file.hooks ?? (target.scope === "repository" ? target.scopes.global.values.hooks : undefined);
  const existing = effective ? effective[stage] ?? [] : [];
  const hooks = await choose(prompt,
    (preDone ? "Run pre-done scripts before removing a workspace?\nThese run after cleanup safety checks; failure stops removal."
      : "Run scripts when a workspace is first created?\nFor example, install project dependencies.")
      + "\nThese are trusted shell commands run with your permissions. Editing keeps the other script list.",
    [option("none", "None"), option("custom", `${existing.length ? "Edit" : "Add"} ${label} scripts`)],
    existing.length ? "custom" : "none");
  if (hooks === "none") {
    if (!existing.length) return;
    const other = effective && (preDone ? effective.post_create.length : effective.pre_delete?.length);
    file.hooks = effective && other ? { ...copyHookLists(effective), [stage]: [] } : false;
  }
  if (hooks === "custom") {
    const commands: string[] = [];
    while (true) {
      const source = await text(prompt, preDone ? "Pre-done command, e.g. bun run cleanup" : "Setup command, e.g. bun install",
        existing[commands.length] ?? "");
      if (!source.trim() || source.includes("\0")) { io.stderr("Enter a nonempty command without NUL characters.\n"); continue; }
      commands.push(source);
      const moreExisting = commands.length < existing.length;
      if (await choose(prompt, moreExisting ? `Continue editing ${label} commands?` : `Add another ${label} command?`, [
        option("finish", moreExisting ? "Done (remove remaining commands)" : "Done"),
        option("add", moreExisting ? "Edit next command" : "Add another command"),
      ], moreExisting ? "add" : "finish") === "finish") break;
    }
    if (!isDeepStrictEqual(commands, existing)) {
      file.hooks = { ...copyHookLists(effective || { post_create: [] }), [stage]: commands };
    }
  }
}

/** Edit only one section, using current draft values for keep/reset choices. */
export type SetupSection = keyof ConfigFile | "pre_delete" | "rebase_resolve";

export async function editSetupSection(section: SetupSection, file: ConfigFile, target: SetupTarget,
  prompt: SetupPrompt, io: CommandIO, available: (command: string) => Promise<boolean>, jira?: JiraSetupSession): Promise<void> {
  const current = { ...target, file: { ...target.file, values: file } };
  switch (section) {
    case "editor": case "agent": await launcher(section, file, current, prompt, io, available); break;
    case "jira": await editJiraSettings(file, current, prompt, io, jira); break;
    case "hooks": await hookSettings("post_create", file, current, prompt, io); break;
    case "pre_delete": await hookSettings("pre_delete", file, current, prompt, io); break;
    case "base_branch": await scalar(section, target.branches, file, current, prompt, io); break;
    case "remote": await scalar(section, target.repository?.remotes.map(remote => remote.name) ?? [], file, current, prompt, io); break;
    case "worktree_dir": await scalar(section, [], file, current, prompt, io); break;
    case "backup_retention_days": case "backup_storage_warning": await editBackupSetting(section, file, current, prompt, io); break;
    case "rebase_resolve": await configureResolve(file, current, prompt, io); break;
  }
}

export async function questionnaire(target: SetupTarget, prompt: SetupPrompt, io: CommandIO,
  available: (command: string) => Promise<boolean>, jira?: JiraSetupSession, github?: GithubSetupSession, linear?: LinearSetupSession): Promise<ConfigFile | null> {
  const file: ConfigFile = structuredClone(target.file.values);
  try {
    for (const section of ["editor", "agent"] as const) {
      await editSetupSection(section, file, target, prompt, io, available, jira);
    }
    await editDefaultTracker(file, target, prompt, io, { github, linear,
      editJira: configure => editJiraSettings(file, target, prompt, io, jira, configure) });
    if (await confirm(prompt, "Advanced settings: add setup/pre-done scripts or change Git/folder defaults? Skip if you're unsure.")) {
      for (const section of ["hooks", "pre_delete", "base_branch", "remote", "worktree_dir"] as const) {
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
