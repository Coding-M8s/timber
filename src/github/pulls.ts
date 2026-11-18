import { request, type GithubRuntime } from "./client";
import type { GithubRepository } from "./repository";

/** A pull request as Timber reports it; the URL is built from validated parts, never taken from GitHub. */
export interface PullRequest { number: number; url: string; base: string; draft: boolean }

/** Every GitHub answer is an operation failure; none of them changed anything local. */
export class PullRequestFailure extends Error {
  constructor(message: string, readonly reason?: "already-exists") { super(message); }
}

const path = (repo: GithubRepository) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const malformed = () => new PullRequestFailure("GitHub returned an invalid pull request response.");

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate one pull request body; null when it is not for this head branch and repository. */
function pullRequest(value: unknown, base: GithubRepository, head: GithubRepository, branch: string): PullRequest | null {
  const body = record(value), headRef = record(body?.head), baseRef = record(body?.base);
  if (!body || !headRef || !baseRef || !validNumber(body.number) || typeof headRef.ref !== "string"
    || typeof baseRef.ref !== "string" || !baseRef.ref) throw malformed();
  // GitHub ignores a head filter it cannot parse and lists every pull request,
  // so the head branch and its repository are checked here, not trusted.
  const headRepo = record(headRef.repo);
  if (headRef.ref !== branch || typeof headRepo?.full_name !== "string"
    || !sameName(headRepo.full_name, `${head.owner}/${head.name}`)) return null;
  return { number: body.number, url: `https://github.com/${base.owner}/${base.name}/pull/${body.number}`,
    base: baseRef.ref, draft: body.draft === true };
}

const status = (action: string) => (code: number): Error => {
  if (code === 401) return new PullRequestFailure(`GitHub did not accept the sign-in while ${action}; run gh auth login or check GH_TOKEN, then retry.`);
  if (code === 403 || code === 429) return new PullRequestFailure(`GitHub denied access or rate limited the request while ${action}; check repository permissions and rate limits.`);
  if (code === 404 || code === 410) return new PullRequestFailure(`GitHub could not find the repository while ${action}, or the signed-in account cannot access it.`);
  return new PullRequestFailure(`GitHub failed while ${action}; retry when GitHub is reachable.`);
};

/**
 * The open pull request from this branch in the head repository into baseBranch,
 * if there is one. GitHub allows one per head and base, so other bases do not count.
 */
export async function findOpenPullRequest(base: GithubRepository, head: GithubRepository, branch: string,
  baseBranch: string, runtime: GithubRuntime): Promise<PullRequest | null> {
  const query = new URLSearchParams({ state: "open", head: `${head.owner}:${branch}`, base: baseBranch, per_page: "100" });
  return request(`${path(base)}/pulls?${query}`, runtime, body => {
    if (!Array.isArray(body)) throw malformed();
    const matches = body.map(item => pullRequest(item, base, head, branch))
      .filter(item => item !== null && item.base === baseBranch) as PullRequest[];
    // Report the lowest number for a stable answer.
    return matches.sort((a, b) => a.number - b.number)[0] ?? null;
  }, { timeout: "GitHub did not answer the pull request lookup in time; nothing was created. Retry when GitHub is reachable.",
    malformed, rejected: status("looking up pull requests") });
}

/** Map a creation rejection to fixed wording; GitHub's own text is never echoed. */
function rejectedCreation(code: number, value: unknown): Error | undefined {
  if (code !== 422) return status("creating the pull request")(code);
  const body = record(value);
  const messages = [body?.message, ...(Array.isArray(body?.errors) ? body.errors.map(item => record(item)?.message) : [])]
    .filter((item): item is string => typeof item === "string");
  const fields = Array.isArray(body?.errors) ? body.errors.map(item => record(item)?.field) : [];
  if (messages.some(text => /already exists/iu.test(text))) {
    return new PullRequestFailure("A pull request for this branch already exists.", "already-exists");
  }
  if (messages.some(text => /no commits between/iu.test(text))) {
    return new PullRequestFailure("GitHub rejected the pull request: the branch has no commits that the base does not already contain.");
  }
  if (messages.some(text => /draft/iu.test(text))) {
    return new PullRequestFailure("GitHub rejected the pull request: this repository does not support draft pull requests. Retry without --draft.");
  }
  if (fields.includes("base")) {
    return new PullRequestFailure("GitHub rejected the pull request: the base branch does not exist on GitHub. Choose another with --base.");
  }
  return new PullRequestFailure("GitHub rejected the pull request as invalid; check the title, base and branch, then retry.");
}

/** Create one pull request; never retried, so a timeout leaves its outcome unknown. */
export async function createPullRequest(base: GithubRepository, head: GithubRepository, input: {
  branch: string; baseBranch: string; title: string; body: string; draft: boolean;
}, runtime: GithubRuntime): Promise<PullRequest> {
  return request(`${path(base)}/pulls`, runtime, body => {
    const created = pullRequest(body, base, head, input.branch);
    if (!created) throw malformed();
    return created;
  }, {
    method: "POST",
    body: { title: input.title, head: `${head.owner}:${input.branch}`, base: input.baseBranch,
      body: input.body, draft: input.draft },
    timeout: "GitHub did not answer the pull request creation in time; it may have been created. Run timber pr again to report it.",
    malformed, rejected: rejectedCreation,
  });
}
