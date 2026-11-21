import { WorktreeReadPhase } from "../git/worktree-read-phase";
import { mapWithLimit, WORKTREE_INSPECTION_LIMIT } from "../git/worktrees";
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
    parts.push(modified || untracked ? `dirty (${modified} modified, ${untracked} untracked)` : "clean");
  }
  if (!tree.pathExists) parts.push("missing");
  if (tree.locked) parts.push("locked");
  if (tree.prunable) parts.push("prunable");
  return parts.join("; ");
}

export function createListHandler(
  services: Pick<CommandServices, "discoverRepository" | "listWorktrees" | "loadConfig" | "readBaseAssociation" | "readIssueLink">,
): CommandHandlers["list"] {
  return async context => {
    const repository = await services.discoverRepository(context.cwd);
    await context.machine?.repository(repository);
    await services.loadConfig(repository);
    const phase = new WorktreeReadPhase(repository);
    // Listing never reads ignored files: large ignored folders made every run slow.
    const trees = await services.listWorktrees(repository, { phase, includeIgnored: false });
    if (trees.length === 0 && !context.machine) {
      context.io.stdout("No worktrees found.\n");
      return;
    }
    const sorted = [...trees].sort((a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Saved base reads start Git, and on Windows each record check starts PowerShell,
    // so rows read their metadata a few at a time, like statuses.
    const rows = await mapWithLimit(sorted, WORKTREE_INSPECTION_LIMIT, async tree => {
      const base = await services.readBaseAssociation(repository, tree, phase);
      const issue = await services.readIssueLink(repository, tree, phase);
      const warnings = [
        ...(base.kind === "invalid"
          ? [`warning: Cannot read base association for ${display(tree.path)} (${base.reason}); Git worktree remains listed.\n`] : []),
        ...(issue.kind === "invalid"
          ? [`warning: Cannot read issue link for ${display(tree.path)} (${issue.reason}); Git worktree remains listed.\n`] : []),
      ];
      return {
        entry: { worktree: tree, base, issue },
        warnings,
        cells: [
          tree.isPrimary ? "primary" : "linked",
          tree.branch === null ? "(detached HEAD)" : display(tree.branch),
          base.kind === "assigned" ? display(base.ref.replace(/^refs\/remotes\//u, ""))
            : base.kind === "commit" ? base.commit.slice(0, 12) : base.kind === "unassigned" ? "-" : "?",
          statusSummary(tree),
          display(tree.path),
        ],
      };
    });
    if (context.machine) {
      await context.machine.inventory(rows.map(row => row.entry));
    }
    for (const row of rows) {
      for (const warning of row.warnings) context.io.stderr(warning);
    }
    if (!context.machine) context.io.stdout(alignedRows(["WORKTREE", "BRANCH", "BASE", "STATUS", "PATH"], rows.map(row => row.cells)));
  };
}
