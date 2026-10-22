import type { CommandHandlers, CommandServices } from "../services";
import type { Worktree } from "../types";
import { alignedRows } from "../columns";

/** Keep each worktree on one row, including paths with terminal control characters. */
function display(value: string): string {
  if (!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) return value;
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function statusSummary(tree: Worktree): string {
  const parts: string[] = [];
  if (tree.status.kind === "unknown") {
    parts.push(`unknown (${display(tree.status.reason)})`);
  } else if (!tree.pathExists) {
    parts.push("unknown (Worktree path is missing)");
  } else {
    const modified = new Set(tree.status.modified).size;
    const untracked = new Set(tree.status.untracked).size;
    const ignored = new Set(tree.status.ignored).size;
    parts.push(modified || untracked ? `dirty (${modified} modified, ${untracked} untracked)` : "clean");
    if (ignored) parts.push(`${ignored} ignored`);
  }
  if (!tree.pathExists) parts.push("missing");
  if (tree.locked) parts.push("locked");
  if (tree.prunable) parts.push("prunable");
  return parts.join("; ");
}

/** Scoped validation and offline inventory; no Git mutation or launches. */
export function createListHandler(
  services: Pick<CommandServices, "discoverRepository" | "listWorktrees" | "loadConfig" | "readWorkflowAssociation" | "readBaseAssociation">,
): CommandHandlers["list"] {
  return async context => {
    const repository = await services.discoverRepository(context.cwd);
    await services.loadConfig(repository);
    const trees = await services.listWorktrees(repository);
    if (trees.length === 0) {
      context.io.stdout("No worktrees found.\n");
      return;
    }
    const sorted = [...trees].sort((a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const rows = await Promise.all(sorted.map(async tree => {
      const association = await services.readWorkflowAssociation(repository, tree);
      const base = await services.readBaseAssociation(repository, tree);
      return {
        baseWarning: base.kind === "invalid"
          ? `warning: Cannot read base association for ${display(tree.path)} (${base.reason}); Git worktree remains listed.\n` : null,
        warning: association.kind === "invalid"
          ? `warning: Cannot read workflow association for ${display(tree.path)} (${association.reason}); Git worktree remains listed.\n`
          : null,
        cells: [
          tree.isPrimary ? "primary" : "linked",
          tree.branch === null ? "(detached HEAD)" : display(tree.branch),
          base.kind === "assigned" ? display(base.ref.replace(/^refs\/remotes\//u, "")) : base.kind === "unassigned" ? "-" : "?",
          association.kind === "assigned" ? display(association.name) : association.kind === "unassigned" ? "-" : "?",
          statusSummary(tree),
          display(tree.path),
        ],
      };
    }));
    for (const row of rows) {
      if (row.baseWarning !== null) context.io.stderr(row.baseWarning);
      if (row.warning !== null) context.io.stderr(row.warning);
    }
    context.io.stdout(alignedRows(["WORKTREE", "BRANCH", "BASE", "WORKFLOW", "STATUS", "PATH"], rows.map(row => row.cells)));
  };
}
