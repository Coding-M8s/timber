import { runAppConfig } from "./commands/app-config";
import { runNativeCleanup } from "./machine-done";
import { runMachineCommand } from "./machine";
import { parseArenaGroups } from "./arena/participants";
import type { ArenaGroupToken } from "./arena/types";
import type { ArenaNewOptions, ArenaResumeOptions, ArenaPickOptions } from "./arena/types";
import { Command, CommanderError } from "commander";
import { version } from "../package.json";
import { FormattedError, safeDiagnostic } from "./display";
import type { CommandContext, CommandHandlers, NewOptions, OpenOptions } from "./services";
import type { CleanupOptions } from "./types";
import { formatBashCandidate, parseBashCompletion } from "./completion/bash";
import { completionCandidates } from "./completion/candidates";
import { completionScript } from "./completion/shells";

function requireSuppressedLaunches(options: { editor?: boolean; agent?: boolean }): void {
  if (options.editor !== false || options.agent !== false) {
    throw new Error("--result-file requires explicit --no-editor and --no-agent. Setup hooks still run.");
  }
}

const placeholder = (name: string, ticket: string) => async (): Promise<void> => {
  throw new Error(`timber ${name} is not implemented yet (${ticket}). See timber ${name} --help.`);
};

export const placeholderHandlers: CommandHandlers = {
  setup: placeholder("setup", "TIM-18"),
  new: placeholder("new", "TIM-12"),
  open: placeholder("open", "TIM-13"),
  list: placeholder("ls", "TIM-14"),
  done: placeholder("done", "TIM-15"),
};

export interface CliDependencies {
  context: CommandContext;
  handlers?: CommandHandlers;
}

