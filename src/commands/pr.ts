import type { CommandHandlers, CommandServices } from "../services";
import { createPullRequestReport } from "../github/pull-request";
import { selectRegisteredWorktree } from "./select-worktree";

/** Select only registered worktrees; execution owns preflight, the push and the GitHub calls. */
export function createPullRequestHandler(
  services: Pick<CommandServices, "discoverRepository" | "loadConfig" | "resolveOpenTarget" | "openPullRequest">,
): NonNullable<CommandHandlers["pr"]> {
  return async (input, options, context) => {
    // Result-file mode reports through the record; a stop before the push is a refusal.
    const report = context.machine ? createPullRequestReport() : undefined;
    if (report) context.machine?.pr(report);
    if (!input.trim()) throw new Error("Provide an existing branch or absolute worktree path to open a pull request for.");
    const repository = await services.discoverRepository(context.cwd);
    await context.machine?.repository(repository);
    const config = await services.loadConfig(repository);
    // A machine consumer gets exact-selection guidance, never a chooser.
    const { choose: _choose, ...withoutChooser } = context;
    const selected = await selectRegisteredWorktree(services, repository, config, input, report ? withoutChooser : context,
      { command: "pr", past: "opened as a pull request", rerun: "timber pr" },
      { inspectStatus: report !== undefined });
    if (selected === null) { context.io.stdout("Cancelled.\n"); return 0; }
    await context.machine?.worktree(selected, false);
    return services.openPullRequest(repository, selected, config, options, context.io, report);
  };
}
