import type { CommandHandlers, CommandServices } from "../services";
import type { OpenTarget } from "../types";

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

async function safely<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    const message = error instanceof Error ? error.message : "Command failed unexpectedly";
    throw new Error(message.replace(controls, escapeControl));
  }
}

function ambiguousMessage(input: string, candidates: readonly OpenTarget[]): string {
  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.kind === "worktree") {
      const tree = candidate.worktree;
      unique.set(`worktree:${tree.path}`,
        `  Worktree ${quoted(tree.path)} (${tree.branch === null ? "detached HEAD" : display(tree.branch)})`);
    } else {
      const branch = candidate.branch;
      unique.set(`branch:${branch.ref}`,
        `  ${branch.kind === "local" ? "Local" : "Remote"} branch ${display(branch.ref)} — no registered worktree`);
    }
  }
  const rows = [...unique].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, row]) => row);
  return `Input ${quoted(input)} matches multiple targets. Choose an exact branch name or absolute worktree path and run timber done again:\n${rows.join("\n")}`;
}

/** Resolve one existing worktree; fresh safety checks and all mutations belong to cleanup. */
export function createDoneHandler(
  services: Pick<CommandServices,
    "discoverRepository" | "loadConfig" | "resolveOpenTarget" | "cleanupWorktree">,
): CommandHandlers["done"] {
  return async (input, options, context) => {
    if (!input.trim()) throw new Error("Provide an existing branch or absolute worktree path to clean up.");
    const repository = await safely(() => services.discoverRepository(context.cwd));
    const config = await safely(() => services.loadConfig(repository));
    const resolution = await safely(() =>
      services.resolveOpenTarget(repository, input, config, { assertOpenable: false }));
    if (resolution.kind === "not-found") {
      throw new Error(`No existing worktree or branch matches ${quoted(input)}. Check timber ls and use an exact branch or absolute worktree path.`);
    }
    if (resolution.kind === "ambiguous") throw new Error(ambiguousMessage(input, resolution.candidates));
    const selected = resolution.value;
    if (selected.kind === "branch") {
      throw new Error(`Branch ${display(selected.branch.ref)} has no registered worktree to remove. timber done only cleans up existing linked worktrees; no branch was deleted.`);
    }
    const worktree = selected.worktree;
    if (worktree.isPrimary) throw new Error(`Cannot clean up the primary worktree at ${display(worktree.path)}.`);

    const result = await safely(() => services.cleanupWorktree(repository, worktree, config, options));
    context.io.stdout(`Removed worktree at ${display(result.removedWorktreePath)}\n`);
    if (result.deletedLocalBranch !== null) {
      context.io.stdout(`Deleted local branch ${display(result.deletedLocalBranch)}\n`);
    } else if (result.retainedLocalBranch !== null) {
      context.io.stdout(`Retained local branch ${display(result.retainedLocalBranch)}\n`);
    }
  };
}
