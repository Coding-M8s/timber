import { z } from "zod";

export type ReviewerKind = "user" | "team" | "bot";
export type ReviewerState = "requested" | "approved" | "changes-requested" | "commented" | "dismissed";

export interface PullRequestReviewer { kind: ReviewerKind; name: string; state: ReviewerState; url: string | null }

/** Review requests and reviews read per pull request; more than this leaves the list incomplete. */
const requestsPerPullRequest = 100;
const reviewsPerPullRequest = 100;

/**
 * GraphQL selection for a pull request's reviewers. `teams` is false only when the login
 * lacks the scope to read team fields; teams then arrive as a bare `__typename`.
 */
export function reviewerFields(teams: boolean): string {
  const team = teams ? " ... on Team { combinedSlug url }" : "";
  return `reviewRequests(first: ${requestsPerPullRequest}) { pageInfo { hasNextPage } nodes { requestedReviewer { __typename
    ... on User { login url } ... on Bot { login url } ... on Mannequin { login url }${team} } } }
  reviews(last: ${reviewsPerPullRequest}) { pageInfo { hasPreviousPage } nodes { state author { __typename login url } } }`;
}

const actorSchema = z.object({ __typename: z.string(), login: z.string(), url: z.string() });
const teamSchema = z.object({ __typename: z.literal("Team"), combinedSlug: z.string(), url: z.string() });

/** Kept loose: each reviewer is checked on its own, so one unreadable reviewer leaves the rest listed. */
export const reviewersSchema = z.object({
  reviewRequests: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(z.object({ requestedReviewer: z.unknown() }).nullable()),
  }),
  reviews: z.object({
    pageInfo: z.object({ hasPreviousPage: z.boolean() }),
    nodes: z.array(z.object({ state: z.string(), author: z.unknown() }).nullable()),
  }),
});
export type ReviewersNode = z.infer<typeof reviewersSchema>;

const reviewStates: Record<string, ReviewerState> = {
  APPROVED: "approved", CHANGES_REQUESTED: "changes-requested", COMMENTED: "commented", DISMISSED: "dismissed",
};

function link(url: string): string | null {
  return url.startsWith("https://") ? url : null;
}

/** A person, mannequin or bot; null when GitHub did not give one that can be read. */
function actor(value: unknown): Omit<PullRequestReviewer, "state"> | null {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) return null;
  return { kind: parsed.data.__typename === "Bot" ? "bot" : "user", name: parsed.data.login, url: link(parsed.data.url) };
}

function requested(value: unknown): Omit<PullRequestReviewer, "state"> | null {
  const team = teamSchema.safeParse(value);
  if (team.success) return { kind: "team", name: team.data.combinedSlug, url: link(team.data.url) };
  return actor(value);
}

const identity = (reviewer: Omit<PullRequestReviewer, "state">) => `${reviewer.kind}\0${reviewer.name.toLowerCase()}`;

/**
 * Requested reviewers first, then people who reviewed, each once. GitHub drops a request
 * when the reviewer submits a review, so anyone still requested shows as requested. For
 * the others the latest review counts, except that a comment never hides an earlier
 * approval or request for changes. Pending reviews are drafts and are skipped.
 */
export function reviewers(node: ReviewersNode): { reviewers: PullRequestReviewer[]; reviewersComplete: boolean } {
  let complete = !node.reviewRequests.pageInfo.hasNextPage && !node.reviews.pageInfo.hasPreviousPage;
  const listed = new Map<string, PullRequestReviewer>();
  for (const request of node.reviewRequests.nodes) {
    const reviewer = request === null ? null : requested(request.requestedReviewer);
    if (reviewer === null) { complete = false; continue; }
    if (!listed.has(identity(reviewer))) listed.set(identity(reviewer), { ...reviewer, state: "requested" });
  }
  for (const review of node.reviews.nodes) {
    const state = review === null ? undefined : reviewStates[review.state];
    if (state === undefined) continue;
    // A deleted account has no author; there is nobody left to show.
    const reviewer = actor(review!.author);
    if (reviewer === null) continue;
    const current = listed.get(identity(reviewer));
    if (current === undefined) listed.set(identity(reviewer), { ...reviewer, state });
    else if (current.state !== "requested" && !(state === "commented"
      && (current.state === "approved" || current.state === "changes-requested"))) current.state = state;
  }
  return { reviewers: [...listed.values()], reviewersComplete: complete };
}
