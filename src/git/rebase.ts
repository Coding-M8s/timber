import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { constants } from "node:os";
import { execa } from "execa";
import { bashAnsiCQuote, jsonDisplay, safeDisplay, FormattedError } from "../display";
import type { CommandIO } from "../services";
import type { OpenTarget, RepositoryConfig, RepositoryContext, Resolution, Worktree } from "../types";
import { assertWorktreeIdentity, listWorktrees } from "./worktrees";
import { gitOperation } from "./operations";
import { resolveOpenTarget } from "./open-target";

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const environment = {
  GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "false", SSH_ASKPASS: "false", GCM_INTERACTIVE: "Never",
  GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_OPTIONAL_LOCKS: "0",
};

async function git(cwd: string, args: readonly string[], timeout?: number) {
  try {
    return await execa("git", [...args], {
      cwd, stdin: "ignore", reject: false, env: environment, stripFinalNewline: false,
      ...(timeout === undefined ? {} : { timeout }),
    });
  } catch {
    throw new Error("Could not start or complete Git for rebase; check Git installation, repository access and network availability. No automatic recovery was attempted.");
  }
}

async function output(cwd: string, args: readonly string[], timeout?: number): Promise<string> {
  const result = await git(cwd, args, timeout);
  if (result.exitCode !== 0) throw new Error("Git could not verify rebase inputs; check repository access and remote/base selection.");
  return result.stdout.replace(/\n$/, "");
}

function recovery(path: string): string {
  const quoted = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(path)
    ? bashAnsiCQuote(path) : "'" + path.replaceAll("'", "'\\''") + "'";
  return `Inspect Git state. Resolve and stage conflicts, then run: git -C ${quoted} rebase --continue\nContinuing can reveal conflicts in later commits. To restore the original branch state explicitly: git -C ${quoted} rebase --abort`;
}

async function assertIdle(path: string): Promise<void> {
  const operation = await gitOperation(path);
  if (operation !== null) {
    throw new FormattedError(`An existing ${operation} operation is in progress at ${safeDisplay(path)}; finish or abort it explicitly before retrying.\n${operation.includes("rebase") ? recovery(path) : "Use Git's native continue/abort commands for that operation."}`);
  }
}

