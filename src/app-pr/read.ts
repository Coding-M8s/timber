import { realpath } from "node:fs/promises";
import { knownSecrets, safeAppDiagnostic } from "../app-config/input";
import { readGithubToken } from "../github/auth";
import type { GithubRuntime } from "../github/client";
import { PullRequestLookupFailure, readPullRequests } from "../github/pull-requests";
import type { PullRequestFailureReason, PullRequestHead, PullRequestSummary } from "../github/pull-requests";
import { readGithubRemote, resolveGithubRepository } from "../github/repository";
import type { GithubRepository } from "../github/repository";
import type { Branch, RepositoryConfig, RepositoryContext, WorktreeInventory } from "../types";

export interface AppPullRequestEntry {
  path: string;
  branch: string | null;
  isPrimary: boolean;
  outcome: "found" | "none" | "failed";
  /** Non-null only when found. */
  pullRequest: PullRequestSummary | null;
  /** Non-null only when failed. */
  reason: PullRequestFailureReason | null;
  diagnostic: string | null;
}

export interface AppPullRequestsRecord {
  schemaVersion: 1;
  repository: { commonGitDir: string; primaryWorktreeRoot: string; currentWorktreeRoot: string } | null;
  /** The github.com repository pull requests were read from; null when none was selected. */
  github: GithubRepository | null;
  /** Set when the repository or its worktrees could not be read at all. */
  diagnostic: string | null;
  worktrees: AppPullRequestEntry[];
}

/** Local reads are real Git; GitHub access is the seam. `github.timeoutMs` bounds sign-in and every request together. */
export interface AppPullRequestServices {
  discoverRepository(cwd: string): Promise<RepositoryContext>;
  loadConfig(repository: RepositoryContext): Promise<RepositoryConfig>;
  listWorktreeInventory(repository: RepositoryContext): Promise<readonly WorktreeInventory[]>;
  listBranches(repository: RepositoryContext): Promise<readonly Branch[]>;
  env: NodeJS.ProcessEnv;
  github: GithubRuntime;
}

export const defaultPullRequestTimeoutMs = 15_000;

const notGithub = "The selected remote is not a github.com repository. Pull requests are read from github.com only; check the remote setting or the origin fetch URL.";

/** Where GitHub would hold each branch: its github.com upstream when it has one, otherwise the same name in the base repository. */
async function headsFor(repository: RepositoryContext, base: GithubRepository, branches: readonly Branch[],
  names: readonly string[]): Promise<Map<string, PullRequestHead>> {
  const owners = new Map<string, Promise<string | null>>();
  const ownerOf = (remote: string) => {
    if (!owners.has(remote)) owners.set(remote, readGithubRemote(repository, remote).then(value => value.owner, () => null));
    return owners.get(remote)!;
  };
  const heads = new Map<string, PullRequestHead>();
  await Promise.all(names.map(async name => {
    const local = branches.find(branch => branch.kind === "local" && branch.name === name);
    const upstream = local?.kind === "local" ? local.upstream : null;
    const owner = upstream === null ? null : await ownerOf(upstream.remote);
    heads.set(name, owner === null || upstream === null ? { owner: base.owner, branch: name } : { owner, branch: upstream.name });
  }));
  return heads;
}

function failure(error: unknown, signal: AbortSignal): PullRequestLookupFailure {
  if (error instanceof PullRequestLookupFailure) return error;
  if (signal.aborted) return new PullRequestLookupFailure("offline", "GitHub did not answer in time; check connectivity and try again.");
  return new PullRequestLookupFailure("failed", error instanceof Error && error.message ? error.message : "Pull request lookup failed.");
}

/**
 * One read-only answer for every worktree in the repository containing `cwd`.
 * Never prompts, writes, fetches or changes a ref. GitHub is not contacted when
 * no remote is on github.com or no worktree has a branch.
 */
export async function readAppPullRequests(cwd: string, services: AppPullRequestServices): Promise<AppPullRequestsRecord> {
  const record: AppPullRequestsRecord = { schemaVersion: 1, repository: null, github: null, diagnostic: null, worktrees: [] };
  const secrets = knownSecrets(services.env);
  let repository: RepositoryContext;
  let trees: readonly WorktreeInventory[];
  let config: RepositoryConfig;
  try {
    repository = await services.discoverRepository(cwd);
    record.repository = { commonGitDir: await realpath(repository.commonGitDir),
      primaryWorktreeRoot: repository.primaryWorktreeRoot, currentWorktreeRoot: repository.currentWorktreeRoot };
    config = await services.loadConfig(repository);
    trees = [...await services.listWorktreeInventory(repository)].sort((a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } catch (error) {
    record.diagnostic = safeAppDiagnostic(error, secrets, "Cannot read this repository's worktrees.");
    return record;
  }
  record.worktrees = trees.map(tree => ({ path: tree.path, branch: tree.branch, isPrimary: tree.isPrimary,
    outcome: "none", pullRequest: null, reason: null, diagnostic: null }));
  const named = record.worktrees.filter(entry => entry.branch !== null);
  const fail = (reason: PullRequestFailureReason, message: string) => {
    const diagnostic = safeAppDiagnostic(new Error(message), secrets, "Pull request lookup failed.");
    for (const entry of named) Object.assign(entry, { outcome: "failed", reason, diagnostic });
  };
  if (named.length === 0) return record;
  let github: GithubRepository;
  try { github = await resolveGithubRepository(repository, config); } catch {
    fail("not-github", notGithub);
    return record;
  }
  record.github = github;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race keeps the time limit even if a request ignores its abort signal.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PullRequestLookupFailure("offline", "GitHub did not answer in time; check connectivity and try again."));
    }, services.github.timeoutMs);
  });
  let token = "";
  const lookup = async () => {
    const heads = await headsFor(repository, github, await services.listBranches(repository), named.map(entry => entry.branch!));
    try {
      token = await services.github.token(controller.signal);
    } catch {
      throw controller.signal.aborted
        ? new PullRequestLookupFailure("offline", "Reading the GitHub login did not finish in time; try again.")
        : new PullRequestLookupFailure("sign-in-needed",
          "No usable GitHub login. Sign in with gh auth login, or set GH_TOKEN or GITHUB_TOKEN to a valid token.");
    }
    const key = (head: PullRequestHead) => `${head.owner.toLowerCase()}\0${head.branch}`;
    const unique = [...new Map([...heads.values()].map(head => [key(head), head])).values()];
    const answers = await readPullRequests(github, unique, token, services.github, controller.signal);
    const byHead = new Map(unique.map((head, index) => [key(head), answers[index] ?? null]));
    return named.map(entry => byHead.get(key(heads.get(entry.branch!)!)) ?? null);
  };
  try {
    // Entries change only here, so a lookup still settling after the deadline cannot alter the record.
    const found = await Promise.race([lookup(), deadline]);
    named.forEach((entry, index) => {
      if (found[index]) Object.assign(entry, { outcome: "found", pullRequest: found[index] });
    });
  } catch (error) {
    const reason = failure(error, controller.signal);
    // The token read here is a secret too, even when it did not come from the environment.
    if (token) secrets.unshift(token);
    fail(reason.reason, reason.message);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return record;
}

export function defaultGithubRuntime(env: NodeJS.ProcessEnv): GithubRuntime {
  return { token: signal => readGithubToken(signal, { env }), fetch: (url, init) => fetch(url, init), timeoutMs: defaultPullRequestTimeoutMs };
}
