import { execa } from "execa";
import type { CleanupInspection, ValidatedBase } from "../types";

const HASH = /^[0-9a-f]{40,64}$/i;

/** A snapshot of validated integration evidence, never deletion authority by itself. */
export function integratedBase(inspection: CleanupInspection): ValidatedBase | null {
  if (inspection.ancestry.kind === "contained") return inspection.ancestry.base;
  return inspection.integration.kind === "equivalent" ? inspection.integration.base : null;
}

/** Prove squash/rebase integration without checking out, staging, or updating any ref. */
export async function hasIntegratedContent(cwd: string, base: ValidatedBase, head: string): Promise<boolean> {
  if (!HASH.test(base.commit) || !HASH.test(head)) return false;
  const options = {
    cwd, reject: false as const, stdin: "ignore" as const, timeout: 10_000,
    env: { GIT_OPTIONAL_LOCKS: "0" },
  };
  try {
    // A custom driver can discard feature changes and return the base tree.
    // Reject even unused drivers; an unreadable config is not absence of drivers.
    const drivers = await execa("git", [
      "config", "--get-regexp", "^merge\\.(.*\\.driver|default)$",
    ], options);
    if (drivers.exitCode !== 1) return false;
    const tree = await execa("git", ["rev-parse", "--verify", "--quiet", `${base.commit}^{tree}`], options);
    if (tree.exitCode !== 0 || !HASH.test(tree.stdout)) return false;
    const merged = await execa("git", [
      "-c", "merge.renormalize=false", "-c", "merge.renames=true", "-c", "merge.renameLimit=0",
      "merge-tree", "--write-tree", base.commit, head,
    ], options);
    // Conflicts, unsupported Git versions, extra output, and timeouts fail closed.
    return merged.exitCode === 0 && HASH.test(merged.stdout) && merged.stdout === tree.stdout;
  } catch {
    return false;
  }
}
