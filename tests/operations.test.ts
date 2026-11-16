import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, withRepository } from "./helpers/git";
import { gitOperation } from "../src/git/operations";

test("gitOperation names every in-progress operation marker and null when clean", async () => {
  await withRepository(async primary => {
    expect(await gitOperation(primary)).toBeNull();
    const gitDir = await git(primary, "rev-parse", "--absolute-git-dir");
    const oid = await git(primary, "rev-parse", "HEAD");
    for (const [marker, operation, directory] of [
      ["rebase-merge", "rebase", true], ["rebase-apply", "rebase/am", true], ["MERGE_HEAD", "merge", false],
      ["CHERRY_PICK_HEAD", "cherry-pick", false], ["REVERT_HEAD", "revert", false], ["sequencer", "sequencer", true],
    ] as const) {
      const path = join(gitDir, marker);
      if (directory) await mkdir(path); else await writeFile(path, oid + "\n");
      expect(await gitOperation(primary)).toBe(operation);
      await rm(path, { recursive: true });
    }
    expect(await gitOperation(primary)).toBeNull();
  });
});
