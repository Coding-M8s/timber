import { createHash } from "node:crypto";
import { lstat, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { execa } from "execa";
import { backupSettings } from "../backup/retention";
import { FormattedError, jsonDisplay, safeDisplay, shellQuoteForDisplay } from "../display";
import { samePath } from "../platform/paths";
import type { CommandContext, CommandServices } from "../services";
import type { AgentResult, RepositoryConfig, RepositoryContext, ResolveHandoff, Worktree, WorktreeInventory } from "../types";
import { gitOperation } from "./operations";
import { createRebaseReport, rebaseGitEnvironment, recovery, runOwnedGit, type OwnedGitResult } from "./rebase";
import { buildResolveTask, resolveAgentCommand } from "./rebase-resolve-task";
import { assertWorktreeIdentity, listWorktreeInventory } from "./worktrees";

export type ResolveServices = Pick<CommandServices, "rebaseWorktree" | "createBackup" | "launchAgent">;

export interface ResolveOptions {
  base?: string;
  /** Per-invocation text appended after configured instructions. */
  note?: string;
}

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const taskFileName = "timber-rebase-resolve-task.txt";

/** The assistant and the continue prompt need the invoking terminal; checked before any Git change. */
export function assertResolveTerminal(context: CommandContext): void {
  if (context.interactive !== true || !context.ask) {
    throw new Error("--resolve needs an interactive terminal (stdin and stdout) with CI disabled. Plain timber rebase works without one.");
  }
}

/** Configured assistant and explicit handoff; checked before any Git change. Agent `enabled` is irrelevant. */
export function resolveHandoff(config: RepositoryConfig): ResolveHandoff {
  if (config.agent === null) {
    throw new Error("--resolve needs a configured [agent]. Run timber setup in this repository, or timber setup --global for machine defaults.");
  }
  if (config.agent.resolveHandoff === undefined) {
    throw new Error("--resolve needs resolve_handoff in [agent] (codex, claude, cursor or wrapper); Timber never guesses it from the executable. In timber setup, choose the Rebase --resolve section.");
  }
  return config.agent.resolveHandoff;
}

async function git(cwd: string, args: readonly string[]) {
  try {
    return await execa("git", [...args], { cwd, stdin: "ignore", reject: false, env: rebaseGitEnvironment, stripFinalNewline: false });
  } catch {
    throw new Error("Could not run Git to inspect the paused rebase.");
  }
}

async function output(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) throw new Error("Git could not inspect the paused rebase.");
  return result.stdout.replace(/\n$/u, "");
}

async function optionalFile(path: string): Promise<string | null> {
  try { return (await readFile(path, "utf8")).replace(/\n$/u, ""); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Cannot read the paused rebase state.");
  }
}

/** What Timber compares before and after the assistant runs. */
interface ResolveState {
  operation: string | null;
  head: string | null;
  /** `refs/heads/<branch>` when HEAD is attached. */
  symbolic: string | null;
  /** Current rebase step; changes when the rebase advances. */
  step: string | null;
  unmerged: string[];
  /** Porcelain v2 status line (without the path) per path. */
  entries: Map<string, string>;
  refs: Map<string, string>;
}

