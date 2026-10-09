import { Command, CommanderError } from "commander";
import type { CommandContext, CommandHandlers, NewOptions, OpenOptions } from "./services";
import type { CleanupOptions } from "./types";

const placeholder = (name: string, ticket: string) => async (): Promise<void> => {
  throw new Error(`timber ${name} is not implemented yet (${ticket}). See timber ${name} --help.`);
};

export const placeholderHandlers: CommandHandlers = {
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
  const program = new Command()
    .name("timber")
    .description("Manage Git worktrees.")
    .exitOverride()
    .configureOutput({ writeOut: context.io.stdout, writeErr: context.io.stderr });

  program.command("new <branch>")
    .description("Create a new branch and worktree")
    .option("--base <ref>", "Override the configured base branch")
    .option("--no-editor", "Skip opening the configured editor")
    .action((branch: string, options: { base?: string; editor: boolean }) => {
      const normalized: NewOptions = {
        ...(options.base === undefined ? {} : { base: options.base }),
        ...(options.editor === false ? { editor: false as const } : {}),
      };
      return handlers.new(branch, normalized, context);
    });

  program.command("open <input>")
    .description("Open an existing branch or worktree")
    .option("--no-editor", "Skip opening the configured editor")
    .action((input: string, options: { editor: boolean }) => {
      const normalized: OpenOptions = options.editor === false ? { editor: false } : {};
      return handlers.open(input, normalized, context);
    });

  program.command("ls")
    .description("List this repository's worktrees with branches and file status (read-only)")
    .action(() => handlers.list(context));

  program.command("done <branch-or-worktree>")
    .description("Safely remove a linked worktree (placeholder; TIM-15)")
    .option("--keep-branch", "Keep the local branch after safe worktree removal", false)
    .option("--discard-ignored", "Explicitly allow discarding ignored files, including .env", false)
    .action((input: string, options: CleanupOptions) => handlers.done(input, options, context));

  try {
    await program.parseAsync(argv.length === 0 ? ["--help"] : [...argv], { from: "user" });
    return 0;
  } catch (error) {
    // Commander already wrote help or its diagnostic to the configured stream.
    if (error instanceof CommanderError) return error.exitCode;
    context.io.stderr(`error: ${error instanceof Error ? error.message : "Command failed unexpectedly"}\n`);
    return 1;
  }
}
