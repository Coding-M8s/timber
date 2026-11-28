import { execa } from "execa";
import { shellQuoteForDisplay } from "../display";
import type { RepositoryConfig, RepositoryContext } from "../types";
import { validateNewBranchName } from "./branches";
import { listWorktreeInventory } from "./worktrees";
import { gitCommand } from "../platform/git-command";

export type RemoteHeadState =
  | { kind: "present"; commit: string }
  | { kind: "missing" }
  | { kind: "unknown"; reason: string };

export interface RemoteCollision {
  remote: string;
  /** Commit of the cached remote-tracking ref, or null when it is absent. */
  cached: string | null;
  live: RemoteHeadState;
  /** True when `open` parses `<remote>/<name>` back to this exact remote and name. */
  selectorSafe: boolean;
}

export interface NewBranchInspection {
  name: string;
  local: { commit: string; checkedOutAt: string | null } | null;
  remotes: readonly RemoteCollision[];
}

export type NewBranchDecision =
  | { kind: "create" }
  | { kind: "refuse"; message: string }
  | { kind: "offer-open"; matches: readonly { remote: string; commit: string; selector: string }[]; prompt: string };

const hash = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u;

/** Remote-qualified selector that `timber open` resolves, such as origin/feature/example. */
export function remoteSelector(remote: string, name: string): string {
  return `${remote}/${name}`;
}

function openCommand(selector: string): string {
  return `timber open -- ${shellQuoteForDisplay(selector)}`;
}

function short(commit: string | null): string {
  return commit === null ? "missing" : commit.slice(0, 12);
}

async function localCommit(repository: RepositoryContext, ref: string, strict: boolean): Promise<string | null> {
  const result = await execa(gitCommand(), ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repository.primaryWorktreeRoot, reject: false, stdin: "ignore", env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.exitCode === 0 && hash.test(result.stdout.trim())) return result.stdout.trim();
  if (result.exitCode === 1 || !strict) return null;
  throw new Error("Could not inspect existing branches with Git; no workspace was created.");
}

async function liveHead(repository: RepositoryContext, remote: string, name: string): Promise<RemoteHeadState> {
  const ref = `refs/heads/${name}`;
  let result;
  try {
    result = await execa(gitCommand(), ["ls-remote", "--heads", "--", remote, ref], {
      cwd: repository.primaryWorktreeRoot, reject: false, timeout: 10_000,
      env: { GIT_TERMINAL_PROMPT: "0" }, stdin: "ignore",
    });
  } catch {
    return { kind: "unknown", reason: "lookup failed" };
  }
  if (result.exitCode !== 0) return { kind: "unknown", reason: "lookup failed" };
  let found: string | null = null;
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/u.exec(line);
    if (!match) return { kind: "unknown", reason: "unparsable lookup output" };
    if (match[2] === ref) found = match[1]!;
  }
  return found === null ? { kind: "missing" } : { kind: "present", commit: found };
}

function parsesToRemote(repository: RepositoryContext, remote: string, name: string): boolean {
  const input = remoteSelector(remote, name);
  const prefix = [...repository.remotes].sort((a, b) => b.name.length - a.name.length)
    .find(value => input.startsWith(`${value.name}/`));
  return prefix?.name === remote && input.slice(prefix.name.length + 1) === name;
}

/**
 * Read exact local, cached remote-tracking and live remote state for a final
 * new-branch name. Never fetches or mutates. A failed live lookup is `unknown`,
 * never `missing`.
 */
export async function inspectNewBranchCollision(
  repository: RepositoryContext, name: string, config: RepositoryConfig,
): Promise<NewBranchInspection> {
  await validateNewBranchName(repository, name);
  const commit = await localCommit(repository, `refs/heads/${name}`, true);
  if (commit !== null) {
    const checkedOut = (await listWorktreeInventory(repository)).find(tree => tree.branch === name);
    return { name, local: { commit, checkedOutAt: checkedOut?.path ?? null }, remotes: [] };
  }
  if (config.remote !== null && !repository.remotes.some(remote => remote.name === config.remote)) {
    throw new Error(`Configured remote ${config.remote} does not exist in this repository.`);
  }
  const eligible = repository.remotes.filter(remote => config.remote === null || remote.name === config.remote);
  // Query remotes concurrently so several unreachable remotes cost one timeout, not one each.
  const remotes: RemoteCollision[] = await Promise.all(eligible.map(async remote => {
    const [cached, live] = await Promise.all([
      localCommit(repository, `refs/remotes/${remote.name}/${name}`, false),
      liveHead(repository, remote.name, name),
    ]);
    return { remote: remote.name, cached, live, selectorSafe: parsesToRemote(repository, remote.name, name) };
  }));
  return { name, local: null, remotes };
}

