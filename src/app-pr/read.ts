import { realpath } from "node:fs/promises";
import { knownSecrets, safeAppDiagnostic } from "../app-config/input";
import { readGithubToken } from "../github/auth";
import type { GithubRuntime } from "../github/client";
import { PullRequestLookupFailure, readPullRequests } from "../github/pull-requests";
import type { PullRequestFailureReason, PullRequestHead, PullRequestSummary } from "../github/pull-requests";
import { pullRequestRepositoryOfRemote } from "../github/repository";
import type { GithubRepository, PullRequestRepository } from "../github/repository";
import { readBitbucketLogin } from "../bitbucket/auth";
import type { BitbucketRuntime } from "../bitbucket/client";
import type { BitbucketLogin } from "../bitbucket/credentials";
import { readBitbucketPullRequests } from "../bitbucket/pull-requests";
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
  /** The github.com or bitbucket.org repository pull requests were read from; null when none was selected. */
  pullRequestRepository: PullRequestRepository | null;
  /** Kept for existing consumers: the same repository when it is on github.com, otherwise null. */
  github: GithubRepository | null;
  /** Set when the repository or its worktrees could not be read at all. */
  diagnostic: string | null;
  worktrees: AppPullRequestEntry[];
}

/**
 * Local reads are real Git; GitHub and Bitbucket access are the seams. The selected
 * host's `timeoutMs` bounds sign-in and every request together.
 */
export interface AppPullRequestServices {
  discoverRepository(cwd: string): Promise<RepositoryContext>;
  loadConfig(repository: RepositoryContext): Promise<RepositoryConfig>;
  listWorktreeInventory(repository: RepositoryContext): Promise<readonly WorktreeInventory[]>;
  listBranches(repository: RepositoryContext): Promise<readonly Branch[]>;
  env: NodeJS.ProcessEnv;
  github: GithubRuntime;
  bitbucket: BitbucketRuntime;
}

export const defaultPullRequestTimeoutMs = 15_000;

const notSupported = "The selected remote is not a github.com or bitbucket.org repository. Pull requests are read from github.com and bitbucket.org only; check the remote setting or the origin fetch URL.";

const hostName = { github: "GitHub", bitbucket: "Bitbucket" } as const;

/** A branch on the host: the repository that holds it and its name there. */
interface Head { owner: string; name: string; branch: string }

/**
 * Where the host would hold each branch: its upstream when that remote is on the same
 * host, otherwise the same name in the base repository.
 */
async function headsFor(repository: RepositoryContext, base: PullRequestRepository, branches: readonly Branch[],
  names: readonly string[]): Promise<Map<string, Head>> {
  const remotes = new Map<string, Promise<PullRequestRepository | null>>();
  const remoteOf = (remote: string) => {
    if (!remotes.has(remote)) remotes.set(remote, pullRequestRepositoryOfRemote(repository, remote, "upstream").then(value => value, () => null));
    return remotes.get(remote)!;
  };
  const heads = new Map<string, Head>();
  await Promise.all(names.map(async name => {
    const local = branches.find(branch => branch.kind === "local" && branch.name === name);
    const upstream = local?.kind === "local" ? local.upstream : null;
    const held = upstream === null ? null : await remoteOf(upstream.remote);
    heads.set(name, held === null || upstream === null || held.host !== base.host
      ? { owner: base.owner, name: base.name, branch: name } : { owner: held.owner, name: held.name, branch: upstream.name });
  }));
  return heads;
}

function failure(error: unknown, signal: AbortSignal, host: string): PullRequestLookupFailure {
  if (error instanceof PullRequestLookupFailure) return error;
  if (signal.aborted) return new PullRequestLookupFailure("offline", `${host} did not answer in time; check connectivity and try again.`);
  return new PullRequestLookupFailure("failed", error instanceof Error && error.message ? error.message : "Pull request lookup failed.");
}

/**
 * One read-only answer for every worktree in the repository containing `cwd`.
 * Never prompts, writes, fetches or changes a ref. No host is contacted and no login
 * read when the selected remote is on neither github.com nor bitbucket.org, or no
 * worktree has a branch.
 */
export async function readAppPullRequests(cwd: string, services: AppPullRequestServices): Promise<AppPullRequestsRecord> {
  const record: AppPullRequestsRecord = { schemaVersion: 1, repository: null, pullRequestRepository: null, github: null,
    diagnostic: null, worktrees: [] };
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
  const remote = config.remote ?? (repository.remotes.some(value => value.name === "origin") ? "origin" : null);
  let base: PullRequestRepository;
  try {
    if (remote === null) throw new Error("No remote selected.");
    base = await pullRequestRepositoryOfRemote(repository, remote, "selected");
  } catch {
    fail("not-github", notSupported);
    return record;
  }
  record.pullRequestRepository = base;
  if (base.host === "github") record.github = { owner: base.owner, name: base.name };
  const host = hostName[base.host];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = () => new PullRequestLookupFailure("offline", `${host} did not answer in time; check connectivity and try again.`);
  // The race keeps the time limit even if a request ignores its abort signal.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(late()); },
      base.host === "github" ? services.github.timeoutMs : services.bitbucket.timeoutMs);
  });
  // Credentials read here are secrets too, even when they did not come from the environment.
  const read: string[] = [];
  const key = (head: Head) => `${head.owner.toLowerCase()}\0${head.name.toLowerCase()}\0${head.branch}`;
  const lookup = async () => {
    const heads = await headsFor(repository, base, await services.listBranches(repository), named.map(entry => entry.branch!));
    const unique = [...new Map([...heads.values()].map(head => [key(head), head])).values()];
    let answers: (PullRequestSummary | null)[];
    if (base.host === "github") {
      let token: string;
      try {
        token = await services.github.token(controller.signal);
      } catch {
        throw controller.signal.aborted
          ? new PullRequestLookupFailure("offline", "Reading the GitHub login did not finish in time; try again.")
          : new PullRequestLookupFailure("sign-in-needed",
            "No usable GitHub login. Sign in with gh auth login, or set GH_TOKEN or GITHUB_TOKEN to a valid token.");
      }
      read.push(token);
      const github: GithubRepository = { owner: base.owner, name: base.name };
      answers = await readPullRequests(github, unique.map((head): PullRequestHead => ({ owner: head.owner, branch: head.branch })),
        token, services.github, controller.signal);
    } else {
      let login: BitbucketLogin;
      try {
        login = await services.bitbucket.login(controller.signal);
      } catch {
        throw controller.signal.aborted
          ? new PullRequestLookupFailure("offline", "Reading the Bitbucket login did not finish in time; try again.")
          : new PullRequestLookupFailure("sign-in-needed",
            "No usable Bitbucket login. Run timber setup to save an Atlassian email and Bitbucket API token, or set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN.");
      }
      read.push(login.token, login.email);
      answers = await readBitbucketPullRequests({ owner: base.owner, name: base.name },
        unique.map(head => ({ repository: { owner: head.owner, name: head.name }, branch: head.branch })),
        { ...services.bitbucket, login: async () => login }, controller.signal);
    }
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
    const reason = failure(error, controller.signal, host);
    for (const value of read) if (value) secrets.push(value);
    secrets.sort((left, right) => right.length - left.length);
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

/** The login timber pr uses, read from `env` and the saved credentials, with the same time limit as GitHub. */
export function defaultAppBitbucketRuntime(env: NodeJS.ProcessEnv): BitbucketRuntime {
  return { login: signal => readBitbucketLogin(env, undefined, signal), fetch: (url, init) => fetch(url, init),
    timeoutMs: defaultPullRequestTimeoutMs };
}
