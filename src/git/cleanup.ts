import { samePath } from "../platform/paths";
import { CleanupCancelled, discardFingerprint } from "./cleanup-discard";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { execa } from "execa";
import { runPreDelete } from "../hooks";
import type { CommandIO } from "../services";
import { resolveBase } from "./branches";
import { refreshCleanupBase } from "./cleanup-base";
import { hasIntegratedContent, integratedBase } from "./cleanup-integration";
import { readCleanupEvidence, readCleanupPublication, readCleanupTarget } from "./cleanup-evidence";
import { discoverRepository } from "./repository";
import { listWorktrees } from "./worktrees";
import type {
  CleanupInspection, CleanupOptions, CleanupResult, ConfirmCleanupDiscard, RepositoryConfig, RepositoryContext, ValidatedBase, Worktree,
} from "../types";

type GitResult = { exitCode: number; stdout: string };

async function runGit(repository: RepositoryContext, args: readonly string[]): Promise<GitResult> {
  try {
    const result = await execa("git", [...args], {
      cwd: repository.primaryWorktreeRoot,
      reject: false,
      stdin: "ignore",
      env: { GIT_OPTIONAL_LOCKS: "0" },
    });
    if (result.exitCode === undefined) throw new Error("Git did not finish.");
    return { exitCode: result.exitCode, stdout: result.stdout };
  } catch {
    throw new Error("Could not run Git for cleanup; check repository access and retry.");
  }
}

async function pathExists(path: string): Promise<boolean | null> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    return null;
  }
}

async function registered(repository: RepositoryContext, path: string): Promise<boolean | null> {
  try {
    return (await listWorktrees(repository)).some(tree => samePath(tree.path, path));
  } catch {
    return null;
  }
}

