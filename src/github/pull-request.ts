import { execa } from "execa";
import { safeDisplay } from "../display";
import { readBaseAssociation, type BaseAssociationRead } from "../git/base-metadata";
import { readIssueLink, type IssueLinkRead } from "../git/issue-link";
import { createPublishReport, planPublish, publishWorktree } from "../git/publish";
import type { CommandIO } from "../services";
import { taskIdOf } from "../task-id";
import type { RepositoryConfig, RepositoryContext, Worktree } from "../types";
import { defaultGithubRuntime, type GithubRuntime } from "./client";
import { createPullRequest, findOpenPullRequest, PullRequestFailure, type PullRequest } from "./pulls";
import { githubRepositoryOfRemote, resolveGithubRepository, type GithubRepository } from "./repository";

export type PullRequestResult = "created" | "exists" | "refused" | "failed";

/** Observed facts for the machine record; filled in as each one is verified. */
export interface PullRequestReport {
  result: PullRequestResult;
  number: number | null;
  /** Browse URL built from the validated repository and number. */
  url: string | null;
  /** Base branch name as GitHub uses it, such as "main". */
  base: string | null;
  /** True only when this run pushed commits to the remote. */
  published: boolean;
}

/** Until preflight passes, a stop is a refusal that changed nothing. */
export function createPullRequestReport(): PullRequestReport {
  return { result: "refused", number: null, url: null, base: null, published: false };
}

export interface PullRequestOptions {
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
}

/** Seams for tests; production uses Git, the saved base and the GitHub login. */
export interface PullRequestDependencies {
  readBase(repository: RepositoryContext, worktree: Worktree): Promise<BaseAssociationRead>;
  /** The saved issue link; offline, and damaged metadata is a value, never a throw. */
  readIssue(repository: RepositoryContext, worktree: Worktree): Promise<IssueLinkRead>;
  planPublish: typeof planPublish;
  publishWorktree: typeof publishWorktree;
  /** With push, the repository Git pushes to; otherwise the one it fetches from. */
  githubRepository(repository: RepositoryContext, remote: string, role: string, push: boolean): Promise<GithubRepository>;
  /** The repository GH-<number> branches take their issue from. */
  issueRepository(repository: RepositoryContext, config: RepositoryConfig): Promise<GithubRepository>;
  runtime: GithubRuntime;
}

const defaults: PullRequestDependencies = {
  readBase: (repository, worktree) => readBaseAssociation(repository, worktree),
  readIssue: (repository, worktree) => readIssueLink(repository, worktree),
  planPublish, publishWorktree,
  githubRepository: (repository, remote, role, push) => githubRepositoryOfRemote(repository, remote, role, push),
  issueRepository: (repository, config) => resolveGithubRepository(repository, config),
  runtime: defaultGithubRuntime,
};

const maxTitle = 256;
const maxBody = 65_536;
const baseHint = "pass --base <remote>/<branch>";

function validTitle(title: string | undefined): string {
  const value = title?.trim() ?? "";
  if (!value) throw new Error("Provide a pull request title with --title <text>.");
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error("The pull request title must be one line without control characters.");
  if (value.length > maxTitle) throw new Error(`The pull request title is longer than ${maxTitle} characters.`);
  return value;
}

/** check-ref-format needs no repository, so it never reads repository configuration. */
async function validBranchName(name: string): Promise<boolean> {
  if (!name || name === "HEAD") return false;
  try {
    const checked = await execa("git", ["check-ref-format", `refs/heads/${name}`], { stdin: "ignore", reject: false });
    return checked.exitCode === 0;
  } catch { return false; }
}

/** A remote-tracking or remote/branch name split at the longest configured remote name. */
function splitRemote(repository: RepositoryContext, value: string): { remote: string; branch: string } | null {
  const remote = [...repository.remotes].sort((a, b) => b.name.length - a.name.length)
    .find(candidate => value.startsWith(`${candidate.name}/`));
  return remote ? { remote: remote.name, branch: value.slice(remote.name.length + 1) } : null;
}

