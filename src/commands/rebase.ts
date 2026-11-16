import { FormattedError, jsonDisplay, safeDisplay } from "../display";
import type { CommandHandlers, CommandServices } from "../services";
import type { Worktree } from "../types";
import { createRebaseReport } from "../git/rebase";

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
    const resolution = await services.resolveOpenTarget(repository, input, config, { assertOpenable: false });
    if (resolution.kind === "not-found") throw new Error(`No registered worktree matches ${jsonDisplay(input)}; check timber ls.`);
    const candidates = [...new Map((resolution.kind === "found" ? [resolution.value] : resolution.candidates)
      .flatMap(target => target.kind === "worktree" ? [[target.worktree.path, target.worktree] as const] : [])).values()]
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (!candidates.length) throw new Error("The selected branch has no registered worktree; rebase never creates one.");
    let selected: Worktree = candidates[0]!;
    if (candidates.length > 1) {
      // A machine consumer gets exact-selection guidance, never a chooser.
      if (!context.choose || report) throw new FormattedError(`Input ${jsonDisplay(input)} matches ${candidates.length} worktrees (showing ${Math.min(5, candidates.length)}). Use an exact branch or absolute path, or rerun in an interactive terminal:\n${candidates.slice(0, 5).map(tree => `  ${jsonDisplay(tree.path)} (${safeDisplay(tree.branch ?? "detached HEAD")})`).join("\n")}`);
      const choice = await context.choose(`Which worktree should be rebased for ${jsonDisplay(input)}?`, candidates.map(tree => ({
        value: tree.path, label: `${jsonDisplay(tree.path)} (${safeDisplay(tree.branch ?? "detached HEAD")})`,
      })));
      if (choice === null) { context.io.stdout("Cancelled.\n"); return 0; }
      const chosen = candidates.find(tree => tree.path === choice);
      if (!chosen) throw new Error("Invalid worktree selection; rebase was not started.");
      selected = chosen;
      const verified = await services.resolveOpenTarget(repository, chosen.path, config, { assertOpenable: false });
      if (verified.kind !== "found" || verified.value.kind !== "worktree"
        || verified.value.worktree.path !== chosen.path || verified.value.worktree.branch !== chosen.branch
        || verified.value.worktree.head !== chosen.head) throw new Error("Selected worktree changed; rerun timber rebase.");
    }
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
