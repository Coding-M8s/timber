import { isAbsolute, resolve } from "node:path";
import { listBranches, listLiveRemoteBranches, resolveBranch } from "./branches";
import { assertOpenableWorktree, listWorktrees } from "./worktrees";
import type {
  Branch, OpenTarget, RepositoryConfig, RepositoryContext, Resolution,
  ResolveOpenTargetOptions, Worktree,
} from "../types";

function targetKey(target: OpenTarget): string {
  return target.kind === "worktree"
    ? `worktree:${target.worktree.path}` : `branch:${target.branch.ref}`;
}

function compareTargets(left: OpenTarget, right: OpenTarget): number {
  const leftKey = targetKey(left);
  const rightKey = targetKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function deduplicateTargets(targets: readonly OpenTarget[]): OpenTarget[] {
  const unique = new Map<string, OpenTarget>();
  for (const target of targets) unique.set(targetKey(target), target);
  return [...unique.values()].sort(compareTargets);
}

async function finish(
  repository: RepositoryContext,
  targets: readonly OpenTarget[],
  options: ResolveOpenTargetOptions = {},
): Promise<Resolution<OpenTarget>> {
  const candidates = deduplicateTargets(targets);
  if (candidates.length === 0) return { kind: "not-found" };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  const target = candidates[0]!;
  if (target.kind === "worktree" && options.assertOpenable !== false) {
    await assertOpenableWorktree(repository, target.worktree);
  }
  return { kind: "found", value: target };
}

function worktreeTargets(worktrees: readonly Worktree[]): OpenTarget[] {
  return worktrees.map(worktree => ({ kind: "worktree", worktree }));
}

function mappedTargets(
  selected: readonly Branch[], branches: readonly Branch[], worktrees: readonly Worktree[],
): OpenTarget[] {
  const targets: OpenTarget[] = [];
  for (const branch of selected) {
    let matches: Worktree[];
    if (branch.kind === "local") {
      matches = worktrees.filter(worktree => worktree.branch === branch.name);
    } else {
      const localNames = new Set(branches.flatMap(candidate =>
        candidate.kind === "local" && candidate.upstream?.ref === branch.ref ? [candidate.name] : []));
      matches = worktrees.filter(worktree => worktree.branch !== null && localNames.has(worktree.branch));
    }
    if (matches.length) targets.push(...worktreeTargets(matches));
    else targets.push({ kind: "branch", branch });
  }
  return targets;
}

/** Resolve a registered worktree first, then TIM-2's exact and ticket-prefix branch policy. */
export async function resolveOpenTarget(
  repository: RepositoryContext,
  input: string,
  config: RepositoryConfig,
  options: ResolveOpenTargetOptions = {},
): Promise<Resolution<OpenTarget>> {
  if (!input) return { kind: "not-found" };
  const worktrees = await listWorktrees(repository);

  if (isAbsolute(input)) {
    const path = resolve(input);
    return finish(repository, worktrees.filter(worktree => resolve(worktree.path) === path)
      .map(worktree => ({ kind: "worktree", worktree })), options);
  }

  const hasExplicitRemote = [...repository.remotes]
    .sort((left, right) => right.name.length - left.name.length)
    .some(remote => input.startsWith(`${remote.name}/`));
  if (!hasExplicitRemote) {
    const exactWorktrees = worktrees.filter(worktree => worktree.branch === input);
    if (exactWorktrees.length) return finish(repository, worktreeTargets(exactWorktrees), options);
  }

  const localBranches = await listBranches(repository);
  if (options.discoverRemote) {
    const cached = await resolveBranch(repository, input, config, localBranches);
    if (cached.kind !== "not-found") {
      const targets = await finish(repository, mappedTargets(
        cached.kind === "found" ? [cached.value] : cached.candidates, localBranches, worktrees,
      ), options);
      if (targets.kind === "found" && (targets.value.kind === "worktree" || targets.value.branch.kind === "local")) {
        return targets;
      }
    }
  }
  const branches = options.discoverRemote
    ? [...localBranches.filter(branch => branch.kind === "local"), ...await listLiveRemoteBranches(repository, input, config)]
    : localBranches;
  const resolution = await resolveBranch(repository, input, config, branches);
  if (resolution.kind === "not-found") return resolution;
  const selected = resolution.kind === "found" ? [resolution.value] : resolution.candidates;
  return finish(repository, mappedTargets(selected, branches, worktrees), options);
}
