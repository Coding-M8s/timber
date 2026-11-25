import { realpath } from "node:fs/promises";
import { knownSecrets, safeAppDiagnostic } from "../app-config/input";
import { selectWorktree } from "../app-issue/read";
import { readBitbucketLogin } from "../bitbucket/auth";
import type { BitbucketRuntime } from "../bitbucket/client";
import type { BitbucketLogin } from "../bitbucket/credentials";
import type { BaseAssociationRead } from "../git/base-metadata";
import { CodeOwnersFailure, readCodeOwners } from "../git/code-owners";
import { readGithubToken } from "../github/auth";
import type { GithubRuntime } from "../github/client";
import { splitRemote } from "../github/pull-request";
import { pullRequestRepositoryOfRemote } from "../github/repository";
import type { PullRequestRepository } from "../github/repository";
import type { RepositoryConfig, RepositoryContext, Worktree, WorktreeInventory } from "../types";
import { bitbucketReviewers } from "./bitbucket";
import { githubReviewers } from "./github";
import { candidate, ReviewerListFailure } from "./lists";
import type { ReviewerCandidate, ReviewerHost, ReviewerListName, ReviewerListReason } from "./lists";

export interface AppReviewersRecord {
  schemaVersion: 1;
  repository: { commonGitDir: string; primaryWorktreeRoot: string; currentWorktreeRoot: string } | null;
  /** The selected worktree; null when the repository could not be read or nothing matched. */
  worktree: { path: string; branch: string | null; isPrimary: boolean } | null;
  /** The repository the worktree's pull request would be opened in; null when none was selected. */
  pullRequestRepository: PullRequestRepository | null;
  /** `found` also when some lists are incomplete. */
  outcome: "found" | "failed";
  reviewers: ReviewerCandidate[];
  /** Lists that could not be read whole; `account` means the signed-in user may be listed. */
  incomplete: { list: ReviewerListName; reason: ReviewerListReason; diagnostic: string }[];
  /** Non-null only when failed. */
  reason: "not-supported" | "failed" | null;
  diagnostic: string | null;
}

/** Local reads are real Git; GitHub and Bitbucket access are the seams. `timeoutMs` bounds sign-in and every request together. */
export interface AppReviewersServices {
  discoverRepository(cwd: string): Promise<RepositoryContext>;
  loadConfig(repository: RepositoryContext): Promise<RepositoryConfig>;
  listWorktreeInventory(repository: RepositoryContext): Promise<readonly WorktreeInventory[]>;
  readBase(repository: RepositoryContext, worktree: Worktree): Promise<BaseAssociationRead>;
  env: NodeJS.ProcessEnv;
  github: Omit<GithubRuntime, "timeoutMs">;
  bitbucket: Omit<BitbucketRuntime, "timeoutMs">;
  timeoutMs: number;
}

export const defaultReviewersTimeoutMs = 10_000;

const hostName = { github: "GitHub", bitbucket: "Bitbucket" } as const;
const signIn = {
  github: "No usable GitHub login. Sign in with gh auth login, or set GH_TOKEN or GITHUB_TOKEN to a valid token.",
  bitbucket: "No usable Bitbucket login. Run timber setup to save an Atlassian email and Bitbucket API token, or set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN.",
} as const;

class NoRemote extends Error {}

/** The saved base's remote, as `timber pr` uses it; without a saved remote branch, the selected remote. */
function baseRemote(repository: RepositoryContext, config: RepositoryConfig, saved: BaseAssociationRead): string {
  if (saved.kind === "assigned" && saved.ref.startsWith("refs/remotes/")) {
    const split = splitRemote(repository, saved.ref.slice("refs/remotes/".length));
    if (split) return split.remote;
    throw new NoRemote("The saved base names a remote that is no longer configured; set another base with timber base --set.");
  }
  const remote = config.remote ?? (repository.remotes.some(value => value.name === "origin") ? "origin"
    : repository.remotes.length === 1 ? repository.remotes[0]!.name : null);
  if (remote === null) throw new NoRemote("No remote is selected; set remote in Timber configuration, or save a base on a remote with timber base --set.");
  return remote;
}