async function preflight(repository: RepositoryContext, selected: Worktree, gitDirectory?: string): Promise<Worktree> {
  if (!isAbsolute(selected.path)) throw new Error("Rebase requires an absolute registered worktree path.");
  const trees = await listWorktrees(repository);
  const matches = trees.filter(tree => resolve(tree.path) === resolve(selected.path));
  if (matches.length !== 1) throw new Error("Selected worktree is no longer uniquely registered.");
  const tree = matches[0]!;
  if (!tree.pathExists || tree.prunable !== null || tree.locked !== null) throw new Error("Selected worktree is missing, stale or locked; repair it explicitly before rebase.");
  await assertWorktreeIdentity(repository, tree);
  // Paused rebase usually has detached HEAD; explain recovery before detached refusal.
  await assertIdle(tree.path);
  if (tree.branch === null || tree.head === null) throw new Error("Cannot rebase a detached or unborn worktree; check out an existing branch explicitly.");
  if (trees.some(other => other.path !== tree.path && other.branch === tree.branch)) throw new Error("Selected branch is checked out in another worktree; rebase would change its shared branch ref.");
  if (tree.branch !== selected.branch || tree.head !== selected.head) throw new Error("Selected worktree branch or original tip changed; rerun timber rebase.");
  const actualGitDirectory = await output(tree.path, ["rev-parse", "--absolute-git-dir"]);
  if (gitDirectory !== undefined && actualGitDirectory !== gitDirectory) throw new Error("Selected worktree Git identity changed; rebase was not started.");
  if (await output(tree.path, ["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${tree.branch}`
    || await output(tree.path, ["rev-parse", "--verify", "HEAD^{commit}"]) !== selected.head) {
    throw new Error("Selected worktree branch or original tip changed; rebase was not started.");
  }
  if (tree.status.kind !== "known") throw new Error("Cannot verify worktree file status; rebase was not started.");
  if (tree.status.modified.length || tree.status.untracked.length) throw new Error("Rebase requires a clean index/worktree with no staged, unstaged, unmerged or untracked files; preserve them first.");
  return tree;
}

async function remoteBase(repository: RepositoryContext, config: RepositoryConfig, explicit: string | undefined, cwd: string) {
  const input = explicit ?? config.baseBranch;
  const qualified = input === null ? undefined : [...repository.remotes].sort((a, b) => b.name.length - a.name.length)
    .find(remote => input.startsWith(remote.name + "/"));
  const remoteName = qualified?.name ?? config.remote ?? (repository.remotes.length === 1 ? repository.remotes[0]!.name : null);
  const remote = repository.remotes.find(candidate => candidate.name === remoteName);
  if (!remote) throw new Error("Remote is missing or ambiguous; configure remote or use --base <remote/branch>.");
  const requested = qualified ? input!.slice(qualified.name.length + 1) : input;
  if (requested !== null) {
    const checked = await git(cwd, ["check-ref-format", `refs/heads/${requested}`]);
    if (requested === "HEAD" || checked.exitCode !== 0) throw new Error("Invalid remote base branch; use a plain branch or remote/branch.");
  }
  let advertisement: string;
  try { advertisement = await output(cwd, ["ls-remote", "--symref", "--", remote.name, "HEAD", "refs/heads/*"], 10_000); }
  catch { throw new Error("Could not discover the live remote base; check authentication/network access. Rebase was not started."); }
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
  if (!name || !heads.has(name)) throw new Error("Remote base is missing or ambiguous; use --base <remote/branch>.");
  return { remote: remote.name, name, advertisedCommit: heads.get(name)! };
}

async function preserveIgnored(tree: Worktree, base: string): Promise<void> {
  if (tree.status.kind !== "known" || !tree.status.ignored.length) return;
  const commits = (await output(tree.path, ["rev-list", `${base}..${tree.head}`])).split("\n").filter(Boolean);
  for (const commit of [base, ...commits]) {
    if (!oid.test(commit)) throw new Error("Cannot validate commits for ignored-file preservation.");
    const result = await git(tree.path, ["ls-tree", "-r", "--name-only", "-z", commit]);
    if (result.exitCode !== 0) throw new Error("Cannot verify ignored-file preservation; rebase was not started.");
    for (const tracked of result.stdout.split("\0").filter(Boolean)) {
      for (const ignoredPath of tree.status.ignored) {
        const ignored = ignoredPath.replace(/\/$/u, "");
        if (tracked === ignored || tracked.startsWith(ignored + "/") || ignored.startsWith(tracked + "/")) {
          throw new Error(`Rebase could overwrite ignored content at ${jsonDisplay(ignoredPath)}; move or preserve it elsewhere before retrying.`);
        }
      }
    }
  }
}

/** Fetch one remote base, then rebase only the verified selected worktree. */
export async function rebaseWorktree(
  repository: RepositoryContext, selected: Worktree, config: RepositoryConfig,
  explicitBase: string | undefined, io: CommandIO,
): Promise<number> {
  await preflight(repository, selected);
  const gitDirectory = await output(selected.path, ["rev-parse", "--absolute-git-dir"]);
  const base = await remoteBase(repository, config, explicitBase, selected.path);
  await preflight(repository, selected, gitDirectory);
  const fetched = await git(selected.path, [
    "fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--no-recurse-submodules", "--refmap=", "--", base.remote,
    `refs/heads/${base.name}`,
  ], 10_000);
  if (fetched.exitCode !== 0) throw new Error("Remote base fetch failed; check branch existence/authentication/network access. Rebase was not started; no cached fallback was used.");
  const commit = await output(selected.path, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
  if (!oid.test(commit) || commit !== base.advertisedCommit) throw new Error("Fetched base moved or could not be validated; rebase was not started. Rerun to select the latest base.");
  io.stdout(`Worktree: ${safeDisplay(selected.path)}\nBranch: ${safeDisplay(selected.branch!)}\nRemote base: ${safeDisplay(base.remote + "/" + base.name)}\nFetched base commit: ${commit}\nOriginal branch tip: ${selected.head}\n`);
  const tree = await preflight(repository, selected, gitDirectory);
  const contained = await git(selected.path, ["merge-base", "--is-ancestor", commit, selected.head!]);
  if (contained.exitCode === 0) { io.stdout("Already up to date.\n"); return 0; }
  if (contained.exitCode !== 1) throw new Error("Cannot verify base ancestry; rebase was not started. Fetch metadata may have changed.");
  await preserveIgnored(tree, commit);
  await preflight(repository, selected, gitDirectory);
  let result;
  try {
    const child = execa("git", ["-c", "rebase.autoStash=false", "-c", "rebase.updateRefs=false",
      "-c", "rebase.autoSquash=false", "-c", "rebase.abbreviateCommands=false",
      "rebase", "--no-autostash", "--no-update-refs", "--no-autosquash", "--merge", "--no-rebase-merges", "--empty=keep", "--no-fork-point", "--", commit], {
      cwd: selected.path, stdin: "ignore", reject: false, env: environment, detached: true,
    });
    // Own one process group so cancellation reaches Git's hook descendants too.
    const forward = (signal: NodeJS.Signals) => {
      try { if (child.pid !== undefined) process.kill(-child.pid, signal); } catch { /* The owned group may already have exited. */ }
    };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    try { result = await child; }
    finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); }
  } catch {
    throw new FormattedError(`Git rebase could not start or finish. Original branch tip: ${selected.head}. Workspace retained; no automatic abort/reset.\n${recovery(selected.path)}`);
  }
  if (result.exitCode === 0) { io.stdout("Rebase completed (or already up to date).\n"); return 0; }
  let conflicts: string[] = [];
  try {
    const unmerged = await git(selected.path, ["diff", "--name-only", "--diff-filter=U", "-z"]);
    if (unmerged.exitCode === 0) conflicts = unmerged.stdout.split("\0").filter(Boolean);
  } catch { /* Recovery guidance still applies when inspection fails. */ }
  const status = result.signal ? 128 + constants.signals[result.signal] : result.exitCode ?? 1;
  io.stderr(`error: ${conflicts.length ? "Rebase paused with conflicts" : result.signal ? `Rebase interrupted by ${result.signal}` : "Git rebase failed (hook rejection or another non-conflict error)"}. Workspace retained at ${safeDisplay(selected.path)}; branch ${safeDisplay(selected.branch!)}, base ${safeDisplay(base.remote + "/" + base.name)}, original tip ${selected.head}.\n`);
  for (const path of conflicts) io.stderr(`  ${jsonDisplay(path)}\n`);
  let operation: string | null;
  try { operation = await gitOperation(selected.path); } catch { operation = "unknown"; }
  io.stderr(operation === null
    ? "No in-progress Git operation was found. Inspect the worktree with git status before retrying; no automatic abort/reset was attempted.\n"
    : recovery(selected.path) + "\n");
  return status || 1;
}

/** Git detaches HEAD during rebase; use its saved branch only for recovery lookup. */
export async function resolveRebaseTarget(
  repository: RepositoryContext, input: string, config: RepositoryConfig,
): Promise<Resolution<OpenTarget>> {
  const resolution = await resolveOpenTarget(repository, input, config, { assertOpenable: false });
  if (resolution.kind === "not-found" || (resolution.kind === "found" && resolution.value.kind === "worktree")) return resolution;
  const targets = resolution.kind === "found" ? [resolution.value] : resolution.candidates;
  const branchRefs = new Set(targets.flatMap(target => target.kind === "branch" && target.branch.kind === "local" ? [target.branch.ref] : []));
  if (!branchRefs.size) return resolution;
  const recovered = new Map<string, Worktree[]>();
  for (const tree of await listWorktrees(repository)) {
    if (tree.branch !== null || !tree.pathExists || tree.prunable !== null) continue;
    await assertWorktreeIdentity(repository, tree);
    const directory = await output(tree.path, ["rev-parse", "--absolute-git-dir"]);
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
