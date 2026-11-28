import { createIgnoredPathIndex } from "./ignored-path-index";
import { WorktreeReadPhase } from "./worktree-read-phase";
import { samePath } from "../platform/paths";
import { cancelGitTree, childExitCode } from "../platform/signals";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { constants } from "node:os";
import { execa } from "execa";
import { bashAnsiCQuote, shellQuoteForDisplay, jsonDisplay, safeDisplay, FormattedError } from "../display";
import type { CommandIO } from "../services";
import type { OpenTarget, RepositoryConfig, RepositoryContext, ResolveOpenTargetOptions, Resolution, Worktree } from "../types";
import { inspectWorktree, listWorktreeInventory } from "./worktrees";
import { gitOperation } from "./operations";
import { readBaseAssociation, writeBaseAssociation } from "./base-metadata";
import { resolveOpenTarget } from "./open-target";
import { isFullCommitHash, refuseAbbreviatedHash, verifyCommitBase } from "./commit-base";
import { gitCommand } from "../platform/git-command";

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface RebaseRunOptions {
  /** `--resolve`: report a verified conflict pause without manual guidance; the caller continues. */
  assisted?: boolean;
}

export type RebaseResult = "rebased" | "up-to-date" | "conflicts" | "refused" | "failed";

/** Observed facts for the machine record; filled in as each one is verified. */
export interface RebaseReport {
  result: RebaseResult;
  /** Canonical base ref that was selected. */
  base: string | null;
  /** Pinned commit the branch was (or would have been) rebased onto. */
  baseCommit: string | null;
  /** Verified branch tip before the rebase. */
  originalTip: string | null;
  /** Worktree-relative unmerged paths; empty unless result is "conflicts". */
  conflicts: string[];
  /** True only after the base association was actually written. */
  baseSaved: boolean;
}

/** Until a rebase proves otherwise, a stop is a refusal that changed nothing. */
export function createRebaseReport(): RebaseReport {
  return { result: "refused", base: null, baseCommit: null, originalTip: null, conflicts: [], baseSaved: false };
}

// An operation that broke (network, Git, hook, metadata), unlike a safety refusal.
const operationFailures = new WeakSet<Error>();
function operationFailure<E extends Error>(error: E): E {
  operationFailures.add(error);
  return error;
}

export const rebaseGitEnvironment = {
  GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "false", SSH_ASKPASS: "false", GCM_INTERACTIVE: "Never",
  GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_OPTIONAL_LOCKS: "0",
};

async function git(cwd: string, args: readonly string[], timeout?: number) {
  try {
    return await execa(gitCommand(), [...args], {
      cwd, stdin: "ignore", reject: false, env: rebaseGitEnvironment, stripFinalNewline: false,
      ...(timeout === undefined ? {} : { timeout }),
    });
  } catch {
    throw operationFailure(new Error("Could not start or complete Git for rebase; check Git installation, repository access and network availability. No automatic recovery was attempted."));
  }
}

async function output(cwd: string, args: readonly string[], timeout?: number): Promise<string> {
  const result = await git(cwd, args, timeout);
  if (result.exitCode !== 0) throw new Error("Git could not verify rebase inputs; check repository access and remote/base selection.");
  return result.stdout.replace(/\n$/, "");
}

export interface OwnedGitResult {
  exitCode: number | undefined;
  signal: NodeJS.Signals | undefined;
  /** Signal Timber received and forwarded while Git ran. */
  requestedSignal: NodeJS.Signals | null;
}

/**
 * Await one owned noninteractive Git process group with closed stdin and disabled
 * editors. Cancellation signals that group, including Git hook descendants.
 * Throws only when Git could not be started or awaited.
 */
export async function runOwnedGit(cwd: string, args: readonly string[]): Promise<OwnedGitResult> {
  let requestedSignal: NodeJS.Signals | null = null;
  const child = execa(gitCommand(), [...args], {
    cwd, stdin: "ignore", reject: false, env: rebaseGitEnvironment, detached: process.platform !== "win32",
  });
  // POSIX owns a process group. Windows shares the console for Ctrl-C and
  // uses an explicitly cancelled child tree for process-directed shutdown.
  let cancellation: Promise<void> | undefined;
  const forward = (signal: NodeJS.Signals) => {
    requestedSignal = signal;
    if (process.platform === "win32" && signal === "SIGINT" && process.stdin.isTTY) return;
    cancellation ??= cancelGitTree(child.pid, signal).catch(() => {});
  };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    const result = await child;
    return { exitCode: result.exitCode, signal: result.signal, requestedSignal };
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); await cancellation;
  }
}

