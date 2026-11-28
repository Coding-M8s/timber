import { isAbsolute } from "node:path";
import { execa } from "execa";
import { samePath } from "../platform/paths";
import { safeDiagnostic, safeDisplay } from "../display";
import type { CommandIO } from "../services";
import type { RepositoryConfig, RepositoryContext, Worktree } from "../types";
import { inspectWorktree, listWorktreeInventory } from "./worktrees";
import { WorktreeReadPhase } from "./worktree-read-phase";
import { gitOperation } from "./operations";
import { gitCommand } from "../platform/git-command";

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export type PublishResult = "published" | "up-to-date" | "refused" | "failed";

/** Observed facts for the machine record; filled in as each one is verified. */
export interface PublishReport {
  result: PublishResult;
  /** Remote the branch is published to. */
  remote: string | null;
  /** Upstream as a remote-tracking ref, refs/remotes/<remote>/<branch>. */
  upstream: string | null;
  /** Commit confirmed on the remote by this run; null unless published or up to date. */
  pushedCommit: string | null;
}

/** Until a push proves otherwise, a stop is a refusal that changed nothing. */
export function createPublishReport(): PublishReport {
  return { result: "refused", remote: null, upstream: null, pushedCommit: null };
}

// An operation that broke (network, sign-in, Git, hook), unlike a safety refusal.
const operationFailures = new WeakSet<Error>();
function operationFailure<E extends Error>(error: E): E {
  operationFailures.add(error);
  return error;
}

// Every prompt path is closed: terminal, askpass helpers, credential manager UI,
// and SSH, which would otherwise read a passphrase from the controlling terminal.
const environment = {
  GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "false", SSH_ASKPASS: "false", SSH_ASKPASS_REQUIRE: "force",
  GCM_INTERACTIVE: "Never", GIT_EDITOR: "true",
};

const signIn = /terminal prompts disabled|could not read (?:Username|Password)|Authentication failed|Permission denied \(|Host key verification failed|returned error: 40[13]|HTTP 40[13]|Invalid username or (?:password|token)|Bad credentials/iu;

async function git(cwd: string, args: readonly string[]) {
  try {
    return await execa(gitCommand(), [...args], { cwd, stdin: "ignore", reject: false, env: environment, stripFinalNewline: false });
  } catch {
    throw operationFailure(new Error("Could not start or complete Git for publish; check Git installation, repository access and network availability. Nothing was forced."));
  }
}

async function output(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) throw new Error("Git could not verify publish inputs; check repository access and the selected worktree.");
  return result.stdout.replace(/\n$/, "");
}

