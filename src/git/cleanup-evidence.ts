import { WorktreeReadPhase } from "./worktree-read-phase";
import { samePath } from "../platform/paths";
import { isAbsolute, resolve } from "node:path";
import { execa } from "execa";
import { gitOperation } from "./operations";
import { resolveBase } from "./branches";
import { readBaseAssociation } from "./base-metadata";
import { hasIntegratedContent } from "./cleanup-integration";
import { discoverRepository } from "./repository";
import { inspectWorktree, listWorktreeInventory } from "./worktrees";
import type {
  AncestryState, CleanupInspection, ContentIntegrationState, PublicationState, RepositoryConfig, RepositoryContext,
  ValidatedBase, Worktree, WorktreeInventory,
} from "../types";

export type CleanupEvidence = {
  inspection: CleanupInspection;
  headCommit: string;
  branchRef: string | null;
  upstreamCommit: string | null;
  /** Private comparison data; may contain a credential-bearing URL. Never display it. */
  upstreamIdentity?: string;
  validatedBase: ValidatedBase | null;
  /** Selected explicit or saved input, retained after worktree metadata is removed. */
  baseInput: string | undefined;
};

export type CleanupPublication = { state: PublicationState; upstreamCommit: string | null; upstreamIdentity?: string };

type GitResult = { exitCode: number; stdout: string };

const HASH = /^[0-9a-f]{40,64}$/i;
const UNKNOWN_BASE = "Could not resolve a validated cleanup base; select an exact base branch and retry.";
const UNKNOWN_ANCESTRY = "Could not verify commit ancestry against the validated base; refresh repository state and retry.";
const UNKNOWN_SELF_BASE = "The cleanup target branch is the validated base; choose a different base or leave this worktree in place.";
const UNKNOWN_UNKEPT_COMMIT = "The commit base is not contained in any other branch, remote-tracking branch or tag, so it does not preserve this work; publish the branch or choose a branch base.";
const UNKNOWN_PUBLICATION = "Could not verify the live upstream state; refresh repository state and retry.";

async function runGit(
  cwd: string, args: readonly string[], options: { timeout?: number } = {},
): Promise<GitResult> {
  const commandOptions = {
    cwd,
    reject: false as const,
    stdin: "ignore" as const,
    env: {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "false",
      SSH_ASKPASS: "false",
      GCM_INTERACTIVE: "Never",
    },
  };
  const result = options.timeout === undefined
    ? await execa("git", [...args], commandOptions)
    : await execa("git", [...args], { ...commandOptions, timeout: options.timeout });
  if (result.exitCode === undefined) throw new Error("Git did not finish.");
  return { exitCode: result.exitCode, stdout: result.stdout };
}

function validOid(value: string): boolean {
  return HASH.test(value);
}

function unknownAncestry(reason = UNKNOWN_ANCESTRY): AncestryState {
  return { kind: "unknown", reason };
}

function unknownPublication(reason = UNKNOWN_PUBLICATION): PublicationState {
  return { kind: "unknown", reason };
}