/** Build one source of truth for dispatch, help and completion metadata. */
export function createCli(dependencies: CliDependencies, onExitCode: (code: number) => void = () => {}): Command {
  const { context, handlers = placeholderHandlers } = dependencies;
  const program = new Command()
    .name("timber")
    .version(version)
    .description("Manage Git worktrees.")
    .exitOverride()
    // Lets `timber update --version <tag>` reach the subcommand instead of printing Timber's own version.
    .enablePositionalOptions()
    .configureOutput({ writeOut: context.io.stdout, writeErr: context.io.stderr });

  function resultOptions(command: Command): Command {
    return command.option("--result-file <path>", "Write an experimental v1 JSON outcome to a new file; requires --no-editor --no-agent");
  }

  function agentOptions(command: Command): Command {
    const choices = new Set<string>();
    return command
      .option("--agent", "Run the configured agent in this terminal")
      .option("--no-agent", "Skip the configured agent")
      .on("option:agent", () => { choices.add("enable"); })
      .on("option:no-agent", () => { choices.add("disable"); })
      .hook("preAction", () => {
        if (choices.size > 1) command.error("Conflicting options: --agent and --no-agent.");
      });
  }

  function editorOptions(command: Command): Command {
    const choices = new Set<string>();
    return command
      .option("--editor", "Open the configured editor for this command")
      .option("--no-editor", "Skip opening the configured editor")
      .on("option:editor", () => { choices.add("enable"); })
      .on("option:no-editor", () => { choices.add("disable"); })
      .hook("preAction", () => {
        if (choices.size > 1) command.error("Conflicting options: --editor and --no-editor.");
      });
  }

  function workflowOptions(command: Command): Command {
    let count = 0;
    return command
      .option("-w, --workflow <name>", "Select a named worktree workflow")
      .option("--w <name>", "Alias for --workflow")
      .on("option:workflow", () => { count++; })
      .on("option:w", () => { count++; })
      .hook("preAction", () => {
        if (count > 1) command.error("Specify a workflow only once; workflow aliases conflict.");
      });
  }

  resultOptions(workflowOptions(agentOptions(editorOptions(program.command("new <branch...>")))))
    .description("Create a worktree from a branch, sentence, or default tracker issue; explicit github:<number>, linear:<KEY>, jira:<KEY> and named workflows are supported")
    .option("--base <ref>", "Override the configured base branch")
    .option("--remote <name>", "Select the GitHub issue remote only; does not change --base")
    .option("-c", "Allow a closed or completed GitHub, Linear, or Jira issue; does not reopen it")
    .action(async (branch: string[], options: { resultFile?: string; base?: string; workflow?: string; w?: string; editor?: boolean; agent?: boolean; remote?: string; c?: boolean }) => {
      const normalized: NewOptions = {
        ...(options.remote === undefined ? {} : { remote: options.remote }),
        ...(options.c === true ? { allowClosed: true } : {}),
        ...(options.base === undefined ? {} : { base: options.base }),
        ...(options.workflow === undefined && options.w === undefined ? {} : { workflow: options.workflow ?? options.w }),
        ...(options.editor === undefined ? {} : { editor: options.editor }),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      };
      if (options.resultFile !== undefined) {
        requireSuppressedLaunches(normalized);
        onExitCode(await runMachineCommand("new", context, machineContext => handlers.new(branch.join(" "), normalized, machineContext), options.resultFile));
      } else {
        onExitCode((await handlers.new(branch.join(" "), normalized, context)) ?? 0);
      }
    });

  resultOptions(workflowOptions(agentOptions(editorOptions(program.command("open <input>")))))
    .description("Open an existing branch or worktree; choose a missing base interactively")
    .option("--setup", "Rerun ordinary and workflow post_create hooks in the selected worktree")
    .action(async (input: string, options: { resultFile?: string; workflow?: string; w?: string; editor?: boolean; setup?: boolean; agent?: boolean }) => {
      const normalized: OpenOptions = {
        ...(options.workflow === undefined && options.w === undefined ? {} : { workflow: options.workflow ?? options.w }),
        ...(options.editor === undefined ? {} : { editor: options.editor }),
        ...(options.setup === true ? { setup: true as const } : {}),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      };
      if (options.resultFile !== undefined) {
        requireSuppressedLaunches(normalized);
        onExitCode(await runMachineCommand("open", context, machineContext => handlers.open(input, normalized, machineContext), options.resultFile));
      } else {
        onExitCode((await handlers.open(input, normalized, context)) ?? 0);
      }
    });

  program.command("rebase <branch-or-worktree>")
    .description("Rebase an existing worktree onto its saved base; leave conflicts for manual resolution")
    .option("--base <ref>", "Override and remember the base (remote/branch, plain remote branch, or refs/heads/local-branch)")
    .option("--result-file <path>", "Write an experimental v1 JSON outcome to a new file")
    .addHelpText("after", "\nRewrites commit IDs, including published commits. No automatic stash, abort, push or tool launch.\nResolve and stage conflicts, then use native git rebase --continue or --abort in the target worktree.\nRemote bases are fetched; local bases are used as-is and must be up to date.")
    .action(async (input: string, options: { base?: string; resultFile?: string }) => {
      const rebase = handlers.rebase;
      if (!rebase) throw new Error("Rebase handler is unavailable in this embedding.");
      const normalized = options.base === undefined ? {} : { base: options.base };
      onExitCode(options.resultFile === undefined
        ? await rebase(input, normalized, context)
        : await runMachineCommand("rebase", context, machineContext => rebase(input, normalized, machineContext), options.resultFile));
    });

  program.command("publish <branch-or-worktree>")
    .description("Push an existing worktree's branch to its remote and set its upstream")
    .option("--result-file <path>", "Write an experimental v1 JSON outcome to a new file")
    .addHelpText("after", "\nPushes the branch under its own name to its upstream remote, or to the configured or only remote.\nNever force-pushes, pushes tags or prompts for credentials. A remote that has moved on is refused.")
    .action(async (input: string, options: { resultFile?: string }) => {
      const publish = handlers.publish;
      if (!publish) throw new Error("Publish handler is unavailable in this embedding.");
      onExitCode(options.resultFile === undefined
        ? await publish(input, context)
        : await runMachineCommand("publish", context, machineContext => publish(input, machineContext), options.resultFile));
    });

  const backup = program.command("backup")
    .description("Create private recovery backups of a worktree, including ignored files, and restore them");
  backup.command("create <branch-or-worktree>")
    .description("Snapshot a worktree's commit and files, including modified, untracked and ignored files")
    .addHelpText("after", "\nStored privately in the repository's Git directory, so removing the worktree keeps the backup.\nIgnored files such as .env are copied. The Git index and in-progress operations are not captured.\nRefuses worktrees with an in-progress rebase, merge or similar operation. Never runs hooks, editors or agents.")
    .action(async (input: string) => {
      if (!handlers.backupCreate) throw new Error("Backup handler is unavailable in this embedding.");
      onExitCode(await handlers.backupCreate(input, context));
    });
  backup.command("restore <id> <destination>")
    .description("Recover a backup into a new directory on branch recovery/<id>")
    .addHelpText("after", "\nThe destination must not exist. Restored changes appear as unstaged or untracked files.\nNever overwrites existing files, changes the source worktree or runs hooks, setup, editors or agents.")
    .action(async (id: string, destination: string) => {
      if (!handlers.backupRestore) throw new Error("Backup handler is unavailable in this embedding.");
      onExitCode(await handlers.backupRestore(id, destination, context));
    });

  const arena = program.command("arena")
    .description("Prepare isolated attempts with the same task and base; sequential agents");
  const arenaTokens: ArenaGroupToken[] = [];
  editorOptions(arena.command("new <name-or-ticket>"))
    .description("Create at least 2 attempts; task entry and tool/model/effort/run selection are interactive by default")
    .option("--prompt-file <path>", "Read task instructions from a UTF-8 file; alternative to --prompt")
    .option("--name <name>", "Override arena name, including for another portion of a ticket")
    .option("--tool <name>", "Start an ordered codex, claude, cursor, or manual attempt group")
    .option("--model <id>", "Select model for preceding native tool; omission uses its configured default")
    .option("--default-effort <level>", "Arena effort default; validated for every selected native tool/model")
    .option("--effort <level>", "Override preceding tool/model effort; default keeps its native setting")
    .option("--runs <count>", "Number of runs in preceding tool or preset group (default: 1)")
    .option("--preset <name>", "Select a saved agent preset (searchable name)")
    .option("--prompt <text>", "Use quoted task instructions instead of --prompt-file")
    .on("option:tool", (value: string) => arenaTokens.push({option: "tool", value}))
    .on("option:model", (value: string) => arenaTokens.push({option: "model", value}))
    .on("option:effort", (value: string) => arenaTokens.push({option: "effort", value}))
    .on("option:runs", (value: string) => arenaTokens.push({option: "runs", value}))
    .on("option:preset", (value: string) => arenaTokens.push({option: "preset", value}))
    .option("--base <ref>", "Resolve one starting commit for every attempt")
    .option("--no-agent", "Prepare workspaces without launching agents; required for agent presets without a terminal")
    .addHelpText("after", "\nAll worktrees and setup finish before sequential editor/foreground-agent launches. Failures retain completed state. No automatic cleanup or background sessions. Use arena resume to revisit retained attempts, or arena pick to compare and explicitly keep a winner.")
    .action(async (name: string, options: { promptFile?: string; prompt?: string; defaultEffort?: string; name?: string; base?: string; agent?: boolean; editor?: boolean }) => {
      const normalized: ArenaNewOptions = {
        ...(options.defaultEffort === undefined ? {} : { defaultEffort: options.defaultEffort }),
        ...(options.promptFile === undefined ? {} : { taskFile: options.promptFile }),
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
        ...(arenaTokens.length ? { groups: parseArenaGroups(arenaTokens) } : {}),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.base === undefined ? {} : { base: options.base }),
        ...(options.agent === false ? { agent: false as const } : {}),
        ...(options.editor === undefined ? {} : { editor: options.editor }),
      };
      if (handlers.arenaNew === undefined) throw new Error("Arena handler is unavailable in this embedding.");
      onExitCode(await handlers.arenaNew(name, normalized, context));
    });

  editorOptions(arena.command("resume <name>"))
    .description("Revisit an existing attempt and launch its recorded agent without recreating work")
    .option("--attempt <label>", "Exact recorded attempt label; required without an interactive terminal")
    .option("--setup", "Deliberately rerun ALL ordinary post_create hooks, then launch unless --no-agent")
    .option("--no-agent", "Revisit or retry setup without launching an agent; required for unattended agent attempts")
    .addHelpText("after", "\nWorkspace continuation preserves current commits and files. Agent conversation restoration is tool-specific, not guaranteed. Incomplete setup requires --setup; existing locks and uncertain launch stages require inspection. Missing/changed agent configuration is never substituted. Agents remain in this foreground terminal.")
    .action(async (name: string, options: { attempt?: string; setup?: boolean; agent?: boolean; editor?: boolean }) => {
      const normalized: ArenaResumeOptions = {
        ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
        ...(options.setup === true ? { setup: true as const } : {}),
        ...(options.agent === false ? { agent: false as const } : {}),
        ...(options.editor === undefined ? {} : { editor: options.editor }),
      };
      if (handlers.arenaResume === undefined) throw new Error("Arena resume handler is unavailable in this embedding.");
      onExitCode(await handlers.arenaResume(name, normalized, context));
    });

  arena.command("pick <name>")
    .description("BETA (incomplete): compare attempts, keep a winner, archive and remove the others")
    .option("--inspect", "Compare attempts and print diff commands without changing anything")
    .option("--winner <label>", "Attempt to keep; required without an interactive terminal")
    .option("--keep-branch", "Keep local branches of removed attempts")
    .option("--keep-ignored", "Keep attempts that contain ignored files such as .env instead of deleting those files")
    .addHelpText("after", "\nBeta: incomplete and under active testing; behavior may change.\n\nThe winner's branch and workspace are untouched; nothing is merged or pushed. Before removing another attempt, its commits and uncommitted (non-ignored) files are saved under refs/timber/arena/<name>/<label>, so they can be restored with git worktree add. Ignored files are deleted unless --keep-ignored. Running attempts are kept. Attempts that cannot be archived or verified are kept with a reason; the command then exits nonzero and can be rerun. Removal frees disk; RAM is freed when agent processes exit, and Timber never kills them.")
    .action(async (name: string, options: ArenaPickOptions) => {
      if (handlers.arenaPick === undefined) throw new Error("Arena pick handler is unavailable in this embedding.");
      onExitCode(await handlers.arenaPick(name, options, context));
    });

  program.command("setup")
    .description("Guide repository settings or machine defaults without launching tools")
    .option("--global", "Configure defaults for all repositories on this machine", false)
    .action((options: { global: boolean }) => handlers.setup({ global: options.global }, context));

  program.command("uninstall")
    .description("Remove the running standalone Timber executable; settings are kept unless requested")
    .option("--remove-settings", "Also remove machine config, saved Jira and Linear credentials, the setup hint marker and the update check cache")
    .option("--yes", "Confirm without a prompt; required without an interactive terminal")
    .addHelpText("after", "\nOnly a standalone release build is removed, never a Bun source run. Symlinks, files owned by another user and paths inside Git are refused. Unknown files are never deleted. Repositories, worktrees, branches, .timber.toml and <git common dir>/timber/ are never touched.")
    .action(async (options: { removeSettings?: boolean; yes?: boolean }) => {
      if (!handlers.uninstall) throw new Error("Uninstall handler is unavailable in this embedding.");
      onExitCode(await handlers.uninstall({
        ...(options.removeSettings === true ? { removeSettings: true } : {}),
        ...(options.yes === true ? { yes: true } : {}),
      }, context));
    });

  program.command("ls")
    .description("List this repository's worktrees with branches, workflows, and file status (read-only)")
    .option("--json", "Print experimental v1 repository/worktree JSON")
    .action(async (options: { json?: boolean }) => {
      if (options.json) {
        onExitCode(await runMachineCommand("ls", context, machineContext => handlers.list(machineContext)));
      } else {
        await handlers.list(context);
      }
    });

  program.command("__ide-done <action> <target>", { hidden: true })
    .option("--keep-branch")
    .option("--keep-ignored")
    .option("--base <ref>")
    .option("--approval-file <path>")
    .option("--result-file <path>")
    .action(async (action: string, target: string, options) => {
      onExitCode(await runNativeCleanup(action, target, options, context));
    });

  program.command("__app-config <action> [integration]", { hidden: true })
    .option("--scope <scope>")
    .option("--input-file <path>")
    .option("--result-file <path>")
    .option("--edit-tracked")
    .action(async (action: string, integration: string | undefined, options) => {
      onExitCode(await runAppConfig(action, integration, options, context));
    });

  program.command("done <branch-or-worktree>")
    .option("--base <ref>", "Verify integration against this base instead of the saved/configured/default branch")
    .description("Remove a linked worktree and its local branch; discard ignored files by default")
    .option(
      "--keep-branch",
      "Retain the local branch after removing the worktree",
      false,
    )
    .option("--keep-ignored", "Refuse removal when ignored files exist; leave them in the worktree", false)
    .option("--discard-ignored", "Discard ignored files, including .env (the default)")
    .addHelpText("after", "\nPublished or integrated commits allow ordinary clean cleanup.\nA confirmed deleted upstream automatically discards local commits and modified/untracked files.\nOther file or commit refusals offer an interactive delete-anyway prompt (default No).\nNoninteractive runs refuse when confirmation is required. Remote branches are never deleted.\nConfigured pre_delete hooks run after initial safety checks and before removal, including with --keep-branch.\nHook failure retains the worktree and branch; hook side effects remain. Safety is rechecked after hooks.\n")
    .action((input: string, options: { base?: string; keepBranch?: boolean; keepIgnored?: boolean; discardIgnored?: boolean }) => {
      if (options.keepIgnored && options.discardIgnored) {
        throw new Error("Cannot combine --keep-ignored and --discard-ignored.");
      }
      const normalized: CleanupOptions = {
        ...(options.base === undefined ? {} : { base: options.base }),
        keepBranch: options.keepBranch === true,
        discardIgnored: options.keepIgnored !== true,
      };
      return handlers.done(input, normalized, context);
    });

  program.command("update")
    .description("Install the latest Timber release, or --check for one without installing")
    .option("--check", "Check for a newer release and refresh the cached result; installs nothing")
    .option("--version <tag>", "Install a specific release tag such as v0.1.0")
    .addHelpText("after", "\nStandalone executable only. Runs the release's install.sh, which verifies checksums and leaves the existing install in place on failure.")
    .action(async (options: { check?: boolean; version?: string }) => {
      if (!handlers.update) throw new Error("Update handler is unavailable in this embedding.");
      onExitCode(await handlers.update({
        ...(options.check === true ? { check: true } : {}),
        ...(options.version === undefined ? {} : { version: options.version }),
      }, context));
    });

  program.command("__update-check", { hidden: true })
    .action(async () => { onExitCode(await (handlers.updateCheck?.(context) ?? 0)); });

  program.command("completion <shell>")
    .description("Print a completion script for Bash, Zsh, or Fish; does not modify shell startup files")
    .action((shell: string) => {
      const script = completionScript(shell);
      if (script === undefined) {
        throw new Error("Supported completion shells: Bash, Zsh, and Fish. Run timber completion bash, timber completion zsh, or timber completion fish.");
      }
      context.io.stdout(script);
    });

  program.command("__complete-words <prefix> [words...]", { hidden: true })
    .action(async (prefix: string, words: string[]) => {
      for (const candidate of await completionCandidates(program, { cwd: context.cwd, words, prefix })) {
        context.io.stdout(candidate + "\0");
      }
    });

  program.command("__complete <input> [words...]", { hidden: true })
    .option("--bash", "Format candidates for literal Bash insertion")
    .option("--fish", "Accept Fish-tokenized arguments")
    .option("--word-breaks <characters>", "Bash Readline word separators")
    .action(async (input: string, words: string[], options: { bash?: boolean; fish?: boolean; wordBreaks?: string }) => {
      if (options.bash && options.fish) throw new Error("Cannot combine --bash and --fish.");
      if (options.fish) {
        for (const candidate of await completionCandidates(program, { cwd: context.cwd, words, prefix: input })) {
          // Fish treats a tab as a description separator, which would truncate a path.
          if (!candidate.includes("\t")) context.io.stdout(candidate + "\0");
        }
        return;
      }
      const request = { cwd: context.cwd, ...parseBashCompletion(input, options.wordBreaks) };
      // Already typed expansion syntax is not a literal selector. In particular,
      // quoting a suffix cannot protect an unquoted prefix retained by Readline.
      if (options.bash && request.hasExpansion) return;
      for (const candidate of await completionCandidates(program, request)) {
        const insertion = candidate.slice(request.replacementPrefix.length);
        context.io.stdout((options.bash ? formatBashCandidate(insertion, request.quote) : candidate) + "\0");
      }
    });
  return program;
}

/** argv contains user arguments only. No process exit or terminal reads. */
export async function runCli(argv: readonly string[], dependencies: CliDependencies): Promise<number> {
  const { context } = dependencies;
  let exitCode = 0;
  const program = createCli(dependencies, code => { exitCode = code; });
  try {
    await program.parseAsync(argv.length === 0 ? ["--help"] : [...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    // Commander already wrote help or its diagnostic to the configured stream.
    if (error instanceof CommanderError) return error.exitCode;
    // Service and Git errors can carry raw bytes; every diagnostic leaves here terminal-safe.
    const message = error instanceof Error ? error.message : "Command failed unexpectedly";
    const rendered = error instanceof FormattedError
      ? message.split("\n").map(safeDiagnostic).join("\n")
      : safeDiagnostic(message);
    context.io.stderr(`error: ${rendered}\n`);
    return 1;
  }
}