function refusal(lines: readonly string[]): NewBranchDecision {
  return { kind: "refuse", message: lines.join("\n") };
}

/** Pure decision for the final branch name; callers perform all I/O and prompting. */
export function decideNewBranchCollision(
  inspection: NewBranchInspection, context: { explicitBase?: string | undefined; interactive: boolean },
): NewBranchDecision {
  const { name, local, remotes } = inspection;
  if (local !== null) {
    const selector = local.checkedOutAt ?? name;
    const lines = [
      local.checkedOutAt === null
        ? `Branch ${name} already exists. Use timber open instead.`
        : `Branch ${name} is already checked out at ${local.checkedOutAt}. Use timber open instead.`,
      openCommand(selector),
      "No worktree was created; the existing branch was not changed.",
    ];
    if (context.explicitBase !== undefined) lines.push("--base cannot be applied to an existing branch.");
    return refusal(lines);
  }
  const matches = remotes.flatMap(remote => remote.live.kind === "present"
    ? [{ remote: remote.remote, commit: remote.live.commit, selector: remoteSelector(remote.remote, name), collision: remote }]
    : []);
  const openLines = matches.map(match => openCommand(match.selector));
  const unknown = remotes.filter(remote => remote.live.kind === "unknown");
  if (unknown.length > 0) {
    return refusal([
      ...unknown.map(remote => `Could not verify whether ${name} exists on ${remote.remote}; its state is unknown.`),
      "No worktree was created. Check the remote and retry, or choose another branch name.",
      ...(openLines.length > 0 ? ["Verified matches can be opened with:", ...openLines] : []),
    ]);
  }
  const stale = remotes.filter(remote => remote.cached !== null && remote.live.kind === "missing");
  if (stale.length > 0) {
    return refusal([
      ...stale.map(remote => `Remote-tracking ref ${remote.remote}/${name} is at ${short(remote.cached)}, but the branch is missing on ${remote.remote}.`),
      "No worktree was created. Inspect or delete the stale tracking ref, or choose another branch name.",
      ...(openLines.length > 0 ? ["Verified matches can be opened with:", ...openLines] : []),
    ]);
  }
  if (matches.length === 0) return { kind: "create" };
  if (context.explicitBase !== undefined) {
    return refusal([
      ...matches.map(match => `--base ${context.explicitBase} cannot be applied: branch ${name} already exists on ${match.remote}.`),
      "No worktree was created. To open the existing branch:",
      ...openLines,
    ]);
  }
  const unsafe = matches.filter(match => !match.collision.selectorSafe);
  if (unsafe.length > 0) {
    return refusal([
      ...unsafe.map(match => `Branch ${name} already exists on ${match.remote}, but timber open cannot select it unambiguously.`),
      "No worktree was created. Open it manually or choose another branch name.",
    ]);
  }
  const details = matches.flatMap(match => match.collision.cached === match.commit ? []
    : [`Cached ${match.remote}/${name}: ${short(match.collision.cached)}; live: ${short(match.commit)}`]);
  const remoteList = matches.map(match => match.remote).join(", ");
  const headline = matches.length === 1
    ? `Branch already exists on ${remoteList}. Did you mean timber open?`
    : `Branch already exists on ${matches.length} remotes (${remoteList}). Did you mean timber open?`;
  const prompt = [headline, ...details].join("\n");
  if (!context.interactive) {
    return refusal([
      matches.length === 1
        ? `Branch ${name} already exists on ${matches[0]!.remote}. Did you mean timber open? No worktree was created.`
        : `Branch ${name} already exists on ${matches.length} remotes (${remoteList}). Did you mean timber open? No worktree was created.`,
      ...details,
      matches.length === 1 ? "To open the existing branch:" : "Choose one remote explicitly:",
      ...openLines,
    ]);
  }
  return { kind: "offer-open", matches: matches.map(({ remote, commit, selector }) => ({ remote, commit, selector })), prompt };
}
