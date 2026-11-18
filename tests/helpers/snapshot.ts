import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

/** Every file's path, size and mtime, then refs, worktrees and status: what a read-only call must leave alone. */
export async function snapshot(directory: string, worktrees: readonly string[]): Promise<string> {
  const files: string[] = [];
  const walk = async (path: string) => {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, item.name);
      const info = await stat(full);
      files.push(`${full} ${info.size} ${info.mtimeMs}`);
      if (item.isDirectory()) await walk(full);
    }
  };
  await walk(directory);
  const primary = worktrees[0]!;
  const git = (cwd: string, ...args: string[]) => execa("git", args, { cwd, env: { GIT_OPTIONAL_LOCKS: "0" } }).then(result => result.stdout);
  const status = await Promise.all(worktrees.map(path => git(path, "status", "--porcelain=v2", "--ignored", "--branch")));
  return [...files, await git(primary, "for-each-ref"), await git(primary, "worktree", "list", "--porcelain"), ...status].join("\n");
}
