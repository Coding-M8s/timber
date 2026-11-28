import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { gitCommand } from "../platform/git-command";

/** Inspect per-worktree state even after all conflicts have been staged. */
export async function gitOperation(cwd: string): Promise<string | null> {
  const result = await execa(gitCommand(), ["rev-parse", "--absolute-git-dir"], { cwd, stdin: "ignore", reject: false });
  if (result.exitCode !== 0) throw new Error("Cannot inspect in-progress Git operations.");
  for (const [marker, operation] of [
    ["rebase-merge", "rebase"], ["rebase-apply", "rebase/am"], ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["sequencer", "sequencer"],
  ] as const) {
    try {
      await lstat(join(result.stdout, marker));
      return operation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot inspect in-progress Git operations.");
    }
  }
  return null;
}