/** Content identity of one worktree path; never follows symlinks. */
async function fingerprint(path: string): Promise<string> {
  let info;
  try { info = await lstat(path); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"; }
  try {
    if (info.isSymbolicLink()) return "link:" + createHash("sha256").update(await readlink(path)).digest("hex");
    if (info.isFile()) return `file:${info.mode & 0o777}:` + createHash("sha256").update(await readFile(path)).digest("hex");
  } catch { return "unreadable"; }
  return info.isDirectory() ? "directory" : "other";
}

function parseStatus(raw: string): { entries: Map<string, string>; unmerged: string[] } {
  const entries = new Map<string, string>();
  const unmerged: string[] = [];
  for (const record of raw.split("\0").filter(Boolean)) {
    const kind = record[0];
    // Field counts before the path, per git-status porcelain v2 (renames disabled).
    const fields = kind === "1" ? 8 : kind === "u" ? 10 : kind === "?" || kind === "!" ? 1 : -1;
    if (fields < 0) throw new Error("Cannot parse Git status for the paused rebase.");
    const parts = record.split(" ");
    const path = parts.slice(fields).join(" ");
    entries.set(path, parts.slice(0, fields).join(" "));
    if (kind === "u") unmerged.push(path);
  }
  return { entries, unmerged };
}

async function readState(path: string, gitDirectory: string, branch: string): Promise<ResolveState> {
  const operation = await gitOperation(path);
  const head = await git(path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const symbolic = await git(path, ["symbolic-ref", "--quiet", "HEAD"]);
  const status = parseStatus(await output(path, ["-c", "core.quotePath=false", "status", "--porcelain=v2", "-z",
    "--untracked-files=all", "--no-renames", "--ignore-submodules=none"]));
  // Status lines carry no worktree hash; add one so repeated edits to a dirty path are seen.
  for (const [entry, line] of status.entries) status.entries.set(entry, `${line} ${await fingerprint(join(path, entry))}`);
  const refs = new Map<string, string>();
  for (const line of (await output(path, ["for-each-ref", "--format=%(objectname) %(refname)"])).split("\n").filter(Boolean)) {
    const space = line.indexOf(" ");
    const ref = line.slice(space + 1);
    // The rebased branch moves only on completion; backups are Timber's own refs.
    if (ref === `refs/heads/${branch}` || ref.startsWith("refs/timber/backups/")) continue;
    refs.set(ref, line.slice(0, space));
  }
  return {
    operation,
    head: head.exitCode === 0 ? head.stdout.trim() : null,
    symbolic: symbolic.exitCode === 0 ? symbolic.stdout.trim() : null,
    step: operation === "rebase" ? await optionalFile(join(gitDirectory, "rebase-merge", "msgnum")) : null,
    unmerged: status.unmerged,
    entries: status.entries,
    refs,
  };
}

function sameStep(before: ResolveState, after: ResolveState): boolean {
  return after.operation === "rebase" && after.head === before.head && after.step === before.step;
}

async function completed(path: string, state: ResolveState, branch: string, onto: string): Promise<boolean> {
  if (state.operation !== null || state.symbolic !== `refs/heads/${branch}` || state.head === null) return false;
  return (await git(path, ["merge-base", "--is-ancestor", onto, state.head])).exitCode === 0;
}

function list(io: CommandContext["io"], heading: string, paths: readonly string[]): void {
  if (!paths.length) return;
  io.stderr(`${heading}\n`);
  for (const path of paths) io.stderr(`  ${jsonDisplay(path)}\n`);
}

/** Paths and refs that changed outside the offered conflicts. */
function reportChanges(io: CommandContext["io"], before: ResolveState, after: ResolveState, backup: string): void {
  const conflicts = new Set(before.unmerged);
  let unexpected: string[];
  if (sameStep(before, after)) {
    const changed = [...new Set([...before.entries.keys(), ...after.entries.keys()])]
      .filter(path => before.entries.get(path) !== after.entries.get(path)).sort();
    const resolved = changed.filter(path => conflicts.has(path));
    if (resolved.length) {
      io.stdout(`Changed conflict paths:\n${resolved.map(path => `  ${jsonDisplay(path)}\n`).join("")}`);
    }
    unexpected = changed.filter(path => !conflicts.has(path));
  } else if (after.operation === null) {
    // A finished rebase leaves a clean tree, so anything still dirty came from the session.
    unexpected = [...after.entries.keys()].sort();
  } else {
    // Each replayed commit rewrites files, so only new untracked files are attributable.
    unexpected = [...after.entries].filter(([path, line]) => line.startsWith("? ") && !before.entries.get(path)?.startsWith("? ")
      && !conflicts.has(path)).map(([path]) => path).sort();
  }
  const refs = [...new Set([...before.refs.keys(), ...after.refs.keys()])]
    .filter(ref => before.refs.get(ref) !== after.refs.get(ref)).sort();
  if (unexpected.length || refs.length) {
    io.stderr("warning: The assistant session changed things outside the conflicts Timber offered.\n");
    list(io, "Paths outside the conflict set:", unexpected);
    list(io, "Refs that changed while the assistant ran (background fetches can also move refs):", refs);
    io.stderr(`Review them before continuing. Recovery backup: ${backup} (timber backup restore ${backup} <new-directory>).\n`);
  }
}

function agentOutcome(result: AgentResult): { code: number; text: string } {
  if (result.kind === "failed") {
    return { code: 1, text: "Could not start the configured assistant. Check the [agent] command and PATH." };
  }
  if (result.kind === "skipped") return { code: 1, text: "The assistant was not started." };
  if (result.signal) return { code: result.exitCode, text: `The assistant was interrupted by ${result.signal}.` };
  if (result.exitCode !== 0) return { code: result.exitCode, text: `The assistant exited with status ${result.exitCode}.` };
  return { code: 0, text: "The assistant session ended." };
}

/** Select attach or a new rebase, then hand the first conflict to the assistant. */
export async function resolveRebase(
  services: ResolveServices, repository: RepositoryContext, selected: Worktree, config: RepositoryConfig,
  handoff: ResolveHandoff, options: ResolveOptions, context: CommandContext,
): Promise<number> {
  const io = context.io;
  const operation = await gitOperation(selected.path);
  if (operation === null) {
    const report = createRebaseReport();
    const status = await services.rebaseWorktree(repository, selected, config, options.base, io, report, { assisted: true });
    if (report.result !== "conflicts") return status;
  } else if (operation !== "rebase") {
    throw new FormattedError(`An existing ${operation} operation is in progress at ${safeDisplay(selected.path)}. --resolve attaches only to a paused merge-backend rebase (as timber rebase starts); use Git's native continue/abort commands for this operation.`);
  } else if (options.base !== undefined) {
    throw new Error("--base cannot be used when attaching to a paused rebase; the base was chosen when the rebase started. Rerun without --base.");
  }
  return assist(services, repository, selected.path, selected.branch, config, handoff, options, context);
}

async function assist(
  services: ResolveServices, repository: RepositoryContext, path: string, selectedBranch: string | null,
  config: RepositoryConfig, handoff: ResolveHandoff, options: ResolveOptions, context: CommandContext,
): Promise<number> {
  const io = context.io;
  const agent = config.agent!;
  const gitDirectory = await output(path, ["rev-parse", "--absolute-git-dir"]);
  const rebaseDirectory = join(gitDirectory, "rebase-merge");
  const [headName, originalTip, onto] = await Promise.all(["head-name", "orig-head", "onto"]
    .map(name => optionalFile(join(rebaseDirectory, name))));
  if (!headName?.startsWith("refs/heads/") || !originalTip || !oid.test(originalTip) || !onto || !oid.test(onto)) {
    throw new FormattedError(`Cannot identify the paused rebase's branch and commits; the assistant was not started.\n${recovery(path)}`);
  }
  const branch = headName.slice("refs/heads/".length);
  if (selectedBranch !== null && selectedBranch !== branch) throw new Error("The paused rebase belongs to another branch; the assistant was not started.");
  const trees = await listWorktreeInventory(repository);
  const matches = trees.filter(tree => samePath(tree.path, path));
  if (matches.length !== 1 || matches[0]!.prunable !== null || matches[0]!.locked !== null) {
    throw new Error("Selected worktree is no longer uniquely registered, or is stale or locked; the assistant was not started.");
  }
  if (trees.some(tree => !samePath(tree.path, path) && tree.branch === branch)) {
    throw new Error("The rebased branch is checked out in another worktree; the assistant was not started.");
  }
  const inventory: WorktreeInventory = matches[0]!;
  await assertWorktreeIdentity(repository, inventory);
  const before = await readState(path, gitDirectory, branch);
  if (before.operation !== "rebase" || before.head === null) {
    throw new Error("The rebase is no longer paused; the assistant was not started.");
  }
  if (!before.unmerged.length) {
    io.stderr(`error: The paused rebase has no unmerged paths, so there is nothing for the assistant to resolve. Review the staged changes yourself.\n${recovery(path)}\n`);
    return 1;
  }
  const worktree: Worktree = { ...inventory, pathExists: true, status: { kind: "unknown", reason: "Not inspected" } };

  // A verified recovery backup comes before any assistant session.
  const backupReport: { id: string | null } = { id: null };
  let backupFailure: string | null = null;
  try {
    const status = await services.createBackup(repository, worktree, io,
      { keep: false, settings: backupSettings(config), ask: context.ask, pausedRebaseBranch: branch, report: backupReport });
    if (status === 0 && backupReport.id === null) backupFailure = "The backup was cancelled.";
    else if (status !== 0 || backupReport.id === null) backupFailure = "The backup command did not finish.";
  } catch (error) {
    backupFailure = error instanceof Error ? error.message : "The backup failed.";
  }
  if (backupFailure !== null) {
    io.stderr(`error: ${backupFailure}\nCould not create the recovery backup, so the assistant was not started. The rebase is still paused at ${safeDisplay(path)}.\n${recovery(path)}\n`);
    return 1;
  }
  const backup = backupReport.id!;
  const checked = await readState(path, gitDirectory, branch);
  if (!sameStep(before, checked) || checked.unmerged.join("\0") !== before.unmerged.join("\0")) {
    io.stderr(`error: The paused rebase changed while the backup was made, so the assistant was not started. Recovery backup: ${backup}.\n${recovery(path)}\n`);
    return 1;
  }

  const replaying = await git(path, ["rev-parse", "--verify", "--quiet", "REBASE_HEAD^{commit}"]);
  const task = buildResolveTask({
    worktree: path, branch, originalTip, onto, head: before.head,
    replaying: replaying.exitCode === 0 ? replaying.stdout.trim() : null, conflicts: before.unmerged,
  }, { config: agent.resolveInstructions, note: options.note });
  const taskPath = join(gitDirectory, taskFileName);
  let result: AgentResult;
  try {
    await rm(taskPath, { force: true });
    try { await writeFile(taskPath, task, { mode: 0o600, flag: "wx" }); }
    catch { throw new Error("Could not write the private task file; the assistant was not started."); }
    io.stdout([
      "AI assistance requested with --resolve.",
      `Assistant: ${safeDisplay(basename(agent.command))} (handoff: ${handoff}). It runs in this terminal with your permissions.`,
      "Timber tells it to change only the conflicts, but cannot enforce what it reads, runs or changes.",
      `Branch: ${safeDisplay(branch)}. Original branch tip: ${originalTip}.`,
      `Recovery backup: ${backup}. It holds files only, including ignored files; staging and rebase state are not captured.`,
      "",
    ].join("\n"));
    result = await services.launchAgent(worktree, resolveAgentCommand(agent, handoff, taskPath), {
      TIMBER_TASK_FILE: taskPath, TIMBER_WORKTREE: path, TIMBER_BRANCH: branch,
      TIMBER_WORKFLOW: undefined, TIMBER_TASK_ID: undefined,
    });
  } finally {
    await rm(taskPath, { force: true }).catch(() => {});
  }
  const agentResult = agentOutcome(result);
  return afterSession(path, gitDirectory, branch, onto, originalTip, backup, before, agentResult, context);
}

async function afterSession(
  path: string, gitDirectory: string, branch: string, onto: string, originalTip: string, backup: string,
  before: ResolveState, agent: { code: number; text: string }, context: CommandContext,
): Promise<number> {
  const io = context.io;
  (agent.code === 0 ? io.stdout : io.stderr)(`${agent.text}\n`);
  let after: ResolveState;
  try { after = await readState(path, gitDirectory, branch); }
  catch {
    io.stderr(`error: Cannot inspect Git state after the assistant session. Inspect it with: git -C ${shellQuoteForDisplay(path)} status\nRecovery backup: ${backup}. Original branch tip: ${originalTip}.\n`);
    return agent.code || 1;
  }
  reportChanges(io, before, after, backup);
  const failed = () => agent.code || 1;
  if (await completed(path, after, branch, onto)) return finished(io, path, onto, originalTip, agent.code);
  if (after.operation !== null && after.operation !== "rebase") {
    io.stderr(`error: The rebase is no longer paused, and a ${after.operation} operation is now in progress. Finish or abort it with Git's native commands.\nRecovery backup: ${backup}. Original branch tip: ${originalTip}.\n`);
    return failed();
  }
  if (after.operation !== "rebase") {
    io.stderr(`error: No rebase is in progress and branch ${safeDisplay(branch)} is not rebased onto ${onto}. The rebase may have been aborted. Inspect with git status and git reflog.\nRecovery backup: ${backup}. Original branch tip: ${originalTip}.\n`);
    return failed();
  }
  if (after.unmerged.length) {
    io.stderr("error: The rebase is still paused with unmerged paths:\n");
    for (const conflict of after.unmerged) io.stderr(`  ${jsonDisplay(conflict)}\n`);
    io.stderr(`Resolve and stage them, or rerun timber rebase --resolve to ask the assistant again.\n${recovery(path)}\n`);
    return failed();
  }
  io.stdout(`The rebase is still paused with every conflict staged. Review the result first: git -C ${shellQuoteForDisplay(path)} diff --cached\n`);
  const answer = await context.ask!("Continue the rebase now? Type y and press Enter to continue [y/N] ");
  if (answer !== "y" && answer !== "Y") {
    io.stderr(`The rebase is still paused; nothing was continued.\n${recovery(path)}\n`);
    return failed();
  }
  let continued: OwnedGitResult;
  try { continued = await runOwnedGit(path, ["rebase", "--continue"]); }
  catch {
    io.stderr(`error: Git rebase --continue could not start or finish. No automatic abort or reset was attempted.\n${recovery(path)}\n`);
    return failed();
  }
  let final: ResolveState;
  try { final = await readState(path, gitDirectory, branch); }
  catch {
    io.stderr(`error: Cannot inspect Git state after continuing. Inspect it with: git -C ${shellQuoteForDisplay(path)} status\n`);
    return failed();
  }
  if (continued.exitCode === 0 && await completed(path, final, branch, onto)) return finished(io, path, onto, originalTip, agent.code);
  if (final.operation === "rebase" && final.unmerged.length) {
    io.stderr("error: A later commit conflicts. The rebase is paused again with unmerged paths:\n");
    for (const conflict of final.unmerged) io.stderr(`  ${jsonDisplay(conflict)}\n`);
    io.stderr(`Resolve them yourself, or rerun timber rebase --resolve to ask the assistant again.\n${recovery(path)}\n`);
    return failed();
  }
  const interrupted = continued.signal ?? continued.requestedSignal;
  io.stderr(`error: ${interrupted ? `git rebase --continue was interrupted by ${interrupted}` : continued.exitCode === 0 ? "git rebase --continue finished, but the branch is not rebased onto the base" : "git rebase --continue failed (for example a hook rejected the commit)"}. Workspace retained; no automatic abort or reset.\n${final.operation === "rebase" ? recovery(path) : "Inspect the worktree with git status."}\n`);
  return failed();
}

async function finished(io: CommandContext["io"], path: string, onto: string, originalTip: string, agentCode: number): Promise<number> {
  // A skip or reset can look complete; fewer commits than the branch had is worth a warning.
  const count = async (range: string) => {
    const result = await git(path, ["rev-list", "--count", range]);
    return result.exitCode === 0 ? Number(result.stdout.trim()) : null;
  };
  const base = await git(path, ["merge-base", onto, originalTip]);
  const before = base.exitCode === 0 ? await count(`${base.stdout.trim()}..${originalTip}`) : null;
  const after = await count(`${onto}..HEAD`);
  if (before !== null && after !== null && after < before) {
    io.stderr(`warning: The rebased branch has ${after} commit${after === 1 ? "" : "s"} on the base; it had ${before}. Commits already in the base are dropped by Git, but a skipped commit is lost from the branch. Check with the range-diff below; the original tip stays in the reflog.\n`);
  }
  io.stdout(`Rebase completed. Review the rewritten commits before publishing: git -C ${shellQuoteForDisplay(path)} range-diff ${originalTip}...HEAD\n`);
  if (agentCode !== 0) io.stderr("error: The rebase completed, but the assistant did not exit cleanly; review its changes.\n");
  return agentCode;
}