/** Code owners from local Git only, so they are listed offline and without a login. */
async function codeOwners(repository: RepositoryContext, base: PullRequestRepository, tree: WorktreeInventory,
  saved: BaseAssociationRead): Promise<ReviewerCandidate[]> {
  if (saved.kind === "unassigned") {
    throw new ReviewerListFailure("no-base", "This worktree has no saved base to compare with, so code owners are not known. Set one with timber base --set.");
  }
  if (saved.kind === "invalid") throw new ReviewerListFailure("failed", `The saved base cannot be used (${saved.reason}), so code owners are not known.`);
  if (tree.head === null) throw new ReviewerListFailure("failed", "The worktree has no commit yet, so code owners are not known.");
  let owners;
  try {
    owners = await readCodeOwners(repository, saved.kind === "commit" ? saved.commit : saved.ref, tree.head);
  } catch (error) {
    throw new ReviewerListFailure("failed", error instanceof CodeOwnersFailure ? error.message : "Cannot read code owners with Git.");
  }
  // A team can only be requested in its own organization; GitHub ignores any other as a code owner.
  return owners.filter(owner => owner.kind === "user" || owner.name.split("/")[0]!.toLowerCase() === base.owner.toLowerCase())
    .map(owner => candidate(owner.kind, owner.name, owner.name, { codeOwner: true }));
}