async function branchObjectId(repository: RepositoryContext, branchRef: string): Promise<string | null> {
  try {
    const result = await runGit(repository, ["rev-parse", "--verify", "--quiet", `${branchRef}^{commit}`]);
    if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(result.stdout)) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

function retainedBranchState(name: string | null, oid: string | null): string {
  if (name === null) return "No local branch was selected.";
  if (oid === null) return `The state of local branch ${name} could not be verified.`;
  return `Local branch ${name} remains at ${oid}.`;
}

async function removalFailure(
  repository: RepositoryContext, path: string, branch: string | null, reason: string,
): Promise<Error> {
  const [exists, isRegistered, oid] = await Promise.all([
    pathExists(path), registered(repository, path), branch ? branchObjectId(repository, `refs/heads/${branch}`) : Promise.resolve(null),
  ]);
  const pathState = exists === true ? "The worktree path still exists."
    : exists === false ? "The worktree path is absent."
      : "The worktree path state could not be verified.";
  const registrationState = isRegistered === true ? "Git still lists the worktree."
    : isRegistered === false ? "Git no longer lists the worktree."
      : "The Git worktree registration could not be verified.";
  return new Error(`Could not complete worktree removal at ${path}: ${reason} ${pathState} ${registrationState} ${retainedBranchState(branch, oid)} Inspect Git worktrees and refs before retrying.`);
}

async function verifyRemoved(repository: RepositoryContext, path: string): Promise<boolean> {
  const [exists, isRegistered] = await Promise.all([pathExists(path), registered(repository, path)]);
  return exists === false && isRegistered === false;
}

function hardRefusal(inspection: CleanupInspection, options: CleanupOptions): string | null {
  const worktree = inspection.worktree;
  if (worktree.status.kind === "unknown") {
    return `Cannot clean up worktree at ${worktree.path} because file status is unknown: ${worktree.status.reason}.`;
  }
  if (worktree.status.ignored.length > 0 && !options.discardIgnored) {
    return `Cannot clean up worktree at ${worktree.path} because --keep-ignored preserves ignored files such as .env in this worktree: ${worktree.status.ignored.map(file => JSON.stringify(file)).join(", ")}; move or preserve them elsewhere, or retry without --keep-ignored to discard them.`;
  }
  return null;
}

function refusal(inspection: CleanupInspection): string | null {
  const worktree = inspection.worktree;
  if (worktree.status.kind === "unknown") {
    return `Cannot clean up worktree at ${worktree.path} because file status is unknown: ${worktree.status.reason}.`;
  }
  if (worktree.status.modified.length > 0) {
    return `Cannot clean up worktree at ${worktree.path} because modified files would be lost: ${worktree.status.modified.map(file => JSON.stringify(file)).join(", ")}. Commit or preserve them first.`;
  }
  if (worktree.status.untracked.length > 0) {
    return `Cannot clean up worktree at ${worktree.path} because untracked files would be lost: ${worktree.status.untracked.map(file => JSON.stringify(file)).join(", ")}. Move or preserve them first.`;
  }


  if (inspection.ancestry.kind === "contained" || inspection.integration.kind === "equivalent") return null;
  if (inspection.publication.kind === "published") return null;
  const ancestry = inspection.ancestry.kind === "unknown" ? inspection.ancestry.reason
    : `Commits not contained in ${inspection.ancestry.base.ref}: ${inspection.ancestry.commits.join(", ")}.`;
  if (inspection.publication.kind === "unpublished") {
    return `Cannot remove this worktree because it has unpublished commits: ${inspection.publication.commits.join(", ")}. ${ancestry} Publish them or select their merge target with --base <ref> and retry.`;
  }
  return `Cannot verify that worktree commits are published or integrated into the validated base. Publication: ${inspection.publication.kind === "upstream-deleted" ? "The configured upstream branch no longer exists." : inspection.publication.reason} Ancestry: ${ancestry} Git could not prove content integration. Leave the worktree in place; refresh repository state or select the merge target with --base <ref> and retry.`;
}

type BranchPreservation =
  | { kind: "integrated"; base: ValidatedBase }
  | { kind: "published"; upstreamRef: string }
  | { kind: "discard" }
  | { kind: "upstream-deleted"; upstreamRef: string; upstreamIdentity: string };

async function deletePreservedBranch(
  repository: RepositoryContext, branchRef: string, expectedOid: string,
  preservation: BranchPreservation, config: RepositoryConfig, options: CleanupOptions, expectedBase: ValidatedBase | null,
): Promise<void> {
  const branchName = branchRef.slice("refs/heads/".length);
  const symbolic = await runGit(repository, ["symbolic-ref", "--quiet", branchRef]);
  if (symbolic.exitCode === 0) throw new Error(`Local branch ${branchName} is not a direct ref.`);
  if (symbolic.exitCode !== 1) throw new Error(`Could not verify local branch ${branchName}.`);
  const currentOid = await branchObjectId(repository, branchRef);
  if (currentOid !== expectedOid) throw new Error(`Local branch ${branchName} changed after worktree removal.`);

  let base: ValidatedBase | null = null;
  try {
    base = await resolveBase(repository, config, options.base);
  } catch {
    if (options.base !== undefined || preservation.kind === "integrated") {
      throw new Error("The validated base could not be rechecked after worktree removal.");
    }
  }
  if (options.base !== undefined && (base?.ref !== expectedBase?.ref || base?.commit !== expectedBase?.commit)) {
    throw new Error("The selected cleanup base changed after worktree removal.");
  }
  if (branchRef === base?.ref) {
    throw new Error(`Local branch ${branchName} is the validated base and cannot be deleted by cleanup.`);
  }
  if (preservation.kind === "integrated") {
    if (base === null || base.ref !== preservation.base.ref || base.commit !== preservation.base.commit) {
      throw new Error("The validated base changed after worktree removal.");
    }
    const ancestry = await runGit(repository, ["merge-base", "--is-ancestor", expectedOid, base.commit]);
    if (ancestry.exitCode !== 0 && (ancestry.exitCode !== 1 ||
        !await hasIntegratedContent(repository.primaryWorktreeRoot, base, expectedOid))) {
      throw new Error("Local branch integration could not be reproven after worktree removal.");
    }
  } else if (preservation.kind === "upstream-deleted") {
    const publication = await readCleanupPublication(repository, branchRef, expectedOid, true);
    if (publication.state.kind !== "upstream-deleted" || publication.state.upstreamRef !== preservation.upstreamRef ||
        publication.upstreamIdentity !== preservation.upstreamIdentity) {
      throw new Error("Live upstream deletion could not be reproven after worktree removal.");
    }
  } else if (preservation.kind === "published") {
    const publication = (await readCleanupPublication(repository, branchRef, expectedOid)).state;
    if (publication.kind !== "published" || publication.upstreamRef !== preservation.upstreamRef) {
      throw new Error("Live upstream publication could not be reproven after worktree removal.");
    }
  }

  const inventory = await listWorktrees(repository);
  if (inventory.some(tree => tree.branch === branchName)) {
    throw new Error(`Local branch ${branchName} is checked out in another worktree.`);
  }

  const deleted = await runGit(repository, ["update-ref", "--no-deref", "-d", branchRef, expectedOid]);
  if (deleted.exitCode !== 0) throw new Error(`Could not conditionally delete local branch ${branchName}.`);

  // update-ref is not checkout-aware. If another worktree claimed the branch in the
  // inventory→delete gap, restore the tip so that worktree keeps a resolvable HEAD.
  const afterDelete = await listWorktrees(repository);
  if (afterDelete.some(tree => tree.branch === branchName)) {
    const restored = await runGit(repository, ["update-ref", "--no-deref", branchRef, expectedOid]);
    if (restored.exitCode !== 0 || await branchObjectId(repository, branchRef) !== expectedOid) {
      throw new Error(`Local branch ${branchName} was deleted while checked out in another worktree and could not be restored.`);
    }
    throw new Error(`Local branch ${branchName} is checked out in another worktree.`);
  }

  if (await branchObjectId(repository, branchRef) !== null) {
    throw new Error(`Local branch ${branchName} remains after Git reported deletion.`);
  }
}

/** Explain current cleanup evidence without treating the caller's selection as authority. */
export async function inspectCleanup(
  repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig,
): Promise<CleanupInspection> {
  return (await readCleanupEvidence(repository, worktree, config)).inspection;
}

/** Remove a linked worktree using current preservation evidence or scoped discard authorization. */
export async function cleanupWorktree(
  repository: RepositoryContext, worktree: Worktree, config: RepositoryConfig, options: CleanupOptions,
  io: CommandIO = { stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); } },
  confirmDiscard?: ConfirmCleanupDiscard,
  validateApproval?: () => Promise<void>,
): Promise<CleanupResult> {
  let primaryRepository: RepositoryContext;
  try {
    primaryRepository = await discoverRepository(repository.primaryWorktreeRoot);
  } catch {
    throw new Error("Cannot verify the primary repository for cleanup; repair it and retry.");
  }
  if (!samePath(primaryRepository.primaryWorktreeRoot, repository.primaryWorktreeRoot) ||
      !samePath(primaryRepository.commonGitDir, repository.commonGitDir)) {
    throw new Error("Repository identity changed since selection; rediscover the repository and retry cleanup.");
  }
  let evidence = await readCleanupEvidence(primaryRepository, worktree, config, options.base);
  const selectedBaseInput = evidence.baseInput;
  const refreshedBase = await refreshCleanupBase(primaryRepository, evidence.validatedBase);
  if (refreshedBase !== evidence.validatedBase) {
    evidence = await readCleanupEvidence(primaryRepository, worktree, config, options.base);
    if (evidence.baseInput !== selectedBaseInput || evidence.validatedBase?.ref !== refreshedBase?.ref || evidence.validatedBase?.commit !== refreshedBase?.commit) {
      throw new Error("Selected cleanup base changed during refresh; the worktree and branch are retained. Retry cleanup.");
    }
  }
  if (!options.keepBranch && evidence.branchRef !== null && evidence.branchRef === evidence.validatedBase?.ref) {
    throw new Error("The cleanup target branch is the validated base and cannot be deleted by cleanup.");
  }
  const blocked = hardRefusal(evidence.inspection, options);
  if (blocked) throw new Error(blocked);
  const upstreamDeleted = evidence.inspection.publication.kind === "upstream-deleted";
  let discard = upstreamDeleted;
  // Capture before the prompt so an answer cannot authorize newly edited content.
  let fingerprint: string | null = null;
  const initialFailure = refusal(evidence.inspection);
  if (discard || (initialFailure && confirmDiscard)) fingerprint = await discardFingerprint(evidence.inspection.worktree, options.discardIgnored);
  if (!discard && initialFailure) {
    if (!confirmDiscard) throw new Error(`${initialFailure} Rerun in an interactive terminal to choose whether to delete anyway.`);
    if (!await confirmDiscard(initialFailure)) throw new CleanupCancelled();
    discard = true;
  }
  if (upstreamDeleted) io.stdout("The configured upstream branch no longer exists; removing the worktree and discarding local changes.\n");

  const hasDeletionHooks = (config.hooks?.preDelete?.length ?? 0) > 0;
  if (hasDeletionHooks) await runPreDelete(primaryRepository, evidence.inspection.worktree, config, options, io);

  // Re-read local status, identity, refs, and the validated base first. When removal
  // depends on live publication rather than proven integration, recheck publication after
  // those local reads and immediately before crossing Git's remove boundary.
  const finalEvidence = await readCleanupTarget(primaryRepository, worktree, config, options.base);
  if (finalEvidence.branchRef !== evidence.branchRef || finalEvidence.headCommit !== evidence.headCommit) {
    throw new Error("Worktree branch or commit changed after cleanup inspection; refresh the selection and retry.");
  }
  const initialBase = evidence.validatedBase;
  const finalBase = finalEvidence.validatedBase;
  if (evidence.baseInput !== finalEvidence.baseInput || (initialBase === null) !== (finalBase === null) ||
      (initialBase !== null && finalBase !== null &&
        (initialBase.ref !== finalBase.ref || initialBase.commit !== finalBase.commit ||
          evidence.inspection.ancestry.kind !== finalEvidence.inspection.ancestry.kind)) ||
      evidence.inspection.integration.kind !== finalEvidence.inspection.integration.kind) {
    throw new Error("Validated base or integration evidence changed after cleanup inspection; refresh repository state and retry.");
  }

  let currentPublication = evidence.inspection.publication;
  if (upstreamDeleted || (!discard && integratedBase(finalEvidence.inspection) === null)) {
    const publication = await readCleanupPublication(
      primaryRepository, finalEvidence.branchRef, finalEvidence.headCommit, hasDeletionHooks || upstreamDeleted,
    );
    currentPublication = publication.state;
    if (upstreamDeleted && (currentPublication.kind !== "upstream-deleted" ||
        evidence.inspection.publication.kind !== "upstream-deleted" ||
        currentPublication.upstreamRef !== evidence.inspection.publication.upstreamRef ||
        publication.upstreamIdentity !== evidence.upstreamIdentity)) {
      throw new Error("Live upstream state changed before removal; worktree and branch retained. Retry cleanup.");
    }
    if (hasDeletionHooks && evidence.inspection.publication.kind === "published" &&
        (currentPublication.kind !== "published" ||
          currentPublication.upstreamRef !== evidence.inspection.publication.upstreamRef ||
          publication.upstreamCommit !== evidence.upstreamCommit ||
          publication.upstreamIdentity !== evidence.upstreamIdentity)) {
      throw new Error("Live upstream publication changed after pre-deletion hooks; the worktree and branch are retained. Refresh repository state and retry cleanup.");
    }
  }

  const finalInspection: CleanupInspection = {
    worktree: finalEvidence.inspection.worktree,
    publication: currentPublication,
    ancestry: finalEvidence.inspection.ancestry,
    integration: finalEvidence.inspection.integration,
  };
  const finalFailure = hardRefusal(finalInspection, options) ?? (discard ? null : refusal(finalInspection));
  if (finalFailure) throw new Error(finalFailure);

  if (fingerprint !== null && await discardFingerprint(finalInspection.worktree, options.discardIgnored) !== fingerprint) {
    throw new Error("Local file state changed after discard inspection; worktree and branch retained. Retry cleanup.");
  }

  await validateApproval?.();

  const path = finalInspection.worktree.path;
  const branchName = evidence.branchRef?.slice("refs/heads/".length) ?? null;
  let removed: GitResult;
  try {
    removed = await runGit(primaryRepository, ["worktree", "remove", ...(discard ? ["--force"] : []), "--", path]);
  } catch {
    throw await removalFailure(primaryRepository, path, branchName, "Git removal did not return a verifiable result.");
  }
  if (removed.exitCode !== 0) {
    throw await removalFailure(primaryRepository, path, branchName, "Git refused or failed to remove it.");
  }
  if (!await verifyRemoved(primaryRepository, path)) {
    throw await removalFailure(primaryRepository, path, branchName, "Git reported removal, but verification did not match.");
  }

  if (evidence.branchRef !== null && !options.keepBranch) {
    try {
      const base = integratedBase(finalInspection);
      let preservation: BranchPreservation;
      if (upstreamDeleted && finalInspection.publication.kind === "upstream-deleted" && evidence.upstreamIdentity !== undefined) {
        preservation = { kind: "upstream-deleted", upstreamRef: finalInspection.publication.upstreamRef, upstreamIdentity: evidence.upstreamIdentity };
      } else if (discard) preservation = { kind: "discard" };
      else if (base !== null) preservation = { kind: "integrated", base };
      else if (finalInspection.publication.kind === "published") {
        preservation = { kind: "published", upstreamRef: finalInspection.publication.upstreamRef };
      } else throw new Error("Local branch deletion requires proven integration or live upstream publication.");
      // Git removal deletes the saved association. Keep its selected input for
      // the final base check instead of falling back to repository configuration.
      const deletionOptions = finalEvidence.baseInput === undefined ? options : { ...options, base: finalEvidence.baseInput };
      await deletePreservedBranch(primaryRepository, evidence.branchRef, evidence.headCommit, preservation, config, deletionOptions, finalEvidence.validatedBase);
      return { removedWorktreePath: path, deletedLocalBranch: branchName, retainedLocalBranch: null };
    } catch (error) {
      const currentOid = await branchObjectId(primaryRepository, evidence.branchRef);
      const state = currentOid === null
        ? `The state of local branch ${branchName} could not be verified.`
        : currentOid === evidence.headCommit
          ? `Local branch ${branchName} was retained at ${currentOid}.`
          : `Local branch ${branchName} changed and was retained at ${currentOid}.`;
      const detail = error instanceof Error ? error.message : "branch deletion could not be verified";
      throw new Error(`The worktree was removed from ${path}, but local branch ${branchName} was not deleted: ${detail} ${state} Inspect the branch and retry cleanup.`);
    }
  }

  return {
    removedWorktreePath: path,
    deletedLocalBranch: null,
    retainedLocalBranch: branchName,
  };
}
