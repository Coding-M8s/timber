import { FormattedError, jsonDisplay, safeDisplay } from "../display";
import type { CommandContext, CommandServices } from "../services";
import type { RepositoryConfig, RepositoryContext, Worktree } from "../types";

export interface SelectionWording {
  /** Command name used in diagnostics, such as "rebase". */
  command: string;
  /** Passive verb for the chooser prompt, such as "rebased". */
  past: string;
  /** Full rerun command, such as "timber rebase". */
  rerun: string;
}

/**
 * Select one registered worktree without mutation; null means cancelled.
 * Execution still owns fresh identity checks before any change.
 */
export async function selectRegisteredWorktree(
  services: Pick<CommandServices, "resolveOpenTarget">, repository: RepositoryContext, config: RepositoryConfig,
  input: string, context: CommandContext, wording: SelectionWording,
): Promise<Worktree | null> {
  const resolution = await services.resolveOpenTarget(repository, input, config, { assertOpenable: false });
  if (resolution.kind === "not-found") throw new Error(`No registered worktree matches ${jsonDisplay(input)}; check timber ls.`);
  const candidates = [...new Map((resolution.kind === "found" ? [resolution.value] : resolution.candidates)
    .flatMap(target => target.kind === "worktree" ? [[target.worktree.path, target.worktree] as const] : [])).values()]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!candidates.length) throw new Error(`The selected branch has no registered worktree; ${wording.command} never creates one.`);
  if (candidates.length === 1) return candidates[0]!;
  if (!context.choose) throw new FormattedError(`Input ${jsonDisplay(input)} matches ${candidates.length} worktrees (showing ${Math.min(5, candidates.length)}). Use an exact branch or absolute path, or rerun in an interactive terminal:\n${candidates.slice(0, 5).map(tree => `  ${jsonDisplay(tree.path)} (${safeDisplay(tree.branch ?? "detached HEAD")})`).join("\n")}`);
  const choice = await context.choose(`Which worktree should be ${wording.past} for ${jsonDisplay(input)}?`, candidates.map(tree => ({
    value: tree.path, label: `${jsonDisplay(tree.path)} (${safeDisplay(tree.branch ?? "detached HEAD")})`,
  })));
  if (choice === null) return null;
  const chosen = candidates.find(tree => tree.path === choice);
  if (!chosen) throw new Error(`Invalid worktree selection; ${wording.command} was not started.`);
  const verified = await services.resolveOpenTarget(repository, chosen.path, config, { assertOpenable: false });
  if (verified.kind !== "found" || verified.value.kind !== "worktree"
    || verified.value.worktree.path !== chosen.path || verified.value.worktree.branch !== chosen.branch
    || verified.value.worktree.head !== chosen.head) throw new Error(`Selected worktree changed; rerun ${wording.rerun}.`);
  return chosen;
}
