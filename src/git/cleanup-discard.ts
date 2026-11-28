import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { gitOperation } from "./operations";
import type { Worktree } from "../types";
import { gitCommand } from "../platform/git-command";

/** Cancellation is successful at the command boundary and never runs hooks. */
export class CleanupCancelled extends Error {
  constructor() { super("Cancelled. Worktree and local branch retained."); }
}

/** Bind discard permission to file contents and the index, not just porcelain paths. */
export async function discardFingerprint(tree: Worktree, discardIgnored: boolean): Promise<string> {
  if (tree.status.kind !== "known") throw new Error("Cannot verify file state for discard.");
  const hash = createHash("sha256");
  class IgnoredContent extends Error {}
  const field = (value: unknown) => { hash.update(JSON.stringify(value) + "\0"); };
  field({ modified: tree.status.modified, untracked: tree.status.untracked });
  const visit = async (cwd: string, path: string): Promise<void> => {
    field(path);
    let info;
    try { info = await lstat(join(cwd, path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { field("absent"); return; }
      throw error;
    }
    field(info.mode);
    if (info.isSymbolicLink()) field(await readlink(join(cwd, path)));
    else if (info.isDirectory()) {
      field("directory");
      for (const name of (await readdir(join(cwd, path))).sort()) await visit(cwd, join(path, name));
    } else if (info.isFile()) {
      field(info.size);
      for await (const chunk of createReadStream(join(cwd, path))) hash.update(chunk);
    } else throw new Error("Cannot verify special file contents for discard.");
    field("end");
  };
  try {
    const captureRepository = async (cwd: string): Promise<void> => {
      const run = (args: string[]) => execa(gitCommand(), args,
        { cwd, stdin: "ignore", env: { GIT_OPTIONAL_LOCKS: "0" }, timeout: 10_000 });
      field(cwd);
      // Ignored runtime files are disposable by default. Their path inventory
      // must not turn a successful teardown hook into a changed-state refusal.
      const status = (await run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])).stdout;
      field(status);
      const paths = new Set<string>();
      const records = status.split("\0");
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (!record) continue;
        const code = record.slice(0, 2);
        paths.add(record.slice(3));
        if (code.includes("R") || code.includes("C")) index++;
      }
      if (!discardIgnored && (await run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).stdout) {
        throw new IgnoredContent("Cannot clean up because --keep-ignored preserves ignored files, including files inside submodules.");
      }
      // Preserve staged contents, modes, conflict stages and index flags, while
      // allowing Git to refresh stat caches without changing discard permission.
      const entries = (await run(["ls-files", "--stage", "-v", "-z"])).stdout;
      field(entries);
      for (const cached of [false, true]) {
        field((await run([
          "diff", "--no-ext-diff", "--no-textconv", "--binary", "--ignore-submodules=none", ...(cached ? ["--cached"] : []), "--",
        ])).stdout);
      }
      const modules = new Set(entries.split("\0").filter(entry => entry.slice(2).startsWith("160000 "))
        .map(entry => entry.slice(entry.indexOf("\t") + 1)));
      for (const path of [...modules].sort()) {
        const module = join(cwd, path);
        try { await lstat(join(module, ".git")); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (await gitOperation(module) !== null) throw new Error("Submodule has an in-progress Git operation.");
        await captureRepository(module);
      }
      // A populated submodule has its own ignored-file rules. Fingerprint its
      // changed files in that repository instead of walking its entire folder.
      for (const path of [...paths].sort()) if (!modules.has(path)) await visit(cwd, path);
    };
    await captureRepository(tree.path);
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof IgnoredContent) throw error;
    throw new Error("Cannot verify local file contents for discard; worktree and branch retained.");
  }
}
