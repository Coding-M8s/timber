import { listBranches } from "../git/branches";
import { discoverRepository } from "../git/repository";
import { listWorktreeInventory } from "../git/worktrees";
import type {
  Branch, GitReadOptions, RemoteBranch, RepositoryContext, WorktreeInventory,
} from "../types";

export interface CompletionTargetDependencies {
  discoverRepository(cwd: string, options?: GitReadOptions): Promise<RepositoryContext>;
  listWorktreeInventory(repository: RepositoryContext, options?: GitReadOptions): Promise<readonly WorktreeInventory[]>;
  listBranches(repository: RepositoryContext, options?: GitReadOptions): Promise<readonly Branch[]>;
}

const gitDependencies: CompletionTargetDependencies = {
  discoverRepository,
  listWorktreeInventory,
  listBranches,
};

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, character => character.codePointAt(0)!);
  const rightPoints = Array.from(right, character => character.codePointAt(0)!);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function hasExplicitRemotePrefix(name: string, repository: RepositoryContext): boolean {
  return repository.remotes.some(remote => name.startsWith(`${remote.name}/`));
}

function branchRegistrationCounts(inventory: readonly WorktreeInventory[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tree of inventory) {
    if (tree.branch !== null) counts.set(tree.branch, (counts.get(tree.branch) ?? 0) + 1);
  }
  return counts;
}

function doneTargets(repository: RepositoryContext, inventory: readonly WorktreeInventory[]): string[] {
  const counts = branchRegistrationCounts(inventory);
  const candidates: string[] = [];
  for (const tree of inventory) {
    if (tree.isPrimary) continue;
    candidates.push(tree.path);
    if (tree.branch !== null && counts.get(tree.branch) === 1
      && !hasExplicitRemotePrefix(tree.branch, repository)) {
      candidates.push(tree.branch);
    }
  }
  return sortedUnique(candidates);
}

function openTargets(
  repository: RepositoryContext,
  inventory: readonly WorktreeInventory[],
  branches: readonly Branch[],
): string[] {
  const counts = branchRegistrationCounts(inventory);
  const candidates: string[] = [];

  for (const tree of inventory) {
    candidates.push(tree.path);
    if (tree.branch !== null && counts.get(tree.branch) === 1
      && !hasExplicitRemotePrefix(tree.branch, repository)) {
      candidates.push(tree.branch);
    }
  }

  for (const branch of branches) {
    if (branch.kind === "local") {
      if (counts.has(branch.name) || hasExplicitRemotePrefix(branch.name, repository)) continue;
      candidates.push(branch.name);
    } else {
      candidates.push(remoteSelector(branch));
    }
  }
  return sortedUnique(candidates);
}

function remoteSelector(branch: RemoteBranch): string {
  return `${branch.remote}/${branch.name}`;
}

/** Create a fresh, bounded lookup. Dependencies are a test seam for read failures. */
export function createCompletionTargetService(
  dependencies: CompletionTargetDependencies = gitDependencies,
): (command: "open" | "done", cwd: string) => Promise<readonly string[]> {
  return async (command, cwd) => {
    const options: GitReadOptions = { signal: AbortSignal.timeout(1000) };
    const repository = await dependencies.discoverRepository(cwd, options);
    const inventory = await dependencies.listWorktreeInventory(repository, options);
    if (command === "done") return doneTargets(repository, inventory);
    const branches = await dependencies.listBranches(repository, options);
    return openTargets(repository, inventory, branches);
  };
}

export const listCompletionTargets = createCompletionTargetService();