/** Native continue/abort guidance for a paused rebase in the given worktree. */
export function recovery(path: string): string {
  const quoted = shellQuoteForDisplay(path);
  return `Inspect Git state. Resolve and stage conflicts, then run: git -C ${quoted} rebase --continue\nContinuing can reveal conflicts in later commits. To restore the original branch state explicitly: git -C ${quoted} rebase --abort`;
}

async function assertIdle(path: string): Promise<void> {
  const operation = await gitOperation(path);
  if (operation !== null) {
    throw new FormattedError(`An existing ${operation} operation is in progress at ${safeDisplay(path)}; finish or abort it explicitly before retrying.\n${operation.includes("rebase") ? recovery(path) : "Use Git's native continue/abort commands for that operation."}`);
  }
}

async function preflight(
  repository: RepositoryContext, selected: Worktree, gitDirectory?: string, phase = new WorktreeReadPhase(repository),
): Promise<Worktree> {
  if (!isAbsolute(selected.path)) throw new Error("Rebase requires an absolute registered worktree path.");
  const trees = await listWorktreeInventory(repository);
  const matches = trees.filter(tree => samePath(tree.path, selected.path));
  if (matches.length !== 1) throw new Error("Selected worktree is no longer uniquely registered.");
  const tree = await inspectWorktree(repository, matches[0]!, phase);
  if (!tree.pathExists || tree.prunable !== null || tree.locked !== null) throw new Error("Selected worktree is missing, stale or locked; repair it explicitly before rebase.");
  await phase.gitDirectory(tree);
  // Paused rebase usually has detached HEAD; explain recovery before detached refusal.
  await assertIdle(tree.path);
  if (tree.branch === null || tree.head === null) throw new Error("Cannot rebase a detached or unborn worktree; check out an existing branch explicitly.");
  if (trees.some(other => !samePath(other.path, tree.path) && other.branch === tree.branch)) throw new Error("Selected branch is checked out in another worktree; rebase would change its shared branch ref.");
  if (tree.branch !== selected.branch || tree.head !== selected.head) throw new Error("Selected worktree branch or original tip changed; rerun timber rebase.");
  const actualGitDirectory = await phase.gitDirectory(tree);
  if (gitDirectory !== undefined && !samePath(actualGitDirectory, gitDirectory)) throw new Error("Selected worktree Git identity changed; rebase was not started.");
  if (await output(tree.path, ["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${tree.branch}`
    || await output(tree.path, ["rev-parse", "--verify", "HEAD^{commit}"]) !== selected.head) {
    throw new Error("Selected worktree branch or original tip changed; rebase was not started.");
  }
  if (tree.status.kind !== "known") throw new Error("Cannot verify worktree file status; rebase was not started.");
  if (tree.status.modified.length || tree.status.untracked.length) throw new Error("Rebase requires a clean index/worktree with no staged, unstaged, unmerged or untracked files; preserve them first.");
  return tree;
}

/** Command wording for base diagnostics shared by `rebase --base` and `base --set`. */
export interface BaseWording {
  /** Option that selects a replacement, such as "--base". */
  flag: string;
  /** What did not happen when discovery fails, such as "Rebase was not started." */
  stopped: string;
}
const rebaseWording: BaseWording = { flag: "--base", stopped: "Rebase was not started." };

/** True when a rebase or base check broke (network, Git, metadata) rather than refused. */
export function isOperationFailure(error: unknown): boolean {
  return error instanceof Error && operationFailures.has(error);
}

/**
 * Validate an explicit base with the same forms and checks as `rebase --base`, without fetching:
 * a full commit hash must name an existing commit, and an abbreviated one naming no branch is refused;
 * refs/heads/<branch> must be a direct existing local branch other than `targetBranch`;
 * other forms must name a live branch on the configured, sole or named remote.
 */
export async function selectBaseRef(
  repository: RepositoryContext, config: RepositoryConfig, input: string, cwd: string,
  targetBranch: string | null, wording: BaseWording,
): Promise<{ ref: string; commit: string; local: boolean }> {
  if (isFullCommitHash(input)) {
    const commit = await verifyCommitBase(cwd, input, wording.flag);
    return { ref: commit, commit, local: true };
  }
  await refuseAbbreviatedHash(cwd, input, wording.flag);
  if (input.startsWith("refs/heads/")) {
    if (targetBranch !== null && input === `refs/heads/${targetBranch}`) {
      throw new Error(`Cannot use the worktree's own branch as its base; select another branch with ${wording.flag}.`);
    }
    return { ref: input, commit: await localBase(cwd, input, wording), local: true };
  }
  const base = await remoteBase(repository, config, input, cwd, wording);
  return { ref: base.ref, commit: base.advertisedCommit, local: false };
}

async function remoteBase(
  repository: RepositoryContext, config: RepositoryConfig, explicit: string | undefined, cwd: string,
  wording: BaseWording = rebaseWording,
) {
  const input = explicit ?? config.baseBranch;
  const canonical = input?.startsWith("refs/remotes/") === true;
  const qualified = input === null ? undefined : [...repository.remotes].sort((a, b) => b.name.length - a.name.length)
    .find(remote => input.startsWith((canonical ? "refs/remotes/" : "") + remote.name + "/"));
  if (canonical && !qualified) throw new Error(`Saved remote base no longer exists; choose a replacement with ${wording.flag} <ref>.`);
  const remoteName = qualified?.name ?? config.remote ?? (repository.remotes.length === 1 ? repository.remotes[0]!.name : null);
  const remote = repository.remotes.find(candidate => candidate.name === remoteName);
  if (!remote) throw new Error(`Remote is missing or ambiguous; configure remote, use ${wording.flag} <remote/branch>, or use ${wording.flag} refs/heads/<branch> for a local base.`);
  const requested = qualified ? input!.slice(qualified.name.length + 1 + (canonical ? "refs/remotes/".length : 0)) : input;
  if (requested !== null) {
    const checked = await git(cwd, ["check-ref-format", `refs/heads/${requested}`]);
    if (requested === "HEAD" || checked.exitCode !== 0) throw new Error("Invalid remote base branch; use a plain branch or remote/branch.");
  }
  let advertisement: string;
  try { advertisement = await output(cwd, ["ls-remote", "--symref", "--", remote.name, "HEAD", "refs/heads/*"], 10_000); }
  catch { throw operationFailure(new Error(`Could not discover the live remote base; check authentication/network access. ${wording.stopped}`)); }
  const heads = new Map<string, string>();
  let defaultName: string | null = null;
  for (const line of advertisement.split("\n").filter(Boolean)) {
    const symbolic = /^ref: refs\/heads\/(.+)\tHEAD$/u.exec(line);
    if (symbolic) { defaultName = symbolic[1]!; continue; }
    const row = /^(\S+)\t(.+)$/u.exec(line);
    if (!row || !oid.test(row[1]!)) throw new Error("Cannot validate live remote branch advertisement.");
    if (row[2]!.startsWith("refs/heads/")) heads.set(row[2]!.slice(11), row[1]!);
  }
  const cachedDefault = remote.defaultBranchRef?.startsWith(`refs/remotes/${remote.name}/`)
    ? remote.defaultBranchRef.slice(`refs/remotes/${remote.name}/`.length) : null;
  const fallback = ["main", "master"].filter(name => heads.has(name));
  const name = requested ?? defaultName ?? cachedDefault ?? (fallback.length === 1 ? fallback[0]! : null);
  if (!name || !heads.has(name)) throw new Error(`Remote base is missing or ambiguous; use ${wording.flag} <remote/branch>.`);
  return { remote: remote.name, name, advertisedCommit: heads.get(name)!, ref: `refs/remotes/${remote.name}/${name}` };
}

async function preserveIgnored(tree: Worktree, base: string): Promise<void> {
  if (tree.status.kind !== "known" || !tree.status.ignored.length) return;
  const ignoredCollision = createIgnoredPathIndex(tree.status.ignored);
  const commits = (await output(tree.path, ["rev-list", `${base}..${tree.head}`])).split("\n").filter(Boolean);
  for (const commit of [base, ...commits]) {
    if (!oid.test(commit)) throw new Error("Cannot validate commits for ignored-file preservation.");
    const result = await git(tree.path, ["ls-tree", "-r", "--name-only", "-z", commit]);
    if (result.exitCode !== 0) throw new Error("Cannot verify ignored-file preservation; rebase was not started.");
    for (const tracked of result.stdout.split("\0").filter(Boolean)) {
      const ignoredPath = ignoredCollision(tracked);
      if (ignoredPath !== undefined) {
        throw new Error(`Rebase could overwrite ignored content at ${jsonDisplay(ignoredPath)}; move or preserve it elsewhere before retrying.`);
      }
    }
  }
}

async function localBase(cwd: string, ref: string, wording: BaseWording = rebaseWording): Promise<string> {
  const valid = await git(cwd, ["check-ref-format", ref]);
  const symbolic = await git(cwd, ["symbolic-ref", "--quiet", ref]);
  if (valid.exitCode !== 0 || symbolic.exitCode !== 1) {
    throw new Error(`Local base must be a valid direct branch ref; select refs/heads/<branch> with ${wording.flag}.`);
  }
  const result = await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const commit = result.stdout.trim();
  if (result.exitCode !== 0 || !oid.test(commit)) {
    throw new Error(`Local base is missing or invalid; choose a replacement with ${wording.flag} refs/heads/<branch>.`);
  }
  return commit;
}

/** Select a remembered/explicit base, fetching only remote bases. */
export async function rebaseWorktree(
  repository: RepositoryContext, selected: Worktree, config: RepositoryConfig,
  explicitBase: string | undefined, io: CommandIO, report: RebaseReport = createRebaseReport(),
  options: RebaseRunOptions = {},
): Promise<number> {
  try {
    return await rebaseSelected(repository, selected, config, explicitBase, io, report, options);
  } catch (error) {
    // A paused rebase stays "conflicts" even when saving its base failed.
    if (report.result === "refused" && error instanceof Error && operationFailures.has(error)) report.result = "failed";
    throw error;
  }
}

async function rebaseSelected(
  repository: RepositoryContext, selected: Worktree, config: RepositoryConfig,
  explicitBase: string | undefined, io: CommandIO, report: RebaseReport, options: RebaseRunOptions,
): Promise<number> {
  const phase = new WorktreeReadPhase(repository);
  await preflight(repository, selected, undefined, phase);
  report.originalTip = selected.head;
  const gitDirectory = await phase.gitDirectory(selected);
  const association = await readBaseAssociation(repository, selected, phase);
  if (association.kind === "invalid" && (association.reason !== "stale" || explicitBase === undefined)) {
    throw new Error("Cannot read saved base association; inspect the worktree's private Git metadata, then select a replacement with --base <ref>.");
  }
  const input = explicitBase
    ?? (association.kind === "assigned" ? association.ref : association.kind === "commit" ? association.commit : undefined);
  if (explicitBase !== undefined) await refuseAbbreviatedHash(selected.path, explicitBase, "--base");
  const pinned = input !== undefined && isFullCommitHash(input);
  const localRef = input?.startsWith("refs/heads/") ? input : null;
  if (localRef === `refs/heads/${selected.branch}`) throw new Error("Cannot use the target branch itself as its rebase base; select another branch with --base.");
  let ref: string, commit: string, label: string;
  if (pinned) {
    // A commit never moves, so there is nothing to fetch and no freshness warning.
    commit = await verifyCommitBase(selected.path, input, "--base");
    ref = commit;
    label = commit;
    report.base = ref;
  } else if (localRef !== null) {
    ref = localRef;
    commit = await localBase(selected.path, ref);
    label = ref;
    report.base = ref;
    io.stderr(`warning: Using local branch '${safeDisplay(ref.slice("refs/heads/".length))}' as the base. Timber will not fetch or pull it. Make sure it is up to date before rebasing.\n`);
  } else {
    const base = await remoteBase(repository, config, input, selected.path);
    ref = base.ref;
    label = base.remote + "/" + base.name;
    report.base = ref;
    await preflight(repository, selected, gitDirectory);
    const fetched = await git(selected.path, [
      "fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--no-recurse-submodules", "--refmap=", "--", base.remote,
      `refs/heads/${base.name}`,
    ], 10_000);
    if (fetched.exitCode !== 0) throw operationFailure(new Error("Remote base fetch failed; check branch existence/authentication/network access. Rebase was not started; no cached fallback was used."));
    commit = await output(selected.path, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    if (!oid.test(commit) || commit !== base.advertisedCommit) throw operationFailure(new Error("Fetched base moved or could not be validated; rebase was not started. Rerun to select the latest base."));
  }
  report.baseCommit = commit;
  async function revalidateLocal() {
    if (localRef !== null && await localBase(selected.path, localRef) !== commit) {
      throw new Error("Local base changed; rebase was not started. Retry to select its latest tip.");
    }
  }
  async function saveBase(paused: boolean) {
    try {
      if (!samePath(await output(selected.path, ["rev-parse", "--absolute-git-dir"]), gitDirectory)) throw new Error("Git identity changed");
      const branch = paused
        ? (await readFile(join(gitDirectory, "rebase-merge", "head-name"), "utf8")).trim()
        : await output(selected.path, ["symbolic-ref", "--quiet", "HEAD"]);
      if (branch !== `refs/heads/${selected.branch}`) throw new Error("Branch changed");
      await writeBaseAssociation(repository, selected, ref);
      report.baseSaved = true;
    } catch {
      throw operationFailure(new FormattedError(`Git rebase ${paused ? "paused with conflicts" : "completed (or was already up to date)"}, but the base association could not be saved. Workspace retained; inspect private Git metadata and after resolving any operation, retry with:\ntimber rebase --base ${shellQuoteForDisplay(ref)} -- ${shellQuoteForDisplay(selected.path)}\n${paused ? recovery(selected.path) : "No automatic reset or abort was attempted."}`));
    }
  }
  const baseLines = pinned ? `Commit base: ${commit}\n`
    : `${localRef === null ? "Remote" : "Local"} base: ${safeDisplay(label)}\n${localRef === null ? "Fetched" : "Local"} base commit: ${commit}\n`;
  io.stdout(`Worktree: ${safeDisplay(selected.path)}\nBranch: ${safeDisplay(selected.branch!)}\n${baseLines}Original branch tip: ${selected.head}\n`);
  const tree = await preflight(repository, selected, gitDirectory);
  await revalidateLocal();
  const contained = await git(selected.path, ["merge-base", "--is-ancestor", commit, selected.head!]);
  if (contained.exitCode === 0) { await revalidateLocal(); await saveBase(false); report.result = "up-to-date"; io.stdout("Already up to date.\n"); return 0; }
  if (contained.exitCode !== 1) throw new Error("Cannot verify base ancestry; rebase was not started. Fetch metadata may have changed.");
  await preserveIgnored(tree, commit);
  await preflight(repository, selected, gitDirectory);
  await revalidateLocal();
  let result: OwnedGitResult;
  try {
    result = await runOwnedGit(selected.path, ["-c", "rebase.autoStash=false", "-c", "rebase.updateRefs=false",
      "-c", "rebase.autoSquash=false", "-c", "rebase.abbreviateCommands=false",
      "rebase", "--no-autostash", "--no-update-refs", "--no-autosquash", "--merge", "--no-rebase-merges", "--empty=keep", "--no-fork-point", "--", commit]);
  } catch {
    throw operationFailure(new FormattedError(`Git rebase could not start or finish. Original branch tip: ${selected.head}. Workspace retained; no automatic abort/reset.\n${recovery(selected.path)}`));
  }
  const requestedSignal = result.requestedSignal;
  if (result.exitCode === 0) { await saveBase(false); report.result = "rebased"; io.stdout("Rebase completed (or already up to date).\n"); return 0; }
  let conflicts: string[] = [];
  try {
    const unmerged = await git(selected.path, ["diff", "--name-only", "--diff-filter=U", "-z"]);
    if (unmerged.exitCode === 0) conflicts = unmerged.stdout.split("\0").filter(Boolean);
  } catch { /* Recovery guidance still applies when inspection fails. */ }
  const status = childExitCode(result.exitCode, result.signal ?? (process.platform === "win32" ? requestedSignal : null));
  let operation: string | null;
  try { operation = await gitOperation(selected.path); } catch { operation = "unknown"; }
  if (options.assisted && conflicts.length && operation === "rebase" && !result.signal) {
    // The caller hands a verified pause to the assistant and owns recovery guidance.
    report.result = "conflicts";
    report.conflicts = conflicts;
    await saveBase(true);
    io.stdout(`Rebase paused with conflicts:\n${conflicts.map(path => `  ${jsonDisplay(path)}\n`).join("")}`);
    return status || 1;
  }
  io.stderr(`error: ${conflicts.length ? "Rebase paused with conflicts" : result.signal ? `Rebase interrupted by ${result.signal}` : "Git rebase failed (hook rejection or another non-conflict error)"}. Workspace retained at ${safeDisplay(selected.path)}; branch ${safeDisplay(selected.branch!)}, base ${safeDisplay(label)}, original tip ${selected.head}.\n`);
  for (const path of conflicts) io.stderr(`  ${jsonDisplay(path)}\n`);
  // Only a verified pause is "conflicts"; anything else nonzero is a failure.
  report.result = "failed";
  if (conflicts.length && operation === "rebase" && !result.signal) {
    report.result = "conflicts";
    report.conflicts = conflicts;
    await saveBase(true);
  }
  io.stderr(operation === null
    ? "No in-progress Git operation was found. Inspect the worktree with git status before retrying; no automatic abort/reset was attempted.\n"
    : recovery(selected.path) + "\n");
  return status || 1;
}

/** Git detaches HEAD during rebase; use its saved branch only for recovery lookup. */
export async function resolveRebaseTarget(
  repository: RepositoryContext, input: string, config: RepositoryConfig,
  options: Pick<ResolveOpenTargetOptions, "inspectStatus"> = {},
): Promise<Resolution<OpenTarget>> {
  // Selection is shared with backup, which never runs status because status can
  // execute repository clean filters. Only rebase's machine record asks for status;
  // otherwise selection stays inventory-only and preflight inspects afresh.
  const inspectStatus = options.inspectStatus === true;
  const resolution = await resolveOpenTarget(repository, input, config, { assertOpenable: false, inspectStatus });
  if (resolution.kind === "not-found" || (resolution.kind === "found" && resolution.value.kind === "worktree")) return resolution;
  const targets = resolution.kind === "found" ? [resolution.value] : resolution.candidates;
  const branchRefs = new Set(targets.flatMap(target => target.kind === "branch" && target.branch.kind === "local" ? [target.branch.ref] : []));
  if (!branchRefs.size) return resolution;
  const recovered = new Map<string, Worktree[]>();
  for (const inventory of await listWorktreeInventory(repository)) {
    if (inventory.branch !== null || inventory.prunable !== null) continue;
    const phase = new WorktreeReadPhase(repository);
    const tree = await inspectWorktree(repository, inventory, phase, inspectStatus);
    if (!tree.pathExists) continue;
    const directory = await phase.gitDirectory(tree);
    for (const state of ["rebase-merge", "rebase-apply"]) {
      let ref: string;
      try { ref = (await readFile(join(directory, state, "head-name"), "utf8")).replace(/\n$/, ""); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error("Cannot identify a paused rebase; use its absolute worktree path for recovery guidance.");
      }
      if (branchRefs.has(ref)) recovered.set(ref, [...recovered.get(ref) ?? [], tree]);
    }
  }
  const candidates = targets.flatMap<OpenTarget>(target => target.kind === "branch" && recovered.has(target.branch.ref)
    ? recovered.get(target.branch.ref)!.map(worktree => ({ kind: "worktree", worktree })) : [target]);
  return candidates.length === 1 ? { kind: "found", value: candidates[0]! } : { kind: "ambiguous", candidates };
}
