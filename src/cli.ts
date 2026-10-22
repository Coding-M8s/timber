import { parseArenaGroups } from "./arena/participants";
import type { ArenaGroupToken } from "./arena/types";
import type { ArenaNewOptions } from "./arena/types";
import { Command, CommanderError, Option } from "commander";
import { version } from "../package.json";
import { FormattedError, safeDiagnostic } from "./display";
import type { CommandContext, CommandHandlers, NewOptions, OpenOptions } from "./services";
import type { CleanupOptions } from "./types";
import { bashCompletionScript, formatBashCandidate, parseBashCompletion } from "./completion/bash";
import { completionCandidates } from "./completion/candidates";

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
    .configureOutput({ writeOut: context.io.stdout, writeErr: context.io.stderr });

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

  workflowOptions(agentOptions(editorOptions(program.command("new <branch...>"))))
    .description("Create a worktree from a branch name or sentence; configured Jira ticket IDs and named workflows are supported")
    .option("--base <ref>", "Override the configured base branch")
    .action(async (branch: string[], options: { base?: string; workflow?: string; w?: string; editor?: boolean; agent?: boolean }) => {
      const normalized: NewOptions = {
        ...(options.base === undefined ? {} : { base: options.base }),
        ...(options.workflow === undefined && options.w === undefined ? {} : { workflow: options.workflow ?? options.w }),
        ...(options.editor === undefined ? {} : { editor: options.editor }),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      };
      onExitCode((await handlers.new(branch.join(" "), normalized, context)) ?? 0);
    });

  workflowOptions(agentOptions(editorOptions(program.command("open <input>"))))
    .description("Open an existing branch or worktree, remembering its named workflow")
    .option("--setup", "Rerun ordinary and workflow post_create hooks in the selected worktree")
    .action(async (input: string, options: { workflow?: string; w?: string; editor?: boolean; setup?: boolean; agent?: boolean }) => {
      const normalized: OpenOptions = {
        ...(options.workflow === undefined && options.w === undefined ? {} : { workflow: options.workflow ?? options.w }),
        ...(options.editor === undefined ? {} : { editor: options.editor }),
        ...(options.setup === true ? { setup: true as const } : {}),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      };
      onExitCode((await handlers.open(input, normalized, context)) ?? 0);
    });

  program.command("rebase <branch-or-worktree>")
    .description("Rebase an existing worktree onto its saved base; leave conflicts for manual resolution")
    .option("--base <ref>", "Override and remember the base (remote/branch, plain remote branch, or refs/heads/local-branch)")
    .addHelpText("after", "\nRewrites commit IDs, including published commits. No automatic stash, abort, push or tool launch.\nResolve and stage conflicts, then use native git rebase --continue or --abort in the target worktree.\nRemote bases are fetched; local bases are used as-is and must be up to date.")
    .action(async (input: string, options: { base?: string }) => {
      if (!handlers.rebase) throw new Error("Rebase handler is unavailable in this embedding.");
      onExitCode(await handlers.rebase(input, options.base === undefined ? {} : { base: options.base }, context));
    });

  const arena = program.command("arena")
    .description("Prepare isolated attempts with the same task and base (Linux; sequential agents)");
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
    .addHelpText("after", "\nAll worktrees and setup finish before sequential editor/foreground-agent launches. Failures retain completed state. No automatic cleanup or background sessions. Resume/pick follow in later releases.")
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

  program.command("setup")
    .description("Guide repository settings or machine defaults without launching tools")
    .option("--global", "Configure defaults for all repositories on this machine", false)
    .action((options: { global: boolean }) => handlers.setup({ global: options.global }, context));

  program.command("ls")
    .description("List this repository's worktrees with branches, workflows, and file status (read-only)")
    .action(() => handlers.list(context));

  program.command("done <branch-or-worktree>")
    .option("--base <ref>", "Verify integration against this base instead of the configured/default branch")
    .description("Remove a linked worktree, discard ignored files, and delete its branch when published or integrated")
    .option(
      "--keep-branch",
      "Retain the local branch after removing the worktree",
      false,
    )
    .option("--keep-ignored", "Refuse removal when ignored files exist; leave them in the worktree", false)
    .option("--discard-ignored", "Discard ignored files, including .env (the default)")
    .addHelpText("after", "\nConfigured pre_delete hooks run after initial safety checks and before removal, including with --keep-branch.\nHook failure retains the worktree and branch; hook side effects remain. Safety is rechecked after hooks.\n")
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

  program.command("completion <shell>")
    .description("Print a completion script for Bash; does not modify shell startup files")
    .action((shell: string) => {
      if (shell !== "bash") throw new Error("Only Bash completion is supported. Run timber completion bash.");
      context.io.stdout(bashCompletionScript());
    });

  program.command("__complete <line>", { hidden: true })
    .option("--bash", "Format candidates for literal Bash insertion")
    .option("--word-breaks <characters>", "Bash Readline word separators")
    .action(async (line: string, options: { bash?: boolean; wordBreaks?: string }) => {
      const request = { cwd: context.cwd, ...parseBashCompletion(line, options.wordBreaks) };
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
