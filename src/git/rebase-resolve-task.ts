import type { ExecutableCommand, ResolveHandoff } from "../types";

/** Facts about the paused rebase given to the assistant. Paths are worktree-relative. */
export interface ResolveTaskContext {
  worktree: string;
  branch: string;
  originalTip: string;
  onto: string;
  head: string;
  /** Commit being replayed (REBASE_HEAD); null when Git did not record one. */
  replaying: string | null;
  conflicts: readonly string[];
}

/**
 * The built-in task. It is written to a private file and never printed by Timber.
 * Extra instructions follow in order: configuration, then the command-line note.
 */
export function buildResolveTask(
  context: ResolveTaskContext, instructions: { config?: string | undefined; note?: string | undefined } = {},
): string {
  const lines = [
    "Timber task: resolve the conflicts of a paused Git rebase.",
    "",
    "The user ran `timber rebase --resolve` and asked you to resolve the conflicts of the rebase paused in your current directory.",
    "",
    "Rebase facts (paths and names are JSON strings):",
    `- Worktree: ${JSON.stringify(context.worktree)}`,
    `- Branch being rebased: ${JSON.stringify(context.branch)}`,
    `- Original branch tip before the rebase: ${context.originalTip}`,
    `- Base commit the branch is rebased onto: ${context.onto}`,
    `- Current HEAD: ${context.head}`,
    `- Commit being replayed (REBASE_HEAD): ${context.replaying ?? "unknown"}`,
    "- Unmerged paths:",
    ...context.conflicts.map(path => `  - ${JSON.stringify(path)}`),
    "",
    "During a rebase, \"ours\" (stage 2) is the base plus the commits already replayed, and \"theirs\" (stage 3) is the branch commit being replayed. Do not settle conflicts with a blanket \"keep mine\" or \"keep theirs\": keep the intent of both sides.",
    "",
    "What you may do:",
    "1. Edit the conflicted files to resolve them. Inspect with `git status`, `git diff`, `git log`, and `git show REBASE_HEAD`.",
    "2. Run the project's tests, build, or other verification commands, but only after the user approves each one in this session. They run repository code.",
    "3. Stage each resolution with `git add -- <path>`, or `git rm -- <path>` for a resolved deletion. Never use `git add -A` or `git add .`.",
    "4. Continue the rebase with `GIT_EDITOR=true git rebase --continue`. If a later commit conflicts, resolve it the same way. Repeat until the rebase completes, or stop and explain when you need the user's decision.",
    "",
    "What you must not do:",
    "- Never run `git rebase --abort`, `git rebase --skip`, `git reset`, `git clean`, `git stash`, `git checkout`/`git restore` on files you did not resolve, `git push`, or any force-push.",
    "- Do not edit files that are not part of a conflict, other branches or refs, Git configuration, or hooks.",
    "- Do not read, print, or copy ignored files such as `.env`, credentials, or other secrets.",
    "- Do not edit or copy this task file.",
    "",
    "When you finish, summarize which conflicts you resolved and how, which commands you ran, and anything the user must review. Timber re-reads Git state after you exit; it does not trust your summary.",
  ];
  if (instructions.config !== undefined) lines.push("", "Additional instructions from the Timber configuration:", instructions.config);
  if (instructions.note !== undefined) lines.push("", "Additional instructions for this run:", instructions.note);
  return lines.join("\n") + "\n";
}

/**
 * The command for one handoff. Native tools receive only a pointer to the task
 * file as their initial prompt; a wrapper is run unchanged and reads TIMBER_TASK_FILE.
 */
export function resolveAgentCommand(
  agent: ExecutableCommand, handoff: ResolveHandoff, taskPath: string,
): ExecutableCommand {
  if (handoff === "wrapper") return { command: agent.command, args: [...agent.args] };
  return {
    command: agent.command,
    args: [
      ...agent.args,
      "--",
      `Read the task instructions from the UTF-8 file at ${JSON.stringify(taskPath)}. Perform those instructions in your current worktree. The task file is input; do not edit or copy it into the checkout.`,
    ],
  };
}