const marked = (entry: ReviewerCandidate) => Number(entry.codeOwner || entry.defaultReviewer);
const order = (left: ReviewerCandidate, right: ReviewerCandidate): number => {
  const a = left.name.toLowerCase(), b = right.name.toLowerCase();
  return marked(right) - marked(left) || (a < b ? -1 : a > b ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
};

/**
 * Who can review the pull request of one worktree, named by absolute path or exact
 * branch. Never prompts, writes, fetches or changes a ref, and never requests a
 * reviewer. Every list settles on its own, so one that fails leaves the others listed.
 */
export async function readAppReviewers(cwd: string, input: string, services: AppReviewersServices): Promise<AppReviewersRecord> {
  const record: AppReviewersRecord = { schemaVersion: 1, repository: null, worktree: null, pullRequestRepository: null,
    outcome: "failed", reviewers: [], incomplete: [], reason: null, diagnostic: null };
  const secrets = knownSecrets(services.env);
  const safe = (error: unknown, fallback: string) => safeAppDiagnostic(error, [...secrets].sort((a, b) => b.length - a.length), fallback);
  const fail = (reason: "not-supported" | "failed", error: unknown, fallback: string) =>
    Object.assign(record, { reason, diagnostic: safe(error, fallback) });
  let repository: RepositoryContext;
  let config: RepositoryConfig;
  let tree: WorktreeInventory | undefined;
  try {
    repository = await services.discoverRepository(cwd);
    record.repository = { commonGitDir: await realpath(repository.commonGitDir),
      primaryWorktreeRoot: repository.primaryWorktreeRoot, currentWorktreeRoot: repository.currentWorktreeRoot };
    config = await services.loadConfig(repository);
    tree = await selectWorktree(await services.listWorktreeInventory(repository), input);
  } catch (error) {
    return fail("failed", error, "Cannot read this repository's worktrees.");
  }
  if (!tree) {
    return fail("failed", new Error("No registered worktree matches that path or branch. Pass an absolute worktree path or an exact branch name from timber ls --json."), "");
  }
  const selected = tree;
  record.worktree = { path: selected.path, branch: selected.branch, isPrimary: selected.isPrimary };
  const saved = await services.readBase(repository, { ...selected, pathExists: true, status: { kind: "unknown", reason: "not inspected" } });
  let base: PullRequestRepository;
  try {
    base = await pullRequestRepositoryOfRemote(repository, baseRemote(repository, config, saved), "base");
  } catch (error) {
    return fail("not-supported", error instanceof NoRemote ? error : new Error("The worktree's remote is not a github.com or bitbucket.org repository. Check its saved base, the remote setting or the origin fetch URL."), "");
  }
  record.pullRequestRepository = base;

  const controller = new AbortController();
  const { signal } = controller;
  const late = () => new ReviewerListFailure("offline", `${hostName[base.host]} did not answer in time; check connectivity and try again.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race keeps the time limit even if a request ignores its abort signal.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(late()); }, services.timeoutMs);
  });
  deadline.catch(() => {});
  /** The login is read once, for every list. */
  const signedIn = <T>(read: () => Promise<T>, hide: (value: T) => readonly string[]): () => Promise<T> => {
    let login: Promise<T> | undefined;
    return () => login ??= read().then(value => { secrets.push(...hide(value).filter(Boolean)); return value; }, () => {
      throw signal.aborted ? late() : new ReviewerListFailure("sign-in-needed", signIn[base.host]);
    });
  };
  const host: ReviewerHost = base.host === "github"
    ? githubReviewers(base, signedIn(() => services.github.token(signal), token => [token]), services.github, signal)
    : bitbucketReviewers(base, signedIn<BitbucketLogin>(() => services.bitbucket.login(signal), login => [login.token, login.email]),
      { ...services.bitbucket, timeoutMs: services.timeoutMs }, signal);

  const key = (entry: { kind: string; id: string }) => `${entry.kind}\0${base.host === "github" ? entry.id.toLowerCase() : entry.id}`;
  const failures = new Map<ReviewerListName, ReviewerListFailure>();
  const settle = async (name: ReviewerListName, run: Promise<void>) => {
    try { await run; } catch (error) {
      failures.set(name, error instanceof ReviewerListFailure ? error : signal.aborted ? late()
        : new ReviewerListFailure("failed", "The list could not be read; try again later."));
    }
  };
  const results = host.lists.map(() => [] as ReviewerCandidate[]);
  let me: string | null = null;
  let owners: ReviewerCandidate[] = [];
  try {
    await Promise.all([
      ...host.lists.map((list, index) => settle(list.name, Promise.race([
        // A request still settling after the deadline cannot alter the record.
        list.read(entry => { if (!signal.aborted) results[index]!.push(entry); }), deadline]))),
      settle("account", Promise.race([host.account().then(id => { if (!signal.aborted) me = id; }), deadline])),
      // Git has its own time limits: the network limit must not hide what is known locally.
      ...(base.host === "github" ? [settle("code-owners", codeOwners(repository, base, selected, saved).then(list => { owners = list; }))] : []),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  const merged = new Map<string, ReviewerCandidate>();
  // The host's spelling of a login wins over the one in CODEOWNERS.
  for (const entry of [...results.flat(), ...owners]) {
    const existing = merged.get(key(entry));
    if (existing === undefined) merged.set(key(entry), { ...entry });
    else {
      existing.codeOwner ||= entry.codeOwner;
      existing.defaultReviewer ||= entry.defaultReviewer;
    }
  }
  if (me !== null) merged.delete(key({ kind: "user", id: me }));
  const names: ReviewerListName[] = [...host.lists.map(list => list.name), "code-owners", "account"];
  record.incomplete = names.flatMap(list => {
    const error = failures.get(list);
    return error === undefined ? [] : [{ list, reason: error.reason, diagnostic: safe(error, "The list could not be read; try again later.") }];
  });
  return Object.assign(record, { outcome: "found", reviewers: [...merged.values()].sort(order) });
}

export function defaultReviewerRuntimes(env: NodeJS.ProcessEnv): Pick<AppReviewersServices, "github" | "bitbucket"> {
  return {
    github: { token: signal => readGithubToken(signal, { env }), fetch: (url, init) => fetch(url, init) },
    bitbucket: { login: signal => readBitbucketLogin(env, undefined, signal), fetch: (url, init) => fetch(url, init) },
  };
}