/** The base as a remote and the branch name GitHub expects; never fetches or saves it. */
async function resolveBase(repository: RepositoryContext, config: RepositoryConfig,
  explicit: string | undefined, saved: BaseAssociationRead | null): Promise<{ remote: string; branch: string }> {
  let resolved: { remote: string; branch: string } | null;
  if (explicit !== undefined) {
    if (explicit === "HEAD" || explicit.startsWith("refs/heads/")) {
      throw new Error(`A pull request base must be a branch on GitHub, not a local branch; ${baseHint}.`);
    }
    if (explicit.startsWith("refs/remotes/")) {
      resolved = splitRemote(repository, explicit.slice("refs/remotes/".length));
      if (!resolved) throw new Error(`The base ${safeDisplay(explicit)} names no configured remote; ${baseHint}.`);
    } else {
      resolved = splitRemote(repository, explicit);
      if (!resolved) {
        const remote = config.remote ?? (repository.remotes.length === 1 ? repository.remotes[0]!.name : null);
        if (remote === null || !repository.remotes.some(candidate => candidate.name === remote)) {
          throw new Error(`Remote is missing or ambiguous for the base; set remote in Timber configuration, or ${baseHint}.`);
        }
        resolved = { remote, branch: explicit };
      }
    }
  } else if (saved === null || saved.kind === "unassigned") {
    throw new Error(`This worktree has no saved base to open the pull request against; ${baseHint}.`);
  } else if (saved.kind === "invalid") {
    throw new Error(`The saved base cannot be used (${saved.reason}); ${baseHint}.`);
  } else if (saved.ref.startsWith("refs/heads/")) {
    throw new Error(`The saved base is the local branch ${safeDisplay(saved.ref.slice("refs/heads/".length))}, which GitHub cannot use as a pull request base; ${baseHint}.`);
  } else {
    resolved = splitRemote(repository, saved.ref.slice("refs/remotes/".length));
    if (!resolved) throw new Error(`The saved base ${safeDisplay(saved.ref)} names a remote that is no longer configured; ${baseHint}.`);
  }
  if (!await validBranchName(resolved.branch)) throw new Error(`The base branch name is not valid; ${baseHint}.`);
  return resolved;
}

const sameRepository = (a: GithubRepository, b: GithubRepository) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The issue to mention: a GitHub number with its repository when known, or a Jira/Linear key. */
type LinkedIssue = { kind: "github"; number: string; repository: GithubRepository | null } | { kind: "key"; key: string };

/**
 * The saved issue link names the issue exactly. Without one, fall back to a
 * ticket key at the start of the branch name, as TIMBER_TASK_ID does.
 */
async function linkedIssue(saved: IssueLinkRead, branch: string,
  issueRepository: () => Promise<GithubRepository | null>): Promise<LinkedIssue | null> {
  if (saved.kind === "invalid") return null;
  if (saved.kind === "linked") {
    if (saved.tracker !== "github") return { kind: "key", key: saved.key };
    // A saved GitHub link was validated as https://github.com/<owner>/<repo>/issues/<number>.
    const [, owner, name] = new URL(saved.url).pathname.split("/");
    return { kind: "github", number: saved.key, repository: owner && name ? { owner, name } : null };
  }
  const key = taskIdOf(branch);
  if (key === undefined) return null;
  const github = /^GH-(\d+)$/u.exec(key);
  return github ? { kind: "github", number: github[1]!, repository: await issueRepository() } : { kind: "key", key };
}

/** Append a reference to the linked issue unless the body already mentions it. Never a closing keyword. */
function withIssueMention(body: string, issue: LinkedIssue | null, base: GithubRepository): string {
  if (issue === null) return body;
  let mention: string;
  if (issue.kind === "github") {
    const number = issue.number;
    const issues = issue.repository;
    const qualified = issues !== null && !sameRepository(issues, base);
    // A bare #n in a pull request refers to the base repository, so it only counts there.
    const mentioned = qualified
      ? new RegExp(`${escape(`${issues.owner}/${issues.name}`)}#${number}(?!\\d)`, "iu")
      : new RegExp(`(?:^|[^\\w/-])#${number}(?!\\d)|\\bGH-${number}\\b`, "u");
    if (mentioned.test(body)) return body;
    mention = `Refs ${qualified ? `${issues.owner}/${issues.name}` : ""}#${number}`;
  } else {
    if (new RegExp(`\\b${escape(issue.key)}\\b`, "u").test(body)) return body;
    mention = `Refs ${issue.key}`;
  }
  return body ? `${body}\n\n${mention}` : mention;
}

