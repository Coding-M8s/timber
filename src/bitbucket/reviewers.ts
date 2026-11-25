import { z } from "zod";
import type { ReviewerOutcome, ReviewerRequest } from "../github/review-requests";
import { bitbucketRequest, type BitbucketRuntime } from "./client";
import { path } from "./pulls";
import type { BitbucketRepository } from "./repository";

const account = z.object({ uuid: z.string().min(1).nullable().optional(), account_id: z.string().min(1).nullable().optional() });
type Account = z.infer<typeof account>;
const pullRequest = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  close_source_branch: z.boolean().optional(),
  destination: z.object({ branch: z.object({ name: z.string().min(1) }) }),
  author: account.nullable().optional(),
  // Required: without the current list, an update would remove every reviewer already there.
  reviewers: z.array(account),
});
type PullRequestState = z.infer<typeof pullRequest>;

class ReviewRequestFailure extends Error {
  /** `unknown` means Bitbucket may have applied the request. */
  constructor(message: string, readonly unknown = false) { super(message); }
}

const invalidResponse = "Bitbucket returned an invalid response to the review request; check the pull request's reviewers.";
const timedOut = "Bitbucket did not answer the review request in time; the reviewer may have been requested. Check the pull request.";
const unreachable = "Bitbucket could not be reached to request the reviewer; request them on the pull request.";
const unreadable = "Bitbucket did not return the pull request's current reviewers, so none were changed; request the reviewer on the pull request.";

const rejected = (action: "reading" | "updating") => (code: number): Error => {
  // A server error can follow an applied update; every other status means it was refused.
  if (code >= 500) return new ReviewRequestFailure("Bitbucket failed while requesting a reviewer; check the pull request's reviewers.", true);
  if (code === 400 && action === "updating") return new ReviewRequestFailure("Bitbucket could not request this reviewer; check the account ID, that every reviewer is an active member with access to the repository, and that they are not the pull request author.");
  if (code === 401) return new ReviewRequestFailure("Bitbucket did not accept the sign-in while requesting a reviewer; check BITBUCKET_EMAIL and BITBUCKET_API_TOKEN or run timber setup.");
  if (code === 403 || code === 429) return new ReviewRequestFailure("Bitbucket denied access or rate limited the request while requesting a reviewer; check the API token's pull request scopes, repository permissions and rate limits.");
  if (code === 404 || code === 410) return new ReviewRequestFailure("Bitbucket could not find the pull request while requesting a reviewer.");
  return new ReviewRequestFailure("Bitbucket failed while requesting a reviewer; request them on the pull request.");
};

/** Every account has a uuid; account_id is the fallback. An account with neither cannot be kept. */
function kept(reviewer: Account): { uuid: string } | { account_id: string } {
  if (reviewer.uuid) return { uuid: reviewer.uuid };
  if (reviewer.account_id) return { account_id: reviewer.account_id };
  throw new ReviewRequestFailure(unreadable);
}

const lists = (pull: PullRequestState, id: string) => pull.reviewers.some(reviewer => reviewer.account_id === id);

/**
 * Requests reviewers on a pull request one at a time. Bitbucket has no call that adds a
 * reviewer: an update replaces the whole list, so each request sends the current
 * reviewers and one more, starting from one read of the pull request and continuing from
 * each answer. Never throws: every failure is a failed outcome with fixed wording.
 */
export function bitbucketReviewerRequests(base: BitbucketRepository,
  runtime: BitbucketRuntime): (number: number, reviewer: ReviewerRequest) => Promise<ReviewerOutcome> {
  let current: PullRequestState | null = null;
  let unread: Error | null = null;
  const parsed = (body: unknown, number: number, message: string, unknown: boolean): PullRequestState => {
    const result = pullRequest.safeParse(body);
    if (!result.success || result.data.id !== number) throw new ReviewRequestFailure(message, unknown);
    return result.data;
  };
  const read = async (route: string, number: number): Promise<PullRequestState> => {
    // A failed read is not repeated for every reviewer left.
    if (unread !== null) throw unread;
    try {
      return current ??= await bitbucketRequest(route, runtime, body => parsed(body, number, unreadable, false),
        { timeout: unreadable, malformed: () => new ReviewRequestFailure(unreadable), rejected: rejected("reading") });
    } catch (error) {
      // Nothing was sent to change the reviewers, so a timeout here is certain.
      unread = error instanceof Error && error.message === unreadable ? new ReviewRequestFailure(unreadable) : error as Error;
      throw unread;
    }
  };
  const add = async (number: number, id: string): Promise<void> => {
    const route = `${path(base)}/pullrequests/${number}`;
    const pull = await read(route, number);
    if (lists(pull, id)) return;
    if (pull.author?.account_id === id) throw new ReviewRequestFailure("The pull request's author cannot review it.");
    const answer = await bitbucketRequest(route, runtime, body => parsed(body, number, invalidResponse, true), {
      method: "PUT",
      // Everything else an update can change is sent back as read, so it cannot be reset.
      body: { title: pull.title, ...(typeof pull.description === "string" ? { description: pull.description } : {}),
        ...(pull.draft === undefined ? {} : { draft: pull.draft }),
        ...(pull.close_source_branch === undefined ? {} : { close_source_branch: pull.close_source_branch }),
        destination: { branch: { name: pull.destination.branch.name } },
        reviewers: [...pull.reviewers.map(kept), { account_id: id }] },
      timeout: timedOut, malformed: () => new ReviewRequestFailure(invalidResponse, true), rejected: rejected("updating"),
    });
    current = answer;
    if (!lists(answer, id)) throw new ReviewRequestFailure("Bitbucket did not add this reviewer; request them on the pull request.");
  };
  return async (number, reviewer) => {
    try {
      await add(number, reviewer.name);
      return { ...reviewer, result: "requested", diagnostic: null };
    } catch (error) {
      const known = error instanceof ReviewRequestFailure;
      // After an unknown outcome the reviewers are read again, so the next update keeps one that was added.
      if (!known || error.unknown) current = null;
      const diagnostic = known ? error.message : error instanceof Error && error.message === timedOut ? timedOut : unreachable;
      return { ...reviewer, result: "failed", diagnostic };
    }
  };
}
