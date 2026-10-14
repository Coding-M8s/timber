import { Command, CommanderError } from "commander";
import { version } from "../package.json";
import { complete, completionCatalog, type CompletionServices } from "./completion/candidates";
import { decodeBashInput, renderBashCompletion } from "./completion/bash";
import { FormattedError, safeDiagnostic } from "./display";
import type { CommandContext, CommandHandlers, NewOptions, OpenOptions } from "./services";
import type { CleanupOptions } from "./types";

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
  completion?: CompletionServices;
}

interface ProgramState {
  exitCode: number;
}

const programStates = new WeakMap<Command, ProgramState>();

export function createProgram(dependencies: CliDependencies): Command {
  const { context, handlers = placeholderHandlers } = dependencies;
  const state: ProgramState = { exitCode: 0 };
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

  agentOptions(program.command("new <branch...>"))
    .description("Create a worktree from a branch name or sentence; configured Jira ticket IDs become descriptive branches")
    .option("--base <ref>", "Override the configured base branch")
    .option("--no-editor", "Skip opening the configured editor")
    .action(async (branch: string[], options: { base?: string; editor: boolean; agent?: boolean }) => {
      const normalized: NewOptions = {
        ...(options.base === undefined ? {} : { base: options.base }),
        ...(options.editor === false ? { editor: false as const } : {}),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      };
      state.exitCode = (await handlers.new(branch.join(" "), normalized, context)) ?? 0;
    });

  agentOptions(program.command("open <input>"))
    .description("Open an existing branch or worktree")
    .option("--no-editor", "Skip opening the configured editor")
    .option("--setup", "Rerun all post_create setup hooks in the selected worktree")
    .action(async (input: string, options: { editor: boolean; setup?: boolean; agent?: boolean }) => {
      const normalized: OpenOptions = {
        ...(options.editor === false ? { editor: false as const } : {}),
        ...(options.setup === true ? { setup: true as const } : {}),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      };
      state.exitCode = (await handlers.open(input, normalized, context)) ?? 0;
    });

  program.command("setup")
    .description("Guide repository settings or machine defaults without launching tools")
    .option("--global", "Configure defaults for all repositories on this machine", false)
    .action((options: { global: boolean }) => handlers.setup({ global: options.global }, context));

  program.command("ls")
    .description("List this repository's worktrees with branches and file status (read-only)")
    .action(() => handlers.list(context));

  program.command("done <branch-or-worktree>")
    .description("Remove a linked worktree, discard ignored files, and delete its branch when published or integrated")
    .option(
      "--keep-branch",
      "Retain the local branch after removing the worktree",
      false,
    )
    .option("--keep-ignored", "Refuse removal when ignored files exist; leave them in the worktree", false)
    .option("--discard-ignored", "Discard ignored files, including .env (the default)")
    .action((input: string, options: { keepBranch?: boolean; keepIgnored?: boolean; discardIgnored?: boolean }) => {
      if (options.keepIgnored && options.discardIgnored) {
        throw new Error("Cannot combine --keep-ignored and --discard-ignored.");
      }
      const normalized: CleanupOptions = {
        keepBranch: options.keepBranch === true,
        discardIgnored: options.keepIgnored !== true,
      };
      return handlers.done(input, normalized, context);
    });

  const completion = program.command("completion").description("Generate shell completion scripts");
  completion.command("bash")
    .description("Print the Bash completion script")
    .action(() => context.io.stdout(renderBashCompletion()));

  const query = completion.command("__query [args...]", { hidden: true })
    .description("Internal Bash completion lookup")
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments();
  query.action(async (args: string[]) => {
    try {
      const [cwordText, pointText, line, wordbreaks, ...words] = args;
      if (cwordText === undefined || pointText === undefined || line === undefined || wordbreaks === undefined
        || !/^(0|[1-9][0-9]*)$/.test(cwordText) || !/^(0|[1-9][0-9]*)$/.test(pointText)) return;
      const cword = Number(cwordText);
      const point = Number(pointText);
      if (!Number.isSafeInteger(cword) || !Number.isSafeInteger(point) || cword < 1) return;
      const decoded = decodeBashInput({ cword, point, line, wordbreaks, words });
      // COMP_CWORD indexes Bash's word-break-aware COMP_WORDS; decoding COMP_LINE can yield fewer words.
      if (!decoded) return;

      const candidates = await complete({
        cwd: context.cwd,
        words: decoded.words.slice(1),
        current: decoded.current,
      }, completionCatalog(program), dependencies.completion ?? { listTargets: async () => [] });
      const safeCandidates = [...new Set(candidates.filter(value => value.length > 0
        && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)))];
      for (const candidate of safeCandidates) context.io.stdout(`${candidate}\0`);
    } catch {
      // Completion is an interactive wire protocol; failures must not print CLI diagnostics.
    }
  });

  programStates.set(program, state);
  return program;
}

/** argv contains user arguments only. No process exit, terminal reads, or Git calls. */
export async function runCli(argv: readonly string[], dependencies: CliDependencies): Promise<number> {
  const { context } = dependencies;
  const program = createProgram(dependencies);
  const state = programStates.get(program)!;

  try {
    await program.parseAsync(argv.length === 0 ? ["--help"] : [...argv], { from: "user" });
    return state.exitCode;
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
