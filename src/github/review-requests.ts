import { request, type GithubRuntime } from "./client";
import type { GithubRepository } from "./repository";

/** A reviewer named with --reviewer: a user login or an org/team slug, or a Bitbucket account ID. */
export interface ReviewerRequest { kind: "user" | "team"; name: string }

/** What happened to one requested reviewer; the diagnostic is fixed wording, never the host's text. */
export interface ReviewerOutcome extends ReviewerRequest {
  result: "requested" | "failed";
  diagnostic: string | null;
}

/** Each reviewer is its own request under the shared deadline, so the count is bounded. */
export const maxReviewers = 15;

// GitHub logins: letters, digits and single inner hyphens. Managed users add an
// underscore and an enterprise shortcode (mona_acme), so underscores are allowed too.
const login = /^[A-Za-z0-9](?:[A-Za-z0-9_]|-(?=[A-Za-z0-9_])){0,99}$/u;
// Team slugs are what GitHub derives from a team name: letters, digits, hyphens and underscores.
const teamSlug = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]){0,99}$/u;

// Atlassian account IDs are opaque, such as 5b10a2844c20165700ede21g or 557058:<uuid>; at most 128 characters.
const accountId = /^[A-Za-z0-9:_-]{1,128}$/u;

/** A user login or org/team as GitHub can be asked for it; null for anything else. */
export function parseGithubReviewer(value: string): ReviewerRequest | null {
  const parts = value.split("/");
  if (parts.length === 1 && login.test(value)) return { kind: "user", name: value };
  if (parts.length === 2 && login.test(parts[0]!) && teamSlug.test(parts[1]!)) return { kind: "team", name: value };
  return null;
}

export function isBitbucketAccountId(value: string): boolean { return accountId.test(value); }

/** Validate and deduplicate --reviewer values for one host in the order given; any unusable value refuses the run. */
export function parseReviewers(values: readonly string[] | undefined, host: "github" | "bitbucket"): ReviewerRequest[] {
  const parsed: ReviewerRequest[] = [];
  const seen = new Set<string>();
  for (const raw of values ?? []) {
    const value = raw.trim();
    const reviewer: ReviewerRequest | null = host === "github" ? parseGithubReviewer(value)
      : isBitbucketAccountId(value) ? { kind: "user", name: value } : null;
    if (reviewer === null) {
      throw new Error(host === "github" ? "Each --reviewer must be a GitHub user login or org/team."
        : "Each --reviewer on bitbucket.org must be an Atlassian account ID, not a display name.");
    }
    // Logins and slugs ignore case; account IDs are opaque.
    const identity = `${reviewer.kind}\0${host === "github" ? reviewer.name.toLowerCase() : reviewer.name}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    parsed.push(reviewer);
  }
  if (parsed.length > maxReviewers) throw new Error(`Request at most ${maxReviewers} reviewers with --reviewer.`);
  return parsed;
}

const invalidResponse = "GitHub returned an invalid response to the review request; check the pull request's reviewers.";
const timedOut = "GitHub did not answer the review request in time; the reviewer may have been requested. Check the pull request.";
const unreachable = "GitHub could not be reached to request the reviewer; request them on the pull request.";

class ReviewRequestFailure extends Error {}

function rejected(code: number): Error {
  if (code === 422) return new ReviewRequestFailure("GitHub could not request this reviewer; check that they can access the repository and are not the pull request author.");
  if (code === 401) return new ReviewRequestFailure("GitHub did not accept the sign-in while requesting a reviewer; run gh auth login or check GH_TOKEN.");
  if (code === 403 || code === 429) return new ReviewRequestFailure("GitHub denied access or rate limited the request while requesting a reviewer; check repository permissions and rate limits.");
  if (code === 404 || code === 410) return new ReviewRequestFailure("GitHub could not find the pull request or the team while requesting a reviewer.");
  return new ReviewRequestFailure("GitHub failed while requesting a reviewer; request them on the pull request.");
}

/**
 * Request one reviewer on an open pull request. Never throws: every failure is a
 * failed outcome with fixed wording, so the pull request result never changes.
 */
export async function requestReviewer(base: GithubRepository, number: number, reviewer: ReviewerRequest,
  runtime: GithubRuntime): Promise<ReviewerOutcome> {
  const path = `/repos/${encodeURIComponent(base.owner)}/${encodeURIComponent(base.name)}/pulls/${number}/requested_reviewers`;
  const body = reviewer.kind === "user" ? { reviewers: [reviewer.name] } : { team_reviewers: [reviewer.name.split("/")[1]!] };
  try {
    await request(path, runtime, value => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ReviewRequestFailure(invalidResponse);
    }, { method: "POST", body, timeout: timedOut, malformed: () => new ReviewRequestFailure(invalidResponse), rejected });
    return { ...reviewer, result: "requested", diagnostic: null };
  } catch (error) {
    // The deadline's message is fixed; anything else unknown gets fixed wording too.
    const diagnostic = error instanceof ReviewRequestFailure ? error.message
      : error instanceof Error && error.message === timedOut ? timedOut : unreachable;
    return { ...reviewer, result: "failed", diagnostic };
  }
}
