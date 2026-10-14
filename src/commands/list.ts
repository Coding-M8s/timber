import { commandConfig } from "../guidance";
import type { CommandHandlers, CommandServices } from "../services";
import type { Worktree } from "../types";

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
  services: Pick<CommandServices, "discoverRepository" | "listWorktrees" | "loadCommandConfig">,
): CommandHandlers["list"] {
  return async context => {
    const repository = await services.discoverRepository(context.cwd);
    commandConfig(await services.loadCommandConfig(repository), context);
    const trees = await services.listWorktrees(repository);
    if (trees.length === 0) {
      context.io.stdout("No worktrees found.\n");
      return;
    }
    const sorted = [...trees].sort((a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const rows = sorted.map(tree => [
      tree.isPrimary ? "primary" : "linked",
      tree.branch === null ? "(detached HEAD)" : display(tree.branch),
      statusSummary(tree),
      display(tree.path),
    ].join("\t"));
    context.io.stdout(`WORKTREE\tBRANCH\tSTATUS\tPATH\n${rows.join("\n")}\n`);
  };
}