/**
 * Publish a worktree's branch under the rules of timber publish, then open one
 * pull request for it on GitHub. Every refusal happens before the push.
 */
export async function openPullRequest(
  repository: RepositoryContext, selected: Worktree, config: RepositoryConfig, options: PullRequestOptions,
  io: CommandIO, report: PullRequestReport = createPullRequestReport(), dependencies: PullRequestDependencies = defaults,
): Promise<number> {
  const title = validTitle(options.title);
  const description = options.body ?? "";
  if (description.length > maxBody) throw new Error(`The pull request body is longer than ${maxBody} characters.`);
  const saved = options.base === undefined ? await dependencies.readBase(repository, selected) : null;
  const base = await resolveBase(repository, config, options.base, saved);
  report.base = base.branch;
  // The same read-only preflight and remote choice as the push that follows.
  const plan = await dependencies.planPublish(repository, selected, config);
  const baseRepository = await dependencies.githubRepository(repository, base.remote, "base", false);
  const headRepository = await dependencies.githubRepository(repository, plan.remote, "publish", true);
  if (sameRepository(baseRepository, headRepository) && base.branch === plan.branch) {
    throw new Error(`The base is the branch itself; ${baseHint} for the branch it should merge into.`);
  }
  const savedIssue = await dependencies.readIssue(repository, selected);
  if (savedIssue.kind === "invalid") {
    io.stderr(`warning: The saved issue link cannot be read (${savedIssue.reason}); the pull request body will not mention an issue.\n`);
  }
  const body = withIssueMention(description, await linkedIssue(savedIssue, plan.branch,
    () => dependencies.issueRepository(repository, config).catch(() => null)), baseRepository);
  if (body.length > maxBody) throw new Error(`The pull request body is longer than ${maxBody} characters.`);

  // From here a stop is an operation that broke, unless publish itself refuses.
  report.result = "failed";
  let token: Promise<string> | null = null;
  const runtime: GithubRuntime = { ...dependencies.runtime, token: signal => token ??= dependencies.runtime.token(signal) };
  // A missing login stops the run before anything is pushed.
  await runtime.token(new AbortController().signal);

  const published = createPublishReport();
  try {
    await dependencies.publishWorktree(repository, selected, config, io, published);
  } catch (error) {
    if (published.result === "refused") report.result = "refused";
    throw error;
  }
  report.published = published.result === "published";
  if (published.remote !== plan.remote) throw new Error("The branch was published to a different remote than planned; run timber pr again.");

  const found = (pull: PullRequest, result: "created" | "exists") => {
    report.result = result;
    report.number = pull.number;
    report.url = pull.url;
    report.base = pull.base;
  };
  const existing = await findOpenPullRequest(baseRepository, headRepository, plan.branch, base.branch, runtime);
  if (existing) {
    found(existing, "exists");
    io.stdout(`Pull request #${existing.number} is already open: ${existing.url}\n`);
    return 0;
  }
  let created: PullRequest;
  try {
    created = await createPullRequest(baseRepository, headRepository,
      { branch: plan.branch, baseBranch: base.branch, title, body, draft: options.draft === true }, runtime);
  } catch (error) {
    // Another client may have opened it since the lookup; report that one.
    if (!(error instanceof PullRequestFailure && error.reason === "already-exists")) throw error;
    const raced = await findOpenPullRequest(baseRepository, headRepository, plan.branch, base.branch, runtime);
    if (!raced) throw error;
    found(raced, "exists");
    io.stdout(`Pull request #${raced.number} is already open: ${raced.url}\n`);
    return 0;
  }
  found(created, "created");
  io.stdout(`Created ${created.draft ? "draft " : ""}pull request #${created.number}: ${created.url}\n`);
  return 0;
}
