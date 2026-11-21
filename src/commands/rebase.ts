import type { CommandContext, CommandHandlers, CommandServices, RebaseOptions } from "../services";
import { createRebaseReport } from "../git/rebase";
import { assertResolveTerminal, resolveHandoff, resolveRebase } from "../git/rebase-resolve";
import { selectRegisteredWorktree } from "./select-worktree";
import { resolveInstructionsSchema } from "../config";

/** Select only registered worktrees; execution owns fresh preflight and mutation. */
export function createRebaseHandler(
  services: Pick<CommandServices, "discoverRepository" | "loadConfig" | "resolveOpenTarget" | "rebaseWorktree">
    & Partial<Pick<CommandServices, "createBackup" | "launchAgent" | "startRebaseRetention">>,
): NonNullable<CommandHandlers["rebase"]> {
  return async (input, options, context) => {
    if (options.resolve) {
      if (context.machine) throw new Error("--resolve cannot be combined with --result-file; assisted resolution needs an interactive terminal.");
      return resolveCommand(input, options, context);
    }
    if (options.resolveNote !== undefined) throw new Error("--resolve-note requires --resolve.");
    // Result-file mode reports through the record; a stop before rebase is a refusal.
    const report = context.machine ? createRebaseReport() : undefined;
    if (report) context.machine?.rebase(report);
    if (!input.trim()) throw new Error("Provide an existing branch or absolute worktree path to rebase.");
    const repository = await services.discoverRepository(context.cwd);
    await context.machine?.repository(repository);
    const config = await services.loadConfig(repository);
    // A machine consumer gets exact-selection guidance, never a chooser.
    const { choose: _choose, ...withoutChooser } = context;
    const selectionContext = report ? withoutChooser : context;
    const selected = await selectRegisteredWorktree(services, repository, config, input, selectionContext,
      { command: "rebase", past: "rebased", rerun: "timber rebase" },
      // Only the machine record snapshots status; plain rebase inspects at preflight.
      { inspectStatus: report !== undefined });
    if (selected === null) { context.io.stdout("Cancelled.\n"); return 0; }
    if (!report) return services.rebaseWorktree(repository, selected, config, options.base, context.io);
    // Snapshot before the rebase; the saved base is read again afterwards.
    await context.machine?.worktree(selected, false);
    try {
      return await services.rebaseWorktree(repository, selected, config, options.base, context.io, report);
    } finally {
      await context.machine?.refreshMetadata();
    }
  };

  /** Explicit per-invocation opt-in; every refusal here happens before any Git change. */
  async function resolveCommand(input: string, options: RebaseOptions, context: CommandContext): Promise<number> {
    const { createBackup, launchAgent } = services;
    if (!createBackup || !launchAgent) throw new Error("--resolve is unavailable in this embedding.");
    assertResolveTerminal(context);
    if (options.resolveNote !== undefined && !resolveInstructionsSchema.safeParse(options.resolveNote).success) {
      throw new Error("--resolve-note must be nonempty text of at most 4000 characters.");
    }
    if (!input.trim()) throw new Error("Provide an existing branch or absolute worktree path to rebase.");
    const repository = await services.discoverRepository(context.cwd);
    const config = await services.loadConfig(repository);
    const handoff = resolveHandoff(config);
    const selected = await selectRegisteredWorktree(services, repository, config, input, context,
      { command: "rebase", past: "rebased", rerun: "timber rebase --resolve" });
    if (selected === null) { context.io.stdout("Cancelled.\n"); return 0; }
    const { startRebaseRetention } = services;
    return resolveRebase({ rebaseWorktree: services.rebaseWorktree, createBackup, launchAgent, ...startRebaseRetention ? { startRebaseRetention } : {} }, repository, selected, config, handoff,
      { ...(options.base === undefined ? {} : { base: options.base }), ...(options.resolveNote === undefined ? {} : { note: options.resolveNote.trim() }) },
      context);
  }
}
