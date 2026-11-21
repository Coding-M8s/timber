import { bitbucketRequest, type BitbucketRuntime } from "./client";
import type { BitbucketRepository } from "./repository";
import { PullRequestFailure, type PullRequest } from "../github/pulls";

export const path = (repo: BitbucketRepository) => `/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
export const fullName = (repo: BitbucketRepository) => `${repo.owner}/${repo.name}`;
export const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const malformed = () => new PullRequestFailure("Bitbucket returned an invalid pull request response.");

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const branchName = (side: Record<string, unknown> | null) => record(side?.branch)?.name;

/** Validate one pull request; null when it is not from this branch in the head repository. */
function pullRequest(value: unknown, base: BitbucketRepository, head: BitbucketRepository, branch: string): PullRequest | null {
  const body = record(value), source = record(body?.source), destination = record(body?.destination);
  const id = body?.id, sourceBranch = branchName(source), baseBranch = branchName(destination);
  if (!body || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || typeof sourceBranch !== "string"
    || typeof baseBranch !== "string" || !baseBranch) throw malformed();
  // A source repository can be null when its fork was deleted; that is never this branch.
  const sourceRepo = record(source?.repository)?.full_name;
  if (sourceBranch !== branch || typeof sourceRepo !== "string" || !sameName(sourceRepo, fullName(head))) return null;
  return { number: id, url: `https://bitbucket.org/${base.owner}/${base.name}/pull-requests/${id}`,
    base: baseBranch, draft: body.draft === true };
}

const status = (action: string) => (code: number): Error => {
  if (code === 401) return new PullRequestFailure(`Bitbucket did not accept the sign-in while ${action}; check BITBUCKET_EMAIL and BITBUCKET_API_TOKEN or run timber setup, then retry.`);
  if (code === 403 || code === 429) return new PullRequestFailure(`Bitbucket denied access or rate limited the request while ${action}; check the API token's pull request scopes, repository permissions and rate limits.`);
  if (code === 404 || code === 410) return new PullRequestFailure(`Bitbucket could not find the repository while ${action}, or the signed-in account cannot access it.`);
  if (code === 400) return new PullRequestFailure(`Bitbucket rejected the request as invalid while ${action}; check the title, base branch and branch, then retry.`);
  return new PullRequestFailure(`Bitbucket failed while ${action}; retry when Bitbucket is reachable.`);
};

/** A BBQL string literal; Git branch names cannot hold a backslash, but escape it anyway. */
export const quoted = (value: string) => `"${value.replace(/[\\"]/gu, "\\$&")}"`;

/** The open pull request from this branch in the head repository into baseBranch, if there is one. */
export async function findOpenBitbucketPullRequest(base: BitbucketRepository, head: BitbucketRepository, branch: string,
  baseBranch: string, runtime: BitbucketRuntime): Promise<PullRequest | null> {
  // Bitbucket ignores the state parameter once q is given, so the state goes in q too.
  const query = new URLSearchParams({ state: "OPEN", pagelen: "50",
    q: `state = "OPEN" AND source.branch.name = ${quoted(branch)} AND destination.branch.name = ${quoted(baseBranch)}` });
  return bitbucketRequest(`${path(base)}/pullrequests?${query}`, runtime, body => {
    const values = record(body)?.values;
    if (!Array.isArray(values)) throw malformed();
    // The filter is checked here too, not trusted: a merged or declined pull request never counts.
    const matches = values.filter(item => record(item)?.state === "OPEN").map(item => pullRequest(item, base, head, branch))
      .filter(item => item !== null && item.base === baseBranch) as PullRequest[];
    return matches.sort((a, b) => a.number - b.number)[0] ?? null;
  }, { timeout: "Bitbucket did not answer the pull request lookup in time; nothing was created. Retry when Bitbucket is reachable.",
    malformed, rejected: status("looking up pull requests") });
}

/** Create one pull request; never retried, so a timeout leaves its outcome unknown. */
export async function createBitbucketPullRequest(base: BitbucketRepository, head: BitbucketRepository, input: {
  branch: string; baseBranch: string; title: string; body: string; draft: boolean;
}, runtime: BitbucketRuntime): Promise<PullRequest> {
  const fork = !sameName(fullName(base), fullName(head));
  return bitbucketRequest(`${path(base)}/pullrequests`, runtime, body => {
    const created = pullRequest(body, base, head, input.branch);
    if (!created) throw malformed();
    return created;
  }, {
    method: "POST",
    body: { title: input.title, description: input.body, draft: input.draft,
      source: { branch: { name: input.branch }, ...(fork ? { repository: { full_name: fullName(head) } } : {}) },
      destination: { branch: { name: input.baseBranch } } },
    timeout: "Bitbucket did not answer the pull request creation in time; it may have been created. Run timber pr again to report it.",
    // Bitbucket does not document its answer to a second open pull request for the same
    // branches, so a 400 is checked with one more lookup before it is reported.
    malformed, rejected: code => {
      const error = status("creating the pull request")(code);
      return code === 400 ? new PullRequestFailure(error.message, "already-exists") : error;
    },
  });
}
