import { execa } from "execa";
import type { CleanupInspection, ValidatedBase } from "../types";
import { gitCommand } from "../platform/git-command";

const HASH = /^[0-9a-f]{40,64}$/i;

/** A snapshot of validated integration evidence, never deletion authority by itself. */
export function integratedBase(inspection: CleanupInspection): ValidatedBase | null {
  if (inspection.ancestry.kind === "contained") return inspection.ancestry.base;
  return inspection.integration.kind === "equivalent" ? inspection.integration.base : null;
}

/** Prove integration into the pinned base or its history without changing files or refs. */
export async function hasIntegratedContent(cwd: string, base: ValidatedBase, head: string): Promise<boolean> {
  if (!HASH.test(base.commit) || !HASH.test(head)) return false;
  const options = {
    cwd, reject: false as const, stdin: "ignore" as const, timeout: 10_000,
    env: { GIT_OPTIONAL_LOCKS: "0" },
  };
  try {
    // A custom driver can discard feature changes and return the base tree.
    // Reject even unused drivers; an unreadable config is not absence of drivers.
    const drivers = await execa(gitCommand(), [
      "config", "--get-regexp", "^merge\\.(.*\\.driver|default)$",
    ], options);
    if (drivers.exitCode !== 1) return false;
    const tree = await execa(gitCommand(), ["rev-parse", "--verify", "--quiet", `${base.commit}^{tree}`], options);
    if (tree.exitCode !== 0 || !HASH.test(tree.stdout)) return false;
    const merged = await execa(gitCommand(), [
      "-c", "merge.renormalize=false", "-c", "merge.renames=true", "-c", "merge.renameLimit=0",
      "merge-tree", "--write-tree", base.commit, head,
    ], options);
    if (merged.exitCode === 0 && HASH.test(merged.stdout) && merged.stdout === tree.stdout) return true;
    // A squash snapshot can remain preserved in base history even after later
    // edits or reverts conflict with the original branch. Require the full tree,
    // not patch similarity or a matching snapshot on an unrelated ref.
    if (merged.exitCode !== 0 && merged.exitCode !== 1) return false;
    if (!HASH.test(merged.stdout.split("\n")[0]!)) return false;
    const headTree = await execa(gitCommand(), ["rev-parse", "--verify", "--quiet", `${head}^{tree}`], options);
    if (headTree.exitCode !== 0 || !HASH.test(headTree.stdout)) return false;
    const history = await execa(gitCommand(), ["log", "--format=%T", base.commit, "--"], options);
    if (history.exitCode !== 0) return false;
    const trees = history.stdout.split("\n");
    return trees.every(value => HASH.test(value)) && trees.includes(headTree.stdout);
  } catch {
    return false;
  }
}