async function verifiedCommit(cwd: string, oid: string): Promise<string | null> {
  if (!validOid(oid) && !oid.startsWith("refs/heads/")) return null;
  let result: GitResult;
  try {
    result = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${oid}^{commit}`]);
  } catch {
    return null;
  }
  return result.exitCode === 0 && validOid(result.stdout) ? result.stdout : null;
}

async function aheadCommits(cwd: string, base: string, head: string): Promise<readonly string[] | null> {
  try {
    const result = await runGit(cwd, ["rev-list", "--reverse", `${base}..${head}`]);
    if (result.exitCode !== 0) return null;
    const commits = result.stdout.split("\n").filter(Boolean);
    if (!commits.every(validOid)) return null;
    return commits;
  } catch {
    return null;
  }
}

/**
 * A commit base keeps nothing reachable by itself, so containment in it preserves work only while
 * another branch, remote-tracking branch or tag (not the cleanup target) contains that commit.
 */
async function commitBaseKept(cwd: string, commit: string, branchRef: string | null): Promise<boolean> {
  const result = await runGit(cwd, [
    "for-each-ref", "--format=%(refname)", "--contains", commit, "refs/heads", "refs/remotes", "refs/tags",
  ]);
  if (result.exitCode !== 0) return false;
  return result.stdout.split("\n").some(ref => ref !== "" && ref !== branchRef && !ref.endsWith("/HEAD"));
}

async function ancestry(
  cwd: string, head: string, base: ValidatedBase | null, branchRef: string | null,
): Promise<AncestryState> {
  if (!base) return unknownAncestry(UNKNOWN_BASE);
  // Containment against the target's own tip is tautological and must never authorize cleanup.
  if (branchRef !== null && branchRef === base.ref) return unknownAncestry(UNKNOWN_SELF_BASE);
  try {
    if (base.ref === base.commit && !await commitBaseKept(cwd, base.commit, branchRef)) {
      return unknownAncestry(UNKNOWN_UNKEPT_COMMIT);
    }
    const result = await runGit(cwd, ["merge-base", "--is-ancestor", head, base.commit]);
    if (result.exitCode === 0) return { kind: "contained", base };
    if (result.exitCode !== 1) return unknownAncestry();
    const commits = await aheadCommits(cwd, base.commit, head);
    return commits ? { kind: "not-contained", base, commits } : unknownAncestry();
  } catch {
    return unknownAncestry();
  }
}

async function upstreamFor(cwd: string, branchRef: string): Promise<{
  trackingRef: string; remote: string; remoteRef: string;
} | null> {
  try {
    const result = await runGit(cwd, [
      "for-each-ref", "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)", branchRef,
    ]);
    if (result.exitCode !== 0) return null;
    const record = result.stdout.replace(/\n$/, "");
    const [trackingRef, remote, remoteRef, ...extra] = record.split("\0");
    if (extra.length || !trackingRef || !remote || !remoteRef) return null;
    if (!trackingRef.startsWith(`refs/remotes/${remote}/`) || !remoteRef.startsWith("refs/heads/")) return null;
    if (remoteRef === "refs/heads/HEAD") return null;
    return { trackingRef, remote, remoteRef };
  } catch {
    return null;
  }
}

async function liveUpstreamTip(
  cwd: string, repository: RepositoryContext, upstream: { trackingRef: string; remote: string; remoteRef: string },
): Promise<{ kind: "tip"; tip: string } | { kind: "missing" } | null> {
  if (!repository.remotes.some(remote => remote.name === upstream.remote)) return null;
  let result: GitResult;
  try {
    result = await runGit(cwd, [
      "ls-remote", "--refs", "--", upstream.remote, upstream.remoteRef,
    ], { timeout: 10_000 });
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  const matches: string[] = [];
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const separator = line.indexOf("\t");
    if (separator < 0) return null;
    const oid = line.slice(0, separator);
    const ref = line.slice(separator + 1);
    if (ref !== upstream.remoteRef || !validOid(oid)) return null;
    matches.push(oid);
  }
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length !== 1) return null;
  return { kind: "tip", tip: matches[0]! };
}

async function publication(
  cwd: string, repository: RepositoryContext, branchRef: string | null, head: string,
  captureIdentity = false,
): Promise<CleanupPublication> {
  if (!branchRef) {
    return { state: unknownPublication("Detached HEAD has no local branch or upstream publication evidence."), upstreamCommit: null };
  }
  const upstream = await upstreamFor(cwd, branchRef);
  if (!upstream || upstream.remote === ".") {
    return {
      state: unknownPublication("The local branch has no verifiable remote upstream; refresh repository state and retry."),
      upstreamCommit: null,
    };
  }
  const live = await liveUpstreamTip(cwd, repository, upstream);
  if (!live) return { state: unknownPublication(), upstreamCommit: null };
  let upstreamIdentity: string | undefined;
  if (captureIdentity || live.kind === "missing") {
    // A missing-upstream authorization must also pin the configured remote URL.
    try {
      const url = await runGit(cwd, ["remote", "get-url", "--", upstream.remote]);
      if (url.exitCode !== 0 || !url.stdout) return { state: unknownPublication(), upstreamCommit: null };
      upstreamIdentity = JSON.stringify([upstream.remote, upstream.remoteRef, upstream.trackingRef, url.stdout]);
    } catch {
      return { state: unknownPublication(), upstreamCommit: null };
    }
  }
  if (live.kind === "missing") {
    if (upstreamIdentity === undefined) return { state: unknownPublication(), upstreamCommit: null };
    return { state: { kind: "upstream-deleted", upstreamRef: upstream.trackingRef }, upstreamCommit: null, upstreamIdentity };
  }
  const localTip = await verifiedCommit(cwd, live.tip);
  if (!localTip) {
    return {
      state: unknownPublication("The live upstream commit is not available locally; fetch it explicitly and retry."),
      upstreamCommit: null,
    };
  }
  try {
    const result = await runGit(cwd, ["merge-base", "--is-ancestor", head, localTip]);
    if (result.exitCode === 0) return { state: { kind: "published", upstreamRef: upstream.trackingRef }, upstreamCommit: localTip,
      ...(upstreamIdentity === undefined ? {} : { upstreamIdentity }) };
    if (result.exitCode !== 1) return { state: unknownPublication(), upstreamCommit: null };
    const commits = await aheadCommits(cwd, localTip, head);
    return commits
      ? { state: { kind: "unpublished", commits }, upstreamCommit: localTip }
      : { state: unknownPublication(), upstreamCommit: null };
  } catch {
    return { state: unknownPublication(), upstreamCommit: null };
  }
}

/** Read fresh cleanup evidence. The selected Worktree is a lookup key, never authority. */
async function readCleanupEvidenceImpl(
  repository: RepositoryContext, selected: Worktree, config: RepositoryConfig,
  includePublication: boolean, explicitBase?: string,
): Promise<CleanupEvidence> {
  if (!isAbsolute(selected.path)) throw new Error("Cleanup requires an absolute registered worktree path.");

  let freshRepository: RepositoryContext;
  try {
    freshRepository = await discoverRepository(repository.primaryWorktreeRoot);
  } catch {
    throw new Error("Cannot verify the primary repository identity for cleanup; repair it and retry.");
  }
  if (!samePath(freshRepository.primaryWorktreeRoot, repository.primaryWorktreeRoot) ||
      !samePath(freshRepository.commonGitDir, repository.commonGitDir)) {
    throw new Error("Repository identity changed since selection; rediscover the repository and retry cleanup.");
  }

  let inventory: readonly WorktreeInventory[];
  try {
    inventory = await listWorktreeInventory(freshRepository);
  } catch {
    throw new Error("Cannot read the current Git worktree inventory; refresh the worktree list and retry cleanup.");
  }
  const matches = inventory.filter(tree => samePath(tree.path, selected.path));
  if (matches.length !== 1) {
    throw new Error("Selected worktree is not uniquely registered in this repository; refresh the worktree list and retry.");
  }
  const phase = new WorktreeReadPhase(freshRepository);
  const tree = await inspectWorktree(freshRepository, matches[0]!, phase);
  if (tree.isPrimary) throw new Error(`Cannot clean up the primary worktree at ${tree.path}.`);
  if (!tree.pathExists) throw new Error(`Worktree path is missing at ${tree.path}; restore or repair it before retrying cleanup.`);
  if (tree.prunable !== null) throw new Error(`Worktree at ${tree.path} is prunable or stale; repair its registration before cleanup.`);
  if (tree.locked !== null) throw new Error(`Worktree at ${tree.path} is locked; unlock it explicitly before cleanup.`);
  if (tree.branch !== selected.branch || tree.head !== selected.head) {
    throw new Error(`Worktree selection changed at ${tree.path}; refresh the worktree list and retry cleanup.`);
  }
  try {
    await phase.gitDirectory(tree);
  } catch {
    throw new Error(`Worktree identity at ${tree.path} could not be verified; restore its original metadata before cleanup.`);
  }
  const operation = await gitOperation(tree.path);
  if (operation !== null) throw new Error(`Cannot clean up a worktree with an in-progress ${operation}; finish or abort it explicitly first.`);
  if (tree.head === null) {
    throw new Error(`Worktree at ${tree.path} has an unborn or unproven HEAD; create a commit before cleanup.`);
  }

  let headFromWorktree: string;
  try {
    const currentHead = await runGit(tree.path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (currentHead.exitCode !== 0 || !validOid(currentHead.stdout)) {
      throw new Error("Could not verify the worktree HEAD.");
    }
    headFromWorktree = currentHead.stdout;
  } catch {
    throw new Error(`Could not verify the current commit at ${tree.path}; refresh repository state and retry cleanup.`);
  }
  if (headFromWorktree !== tree.head) {
    throw new Error(`Worktree HEAD changed at ${tree.path}; refresh the worktree list and retry cleanup.`);
  }

  let branchRef: string | null = null;
  try {
    const symbolic = await runGit(tree.path, ["symbolic-ref", "--quiet", "HEAD"]);
    if (symbolic.exitCode === 0) {
      if (!symbolic.stdout.startsWith("refs/heads/")) {
        throw new Error("Worktree HEAD is not a local branch.");
      }
      branchRef = symbolic.stdout;
    } else if (symbolic.exitCode !== 1) {
      throw new Error("Could not read worktree branch.");
    }
  } catch {
    throw new Error(`Could not verify the branch identity at ${tree.path}; refresh the worktree list and retry cleanup.`);
  }
  const expectedBranch = branchRef === null ? null : branchRef.slice("refs/heads/".length);
  if (expectedBranch !== tree.branch) {
    throw new Error(`Worktree branch changed at ${tree.path}; refresh the worktree list and retry cleanup.`);
  }

  if (branchRef !== null) {
    const branchCommit = await verifiedCommit(freshRepository.primaryWorktreeRoot, branchRef);
    if (!branchCommit || branchCommit !== headFromWorktree) {
      throw new Error(`Local branch changed at ${tree.path}; refresh the worktree list and retry cleanup.`);
    }
  }

  const association = await readBaseAssociation(freshRepository, tree, phase);
  if (association.kind === "invalid" && (association.reason !== "stale" || explicitBase === undefined)) {
    throw new Error("Cannot read saved base association; inspect the worktree's private Git metadata, then select a replacement with --base <ref>.");
  }
  const saved = association.kind === "assigned" ? association.ref : association.kind === "commit" ? association.commit : undefined;
  const baseInput = explicitBase ?? saved;
  let base: ValidatedBase | null = null;
  try {
    // A saved commit is pinned: it is checked as is, never refreshed, and a missing one stops cleanup.
    base = await resolveBase(freshRepository, config, baseInput);
    if (explicitBase === undefined && saved !== undefined && base.ref !== saved) {
      throw new Error("Saved base branch is missing; select a replacement with --base <ref> and retry.");
    }
  } catch (error) {
    if (baseInput !== undefined) throw error;
    // An invalid or ambiguous base is explanatory unknown evidence, never permission.
  }
  if (baseInput !== undefined && branchRef !== null && base?.ref === branchRef) {
    throw new Error(UNKNOWN_SELF_BASE);
  }
  const [ancestryState, publicationEvidence] = await Promise.all([
    ancestry(freshRepository.primaryWorktreeRoot, headFromWorktree, base, branchRef),
    includePublication
      ? publication(freshRepository.primaryWorktreeRoot, freshRepository, branchRef, headFromWorktree,
        (config.hooks?.preDelete?.length ?? 0) > 0)
      : Promise.resolve({
        state: unknownPublication("Publication was not repeated during the final local safety check."),
        upstreamCommit: null,
      }),
  ]);
  const integration: ContentIntegrationState = branchRef !== null && ancestryState.kind === "not-contained" &&
    await hasIntegratedContent(freshRepository.primaryWorktreeRoot, ancestryState.base, headFromWorktree)
    ? { kind: "equivalent", base: ancestryState.base }
    : { kind: "not-proven" };
  return {
    inspection: { worktree: tree, publication: publicationEvidence.state, ancestry: ancestryState, integration },
    headCommit: headFromWorktree,
    branchRef,
    upstreamCommit: publicationEvidence.upstreamCommit,
    ...("upstreamIdentity" in publicationEvidence && publicationEvidence.upstreamIdentity !== undefined
      ? { upstreamIdentity: publicationEvidence.upstreamIdentity } : {}),
    validatedBase: base,
    baseInput,
  };
}

export async function readCleanupEvidence(
  repository: RepositoryContext, selected: Worktree, config: RepositoryConfig, explicitBase?: string,
): Promise<CleanupEvidence> {
  return readCleanupEvidenceImpl(repository, selected, config, true, explicitBase);
}

/** Re-read local worktree, status, ref, and base facts without another slow remote query. */
export async function readCleanupTarget(
  repository: RepositoryContext, selected: Worktree, config: RepositoryConfig, explicitBase?: string,
): Promise<CleanupEvidence> {
  return readCleanupEvidenceImpl(repository, selected, config, false, explicitBase);
}

/** Recheck live upstream publication after final local safety reads, before removal. */
export async function readCleanupPublication(
  repository: RepositoryContext, branchRef: string | null, headCommit: string,
  captureIdentity = false,
): Promise<CleanupPublication> {
  if (branchRef === null) {
    return { state: unknownPublication("Detached HEAD has no local branch or upstream publication evidence."), upstreamCommit: null };
  }
  let freshRepository: RepositoryContext;
  try {
    freshRepository = await discoverRepository(repository.primaryWorktreeRoot);
  } catch {
    return { state: unknownPublication(), upstreamCommit: null };
  }
  if (!samePath(freshRepository.primaryWorktreeRoot, repository.primaryWorktreeRoot) ||
      !samePath(freshRepository.commonGitDir, repository.commonGitDir)) {
    return { state: unknownPublication(), upstreamCommit: null };
  }
  const currentBranchCommit = await verifiedCommit(freshRepository.primaryWorktreeRoot, branchRef);
  if (currentBranchCommit !== headCommit) {
    return {
      state: unknownPublication("The local branch changed during publication verification; refresh and retry cleanup."),
      upstreamCommit: null,
    };
  }
  return publication(freshRepository.primaryWorktreeRoot, freshRepository, branchRef, headCommit, captureIdentity);
}
