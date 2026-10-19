import { FormattedError } from "../display";
import type { CommandHandlers, CommandServices } from "../services";
import type { Worktree } from "../types";

const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

function escapeControl(character: string): string {
  if (character === "\n") return "\\n";
  if (character === "\r") return "\\r";
  if (character === "\t") return "\\t";
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function quoted(value: string): string {
  return JSON.stringify(value).replace(controls, escapeControl);
}

function display(value: string): string {
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ? quoted(value) : value;
}

function worktreeLabel(tree: Worktree): string {
  return `Worktree ${quoted(tree.path)} (${tree.branch === null ? "detached HEAD" : display(tree.branch)})`;
}

function ambiguousMessage(input: string, candidates: readonly Worktree[]): string {
  const rows = candidates.slice(0, 5).map(tree => `  ${worktreeLabel(tree)}`);
  return `Input ${quoted(input)} matches multiple worktrees (${candidates.length}; showing ${rows.length}). Choose an exact branch name or absolute worktree path and run timber done again:\n${rows.join("\n")}\nRerun in an interactive terminal to choose from all matches.`;
}

/** Resolve one existing worktree; fresh safety checks and all mutations belong to cleanup. */
export function createDoneHandler(
  services: Pick<CommandServices,
    "discoverRepository" | "loadConfig" | "resolveOpenTarget" | "cleanupWorktree">,
): CommandHandlers["done"] {
  return async (input, options, context) => {
    if (!input.trim()) throw new Error("Provide an existing branch or absolute worktree path to clean up.");
    const repository = await services.discoverRepository(context.cwd);
    const config = await services.loadConfig(repository);
    const resolution = await services.resolveOpenTarget(repository, input, config, { assertOpenable: false });
    if (resolution.kind === "not-found") {
      throw new Error(`No existing worktree or branch matches ${quoted(input)}. Check timber ls and use an exact branch or absolute worktree path.`);
    }
    let selected;
    if (resolution.kind === "ambiguous") {
      const candidates = [...new Map(resolution.candidates.flatMap(target => target.kind === "worktree"
        ? [[target.worktree.path, target.worktree] as const] : [])).values()]
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      if (candidates.length === 0) {
        throw new Error(`No registered worktree matches ${quoted(input)}; no branch was deleted.`);
      }
      let worktree = candidates[0]!;
      if (candidates.length > 1) {
        if (!context.choose) throw new FormattedError(ambiguousMessage(input, candidates));
        const choice = await context.choose(
          `Input ${quoted(input)} matches ${candidates.length} worktrees. Which one should be cleaned up?`,
          candidates.map(tree => ({ value: tree.path, label: worktreeLabel(tree) })),
        );
        if (choice === null) {
          context.io.stdout("Cancelled.\n");
          return;
        }
        const chosen = candidates.find(tree => tree.path === choice);
        if (!chosen) throw new Error("Invalid selection; no worktree was removed.");
        worktree = chosen;
      }
      const verified = await services.resolveOpenTarget(repository, worktree.path, config, { assertOpenable: false });
      if (verified.kind !== "found" || verified.value.kind !== "worktree"
        || verified.value.worktree.path !== worktree.path || verified.value.worktree.branch !== worktree.branch) {
        throw new Error("Selected worktree changed or is no longer available; run timber done again.");
      }
      selected = verified.value;
    } else {
      selected = resolution.value;
    }
    if (selected.kind === "branch") {
      throw new Error(`Branch ${display(selected.branch.ref)} has no registered worktree to remove. timber done only cleans up existing linked worktrees; no branch was deleted.`);
    }
    const worktree = selected.worktree;
    if (worktree.isPrimary) throw new Error(`Cannot clean up the primary worktree at ${display(worktree.path)}.`);

    const result = await services.cleanupWorktree(repository, worktree, config, options, context.io);
    context.io.stdout(`Removed worktree at ${display(result.removedWorktreePath)}\n`);
    if (result.deletedLocalBranch !== null) {
      context.io.stdout(`Deleted local branch ${display(result.deletedLocalBranch)}\n`);
    } else if (result.retainedLocalBranch !== null) {
      context.io.stdout(`Retained local branch ${display(result.retainedLocalBranch)}\n`);
    }
  };
}
