import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execa } from "execa";
import { refreshRemoteBranch, validateNewBranchName } from "./branches";
import { listWorktrees } from "./worktrees";
import type { CreateWorktreeRequest, RepositoryConfig, RepositoryContext, Worktree } from "../types";

function branchName(request: CreateWorktreeRequest): string {
  return request.kind === "new" ? request.branch : request.branch.name;
}

function slug(name: string): string {
  const value = name.replaceAll("/", "-").replace(/[^A-Za-z0-9._-]/g, "-");
  if (!value || value === "." || value === ".." || Buffer.byteLength(value) > 255) {
    throw new Error(`Cannot make a safe worktree path for branch ${name}.`);
  }
  return value;
}

function within(path: string, parent: string): boolean {
  const offset = relative(parent, path);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(offset));
}

async function physicalPath(path: string): Promise<string> {
  let ancestor = path;
  for (;;) {
    try {
      return resolve(await realpath(ancestor), relative(ancestor, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function git(repository: RepositoryContext, args: readonly string[]): Promise<number> {
  try {
    const result = await execa("git", [...args], { cwd: repository.primaryWorktreeRoot, reject: false });
    if (result.exitCode === undefined) throw new Error("Git did not return an exit code.");
    return result.exitCode;
  } catch {
    throw new Error("Could not run Git. Check that Git is installed and available on PATH.");
  }
}

async function refExists(repository: RepositoryContext, ref: string): Promise<boolean> {
  const code = await git(repository, ["show-ref", "--verify", "--quiet", ref]);
  if (code > 1) throw new Error("Could not check branch refs with Git.");
  return code === 0;
}

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
  const name = branchName(request);
  await validateNewBranchName(repository, name);
  const root = config.worktreeDir === null
    ? resolve(dirname(repository.primaryWorktreeRoot), `${basename(repository.primaryWorktreeRoot)}-worktrees`)
    : resolve(repository.primaryWorktreeRoot, config.worktreeDir);
  const physicalRoot = await physicalPath(root);
  const path = join(physicalRoot, slug(name));
  const primary = await physicalPath(repository.primaryWorktreeRoot);
  if (within(physicalRoot, primary) || within(await physicalPath(path), primary)) {
    throw new Error(`Worktree directory would target the primary repository: ${root}`);
  }
  const trees = await listWorktrees(repository);
  const checkedOut = trees.find(tree => tree.branch === name);
  if (checkedOut) throw new Error(`Branch ${name} is already checked out at ${checkedOut.path}. Use timber open instead.`);

  const localRef = `refs/heads/${name}`;
  if (request.kind === "local") {
    if (request.branch.ref !== localRef || !await refExists(repository, localRef)) {
      throw new Error(`Local branch ${name} no longer exists. Resolve it again before retrying.`);
    }
  } else if (await refExists(repository, localRef)) {
    throw new Error(`Branch ${name} already exists. Use timber open instead.`);
  }
  if (await exists(path)) throw new Error(`Worktree path already exists: ${path}. Choose another branch or worktree directory.`);
  const occupied = trees.find(tree => tree.path === path);
  if (occupied) throw new Error(`Worktree path is already registered in Git: ${path}. Inspect the existing worktree before retrying.`);

  if (request.kind === "remote") await refreshRemoteBranch(repository, request.branch);
  await mkdir(physicalRoot, { recursive: true });
  if (await physicalPath(physicalRoot) !== physicalRoot || within(await physicalPath(path), primary)) {
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
  if (await physicalPath(path) !== path || within(await physicalPath(path), primary)) {
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
    const created = (await listWorktrees(repository)).find(tree => tree.path === path && tree.branch === name);
    if (created?.pathExists && created.status.kind === "known") return created;
  } catch {
    // Git succeeded, but verifying its inventory failed. Report actual retained state below.
  }
  throw new Error(`Git reported creation of ${name}, but the worktree could not be verified.${await failureState(repository, path, localRef)}`);
}
