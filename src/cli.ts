import { Command, CommanderError } from "commander";
import { version } from "../package.json";
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
}

/** argv contains user arguments only. No process exit, terminal reads, or Git calls. */
export async function runCli(argv: readonly string[], dependencies: CliDependencies): Promise<number> {
  const { context, handlers = placeholderHandlers } = dependencies;
  let exitCode = 0;
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
      exitCode = (await handlers.new(branch.join(" "), normalized, context)) ?? 0;
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
      exitCode = (await handlers.open(input, normalized, context)) ?? 0;
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