async function preflight(repository: RepositoryContext, selected: Worktree): Promise<Worktree & { branch: string; head: string }> {
  if (!isAbsolute(selected.path)) throw new Error("Publish requires an absolute registered worktree path.");
  const matches = (await listWorktreeInventory(repository)).filter(tree => samePath(tree.path, selected.path));
  if (matches.length !== 1) throw new Error("Selected worktree is no longer uniquely registered.");
  // Publishing reads no file status; status can execute repository clean filters.
  const phase = new WorktreeReadPhase(repository);
  const tree = await inspectWorktree(repository, matches[0]!, phase, false);
  if (!tree.pathExists || tree.prunable !== null) throw new Error("Selected worktree is missing or stale; repair it explicitly before publish.");
  await phase.gitDirectory(tree);
  if (tree.branch === null) {
    const operation = await gitOperation(tree.path);
    throw new Error(`Cannot publish a detached HEAD${operation === null ? "" : ` (a ${operation} operation is in progress; finish or abort it with Git first)`}; check out an existing branch explicitly.`);
  }
  if (tree.head === null) throw new Error("Cannot publish an unborn branch; commit first.");
  if (tree.branch !== selected.branch || tree.head !== selected.head) throw new Error("Selected worktree branch or tip changed; rerun timber publish.");
  if (await output(tree.path, ["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${tree.branch}`
    || await output(tree.path, ["rev-parse", "--verify", "HEAD^{commit}"]) !== tree.head) {
    throw new Error("Selected worktree branch or tip changed; nothing was pushed.");
  }
  return { ...tree, branch: tree.branch, head: tree.head };
}

/** Choose the publication target: an existing same-named upstream, else the configured or sole remote. */
async function destination(repository: RepositoryContext, config: RepositoryConfig, tree: { path: string; branch: string }) {
  const branchRef = `refs/heads/${tree.branch}`;
  const record = await output(tree.path, ["for-each-ref", "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)", branchRef]);
  const [tracking = "", remoteName = "", remoteRef = "", ...extra] = record.split("\0");
  if (extra.length) throw new Error("Cannot read the branch upstream; nothing was pushed.");
  if (tracking || remoteName || remoteRef) {
    if (remoteName === "." || tracking.startsWith("refs/heads/")) {
      throw new Error("The branch upstream is a local branch, not a remote; unset it with git branch --unset-upstream, then publish again.");
    }
    if (!repository.remotes.some(remote => remote.name === remoteName)) {
      throw new Error("The branch upstream does not name a configured remote; fix it with Git, then publish again.");
    }
    if (remoteRef !== branchRef) {
      throw new Error(`The branch upstream is ${safeDisplay(`${remoteName}/${remoteRef.replace(/^refs\/heads\//u, "")}`)}, which has a different name. Timber publishes a branch only under its own name; push it with Git, or change the upstream.`);
    }
    return { remote: remoteName, upstream: tracking || `refs/remotes/${remoteName}/${tree.branch}`, setUpstream: false };
  }
  const name = config.remote ?? (repository.remotes.length === 1 ? repository.remotes[0]!.name : null);
  if (name === null || !repository.remotes.some(remote => remote.name === name)) {
    throw new Error("Remote is missing or ambiguous; set remote in Timber configuration, or set the branch upstream with Git.");
  }
  return { remote: name, upstream: `refs/remotes/${name}/${tree.branch}`, setUpstream: true };
}

/** Where publish would push, read-only: the same preflight and remote choice, with no push. */
export async function planPublish(repository: RepositoryContext, selected: Worktree, config: RepositoryConfig) {
  const tree = await preflight(repository, selected);
  const target = await destination(repository, config, tree);
  return { path: tree.path, branch: tree.branch, head: tree.head, remote: target.remote, upstream: target.upstream };
}

/** Push one verified branch under its own name; never forces and never prompts. */
export async function publishWorktree(
  repository: RepositoryContext, selected: Worktree, config: RepositoryConfig,
  io: CommandIO, report: PublishReport = createPublishReport(),
): Promise<number> {
  try {
    return await publishSelected(repository, selected, config, io, report);
  } catch (error) {
    if (report.result === "refused" && error instanceof Error && operationFailures.has(error)) report.result = "failed";
    throw error;
  }
}

async function publishSelected(
  repository: RepositoryContext, selected: Worktree, config: RepositoryConfig, io: CommandIO, report: PublishReport,
): Promise<number> {
  const tree = await preflight(repository, selected);
  const branchRef = `refs/heads/${tree.branch}`;
  const target = await destination(repository, config, tree);
  report.remote = target.remote;
  report.upstream = target.upstream;
  const label = `${target.remote}/${tree.branch}`;
  io.stdout(`Worktree: ${safeDisplay(tree.path)}\nBranch: ${safeDisplay(tree.branch)}\nRemote: ${safeDisplay(target.remote)}\nUpstream: ${safeDisplay(label)}\nBranch tip: ${tree.head}\n`);
  // One push decides every result. An explicit refspec without "+" is
  // fast-forward only and overrides any configured push refspec.
  const pushed = await git(tree.path, ["push", "--porcelain", "--no-force", "--no-follow-tags",
    ...(target.setUpstream ? ["--set-upstream"] : []), "--", target.remote, `${branchRef}:${branchRef}`]);
  // Remote messages and Git's own explanation stay human text on stderr.
  for (const line of pushed.stderr.split("\n")) if (line.trim()) io.stderr(`${safeDiagnostic(line)}\n`);
  let flag: string | null = null, summary = "";
  for (const line of pushed.stdout.split("\n")) {
    const row = /^(.)\t([^\t]+):([^\t]+)\t(.*)$/u.exec(line);
    if (row && row[3] === branchRef) { flag = row[1]!; summary = row[4]!; }
  }
  if (flag === "!" && summary.startsWith("[rejected]")) {
    throw new Error(`The remote branch ${safeDisplay(label)} has moved on: it has commits this branch does not contain, or this branch was rewritten after it was published. Nothing was pushed and no local ref changed. Timber never force-pushes; integrate the remote commits with Git, then publish again.`);
  }
  if (pushed.exitCode !== 0 || (flag !== "=" && flag !== "*" && flag !== " ")) {
    if (signIn.test(pushed.stderr)) {
      throw operationFailure(new Error(`The remote ${safeDisplay(target.remote)} needs a sign-in, and Timber never prompts for credentials. Sign in outside Timber (for example with a Git credential helper, an SSH agent or gh auth login), then publish again. Nothing was pushed.`));
    }
    throw operationFailure(new Error(`Git push to ${safeDisplay(label)} failed${flag === "!" ? `: the remote answered ${safeDiagnostic(summary)}` : " (network, remote, hook or another Git error)"}. Nothing was forced; read Git's output above, then publish again.`));
  }
  // The push has landed, so nothing below may turn this run into a refusal.
  // Git records exactly what it pushed in the tracking ref, when the remote has
  // one; otherwise report the branch tip, falling back to the verified tip.
  let commit = tree.head;
  for (const ref of [target.upstream, branchRef]) {
    const read = await git(tree.path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => null);
    const value = read?.exitCode === 0 ? read.stdout.trim() : "";
    if (oid.test(value)) { commit = value; break; }
  }
  report.pushedCommit = commit;
  if (flag === "=") {
    report.result = "up-to-date";
    io.stdout(`Already up to date.${target.setUpstream ? " Upstream set." : ""}\n`);
  } else {
    report.result = "published";
    io.stdout(`Published ${commit} to ${safeDisplay(label)}.${target.setUpstream ? " Upstream set." : ""}\n`);
  }
  return 0;
}
