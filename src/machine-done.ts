import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { loadRepositoryConfig } from "./config";
import { cleanupWorktree } from "./git/cleanup";
import { discardFingerprint } from "./git/cleanup-discard";
import { readCleanupTarget } from "./git/cleanup-evidence";
import { discoverRepository } from "./git/repository";
import { listWorktreeInventory, uninspectedWorktree } from "./git/worktrees";
import type { CommandContext, CommandIO } from "./services";
import type { CleanupOptions } from "./types";
import { runMachineCommand } from "./machine";

const approvalSchema = z.object({
  schemaVersion: z.literal(1),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().nonnegative(),
  repository: z.object({ commonGitDir: z.string(), primaryWorktreeRoot: z.string(), currentWorktreeRoot: z.string() }),
  worktree: z.object({ path: z.string(), canonicalPath: z.string() }).passthrough(),
  options: z.object({ keepBranch: z.boolean(), discardIgnored: z.boolean(), base: z.string().optional() }).strict().transform(value => ({
    keepBranch: value.keepBranch, discardIgnored: value.discardIgnored,
    ...(value.base === undefined ? {} : { base: value.base }),
  })),
}).passthrough();

/** A read-only snapshot for a native confirmation, not an unbound force option. */
export async function previewCleanup(cwd: string, target: string, options: CleanupOptions) {
  if (!isAbsolute(target)) throw new Error("Native cleanup requires an exact absolute worktree path.");
  const repository = await discoverRepository(cwd);
  const config = await loadRepositoryConfig(repository);
  const selected = (await listWorktreeInventory(repository)).find(tree => tree.path === target);
  if (!selected || selected.isPrimary) throw new Error("Select an existing linked worktree; the primary worktree cannot be removed.");
  const evidence = await readCleanupTarget(repository, uninspectedWorktree(selected), config, options.base);
  const worktree = evidence.inspection.worktree;
  if (worktree.status.kind !== "known") throw new Error("Cannot verify worktree file status.");
  if (!options.discardIgnored && worktree.status.ignored.length) {
    throw new Error("Ignored files exist. Move them out of the worktree or choose to discard ignored files.");
  }
  if (!options.keepBranch && evidence.branchRef === evidence.validatedBase?.ref) {
    throw new Error("The cleanup target is the base branch and cannot be deleted.");
  }
  const identity = { commonGitDir: await realpath(repository.commonGitDir),
    primaryWorktreeRoot: repository.primaryWorktreeRoot, currentWorktreeRoot: repository.currentWorktreeRoot };
  const canonicalPath = await realpath(worktree.path);
  const directory = await lstat(canonicalPath);
  const fingerprint = await discardFingerprint(worktree, options.discardIgnored);
  const snapshot = createHash("sha256").update(JSON.stringify({
    repository: identity.commonGitDir, primary: identity.primaryWorktreeRoot, target: canonicalPath,
    directory: [directory.dev, directory.ino], head: evidence.headCommit, branch: evidence.branchRef,
    base: evidence.validatedBase, options: { keepBranch: options.keepBranch, discardIgnored: options.discardIgnored, base: options.base ?? null }, fingerprint, hooks: config.hooks?.preDelete ?? [],
  })).digest("hex");
  return { schemaVersion: 1 as const, snapshot, expiresAt: Date.now() + 10 * 60_000,
    repository: identity, worktree: { ...worktree, canonicalPath, detached: worktree.branch === null }, options };
}

export async function applyCleanup(cwd: string, target: string, input: unknown, io: CommandIO) {
  const approval = approvalSchema.parse(input);
  const assertCurrent = async () => {
    if (approval.expiresAt <= Date.now() || approval.expiresAt > Date.now() + 10 * 60_000
      || approval.worktree.path !== target) throw new Error("Cleanup preview expired or target changed. Review the worktree again.");
    const current = await previewCleanup(cwd, target, approval.options);
    if (current.snapshot !== approval.snapshot || current.worktree.canonicalPath !== approval.worktree.canonicalPath
      || current.repository.commonGitDir !== approval.repository.commonGitDir) {
      throw new Error("Worktree, files, settings or repository changed. Review the updated preview before removing.");
    }
    return current;
  };
  const current = await assertCurrent();
  const repository = await discoverRepository(cwd);
  const config = await loadRepositoryConfig(repository);
  // The native Remove button approved only this snapshot. Recheck at the normal
  // discard decision, then let cleanup enforce its post-hook identity/file checks.
  return cleanupWorktree(repository, current.worktree, config, current.options, io, async () => {
    await assertCurrent();
    return true;
  }, async () => { await assertCurrent(); });
}

export async function runNativeCleanup(
  action: string, target: string, options: { keepBranch?: boolean; keepIgnored?: boolean; base?: string; approvalFile?: string; resultFile?: string },
  context: CommandContext,
): Promise<number> {
  if (action === "preview") {
    if (options.approvalFile || options.resultFile) throw new Error("Preview does not accept approval or result files.");
    const preview = await previewCleanup(context.cwd, target, {
      keepBranch: options.keepBranch === true, discardIgnored: options.keepIgnored !== true,
      ...(options.base === undefined ? {} : { base: options.base }),
    });
    context.io.stdout(JSON.stringify(preview) + "\n");
    return 0;
  }
  if (action !== "apply" || !options.approvalFile || !options.resultFile
    || options.base !== undefined || options.keepBranch || options.keepIgnored) {
    throw new Error("Apply requires an approval file and result file; settings come from the approved preview.");
  }
  const approvalFile = options.approvalFile;
  return runMachineCommand("done", context, async machineContext => {
    const stat = await lstat(approvalFile);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid cleanup approval file.");
    const approval: unknown = JSON.parse(await readFile(approvalFile, "utf8"));
    const parsed = approvalSchema.parse(approval);
    const repository = await discoverRepository(context.cwd);
    await machineContext.machine?.repository(repository);
    const current = await previewCleanup(context.cwd, target, parsed.options);
    await machineContext.machine?.worktree(current.worktree, false);
    const result = await applyCleanup(context.cwd, target, approval, context.io);
    context.io.stdout(`Removed worktree at ${result.removedWorktreePath}\n`);
  }, options.resultFile);
}
