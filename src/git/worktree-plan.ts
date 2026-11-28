import { pathKey, samePath, validateWindowsComponent } from "../platform/paths";
import { win32 } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { execa } from "execa";
import { validateNewBranchName } from "./branches";
import { listWorktreeInventory } from "./worktrees";
import { gitCommand } from "../platform/git-command";
import type {
  CreateWorktreeRequest,
  RepositoryConfig,
  RepositoryContext,
  ValidatedBase,
} from "../types";

type WorktreePlanRequest =
  | Exclude<CreateWorktreeRequest, { kind: "new" }>
  | {
      kind: "new";
      branch: string;
      base?: ValidatedBase;
      expectedPath?: string;
    };

function branchName(request: WorktreePlanRequest): string {
  return request.kind === "new" ? request.branch : request.branch.name;
}

function slug(name: string): string {
  const value = name.replaceAll("/", "-").replace(/[^A-Za-z0-9._-]/g, "-");
  if (
    !value ||
    value === "." ||
    value === ".." ||
    Buffer.byteLength(value) > 255
  ) {
    throw new Error(`Cannot make a safe worktree path for branch ${name}.`);
  }
  return value;
}

export function within(path: string, parent: string): boolean {
  const offset = relative(pathKey(parent), pathKey(path));
  return (
    offset === "" ||
    (offset !== ".." &&
      !offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(offset))
  );
}

export async function physicalPath(path: string): Promise<string> {
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

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function git(
  repository: RepositoryContext,
  args: readonly string[],
): Promise<number> {
  try {
    const result = await execa(gitCommand(), [...args], {
      cwd: repository.primaryWorktreeRoot,
      reject: false,
    });
    if (result.exitCode === undefined)
      throw new Error("Git did not return an exit code.");
    return result.exitCode;
  } catch {
    throw new Error(
      "Could not run Git. Check that Git is installed and available on PATH.",
    );
  }
}

export async function refExists(
  repository: RepositoryContext,
  ref: string,
): Promise<boolean> {
  const code = await git(repository, ["show-ref", "--verify", "--quiet", ref]);
  if (code > 1) throw new Error("Could not check branch refs with Git.");
  return code === 0;
}

/** Read-only planning; callers must repeat checks at creation time. */
export async function planWorktree(
  repository: RepositoryContext,
  request: WorktreePlanRequest,
  config: RepositoryConfig,
) {
  const name = branchName(request);
  await validateNewBranchName(repository, name);
  const root =
    config.worktreeDir === null
      ? resolve(
          dirname(repository.primaryWorktreeRoot),
          `${basename(repository.primaryWorktreeRoot)}-worktrees`,
        )
      : resolve(repository.primaryWorktreeRoot, config.worktreeDir);
  const physicalRoot = await physicalPath(root);
  const path = join(physicalRoot, slug(name));
  if (process.platform === "win32") {
    for (const part of path.slice(win32.parse(path).root.length).split(/[\\/]/u)) validateWindowsComponent(part);
  }
  const primary = await physicalPath(repository.primaryWorktreeRoot);
  if (
    within(physicalRoot, primary) ||
    within(await physicalPath(path), primary)
  ) {
    throw new Error(
      `Worktree directory would target the primary repository: ${root}`,
    );
  }
  const trees = await listWorktreeInventory(repository);
  const checkedOut = trees.find((tree) => tree.branch === name);
  if (checkedOut)
    throw new Error(
      `Branch ${name} is already checked out at ${checkedOut.path}. Use timber open instead.`,
    );

  const localRef = `refs/heads/${name}`;
  if (process.platform === "win32") {
    const refs = (await execa(gitCommand(), ["for-each-ref", "--format=%(refname)", "refs/heads/"], {
      cwd: repository.primaryWorktreeRoot, env: { GIT_OPTIONAL_LOCKS: "0" }, stdin: "ignore",
    })).stdout.split("\n").filter(Boolean);
    const folded = localRef.toLowerCase();
    if (refs.some(ref => (ref !== localRef && ref.toLowerCase() === folded)
      || ref.toLowerCase().startsWith(folded + "/") || folded.startsWith(ref.toLowerCase() + "/"))) {
      throw new Error("Case-insensitive Git branch namespace collision; choose another branch name.");
    }
  }
  if (request.kind === "local") {
    if (
      request.branch.ref !== localRef ||
      !(await refExists(repository, localRef))
    ) {
      throw new Error(
        `Local branch ${name} no longer exists. Resolve it again before retrying.`,
      );
    }
  } else if (await refExists(repository, localRef)) {
    throw new Error(`Branch ${name} already exists. Use timber open instead.`);
  }
  if (request.kind !== "local") {
    const refs = await execa(
      gitCommand(),
      ["for-each-ref", "--format=%(refname)", "refs/heads/"],
      {
        cwd: repository.primaryWorktreeRoot,
        reject: false,
        env: { GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    if (refs.exitCode !== 0)
      throw new Error("Cannot inspect Git branch namespace.");
    if (
      refs.stdout
        .split("\n")
        .some(
          (ref) =>
            ref &&
            (ref.startsWith(localRef + "/") || localRef.startsWith(ref + "/")),
        )
    ) {
      throw new Error(
        "Branch namespace collision; choose another arena or branch name.",
      );
    }
  }
  if (await exists(path))
    throw new Error(
      `Worktree path already exists: ${path}. Choose another branch or worktree directory.`,
    );
  const occupied = trees.find((tree) => samePath(tree.path, path));
  if (occupied)
    throw new Error(
      `Worktree path is already registered in Git: ${path}. Inspect the existing worktree before retrying.`,
    );

  return { name, root, physicalRoot, path, primary, localRef };
}
