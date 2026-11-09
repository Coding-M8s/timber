import type { CommandHandlers, CommandServices } from "../services";
import { createRebaseReport } from "../git/rebase";
import { selectRegisteredWorktree } from "./select-worktree";

/** Select only registered worktrees; execution owns fresh preflight and mutation. */
export function createRebaseHandler(
  services: Pick<CommandServices, "discoverRepository" | "loadConfig" | "resolveOpenTarget" | "rebaseWorktree">,
): NonNullable<CommandHandlers["rebase"]> {
  return async (input, options, context) => {
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
      await context.machine?.refreshBase();
    }
  };
}
