import type { CommandHandlers, CommandServices } from "../services";
import { createPublishReport } from "../git/publish";
import { selectRegisteredWorktree } from "./select-worktree";

/** Select only registered worktrees; execution owns fresh preflight and the push. */
export function createPublishHandler(
  services: Pick<CommandServices, "discoverRepository" | "loadConfig" | "resolveOpenTarget" | "publishWorktree">,
): NonNullable<CommandHandlers["publish"]> {
  return async (input, context) => {
    // Result-file mode reports through the record; a stop before the push is a refusal.
    const report = context.machine ? createPublishReport() : undefined;
    if (report) context.machine?.publish(report);
    if (!input.trim()) throw new Error("Provide an existing branch or absolute worktree path to publish.");
    const repository = await services.discoverRepository(context.cwd);
    await context.machine?.repository(repository);
    const config = await services.loadConfig(repository);
    // A machine consumer gets exact-selection guidance, never a chooser.
    const { choose: _choose, ...withoutChooser } = context;
    const selected = await selectRegisteredWorktree(services, repository, config, input, report ? withoutChooser : context,
      { command: "publish", past: "published", rerun: "timber publish" },
      // Only the machine record snapshots status; the push itself needs none.
      { inspectStatus: report !== undefined });
    if (selected === null) { context.io.stdout("Cancelled.\n"); return 0; }
    await context.machine?.worktree(selected, false);
    return services.publishWorktree(repository, selected, config, context.io, report);
  };
}
