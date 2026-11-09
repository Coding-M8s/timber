import { samePath } from "../platform/paths";
import { mkdir } from "node:fs/promises";
import { refreshRemoteBranch } from "./branches";
import { exists, physicalPath, within, git, refExists, planWorktree } from "./worktree-plan";
import { inspectWorktree, listWorktreeInventory } from "./worktrees";
import type { CreateWorktreeRequest, RepositoryConfig, RepositoryContext, Worktree } from "../types";

async function failureState(repository: RepositoryContext, path: string, ref: string): Promise<string> {
  const found: string[] = [];
  try { if (await exists(path)) found.push(`Destination currently exists at ${path}.`); }
  catch { found.push("Destination state could not be checked."); }
  try { if (await refExists(repository, ref)) found.push(`Branch ${ref} currently exists.`); }
  catch { found.push("Branch ref state could not be checked."); }
  return found.length ? ` ${found.join(" ")} Inspect Git worktrees before retrying.` : " No destination or branch ref was found after failure.";
}

/** Create one linked worktree without replacing or deleting existing paths or refs. */
export async function createWorktree(
  repository: RepositoryContext, request: CreateWorktreeRequest, config: RepositoryConfig,
): Promise<Worktree> {
  const { name, root, physicalRoot, path, primary, localRef } = await planWorktree(repository, request, config);

  if (request.kind === "new" && request.expectedPath !== undefined && !samePath(path, request.expectedPath)) {
    throw new Error("Worktree destination changed after arena preflight; no worktree was created.");
  }
  if (request.kind === "remote") await refreshRemoteBranch(repository, request.branch);
  await mkdir(physicalRoot, { recursive: true });
  if (!samePath(await physicalPath(physicalRoot), physicalRoot) || within(await physicalPath(path), primary)) {
    throw new Error(`Worktree directory changed or would target the primary repository: ${root}`);
  }
  try {
    // Git accepts an existing empty directory. Claim it first so a concurrent
    // creator cannot place one between our preflight check and Git's add.
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Worktree path already exists: ${path}. Choose another branch or worktree directory.`);
    }
    throw error;
  }
  if (!samePath(await physicalPath(path), path) || within(await physicalPath(path), primary)) {
    throw new Error(`Worktree destination changed or would target the primary repository: ${path}`);
  }

  const args = request.kind === "new"
    ? ["worktree", "add", "--no-track", "-b", name, path, request.base.commit]
    : request.kind === "local"
      ? ["worktree", "add", "--no-guess-remote", path, name]
      : ["worktree", "add", "--track", "-b", name, path, request.branch.ref];
  let code: number;
  try {
    code = await git(repository, args);
  } catch {
    throw new Error(`Could not create worktree for ${name}: Git stopped or could not start.${await failureState(repository, path, localRef)}`);
  }
  if (code !== 0) {
    throw new Error(`Could not create worktree for ${name} with Git.${await failureState(repository, path, localRef)}`);
  }

  try {
    const inventory = (await listWorktreeInventory(repository)).find(tree => samePath(tree.path, path) && tree.branch === name);
    const created = inventory ? await inspectWorktree(repository, inventory) : undefined;
    if (created?.pathExists && created.status.kind === "known") return created;
  } catch {
    // Git succeeded, but verifying its inventory failed. Report actual retained state below.
  }
  throw new Error(`Git reported creation of ${name}, but the worktree could not be verified.${await failureState(repository, path, localRef)}`);
}
