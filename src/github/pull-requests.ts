import { z } from "zod";
import type { GithubRuntime } from "./client";
import type { GithubRepository } from "./repository";
import { reviewerFields, reviewers, reviewersSchema } from "./reviewers";
import type { PullRequestReviewer } from "./reviewers";

/** A branch as GitHub names it: the repository owner that holds it and its name there. */
export interface PullRequestHead { owner: string; branch: string }

export type ChecksSummary = "passing" | "failing" | "pending" | "none";
export type CheckStatus = "passing" | "failing" | "pending" | "skipped";
export type ReviewDecision = "approved" | "changes-requested" | "review-required" | "none";

export interface PullRequestCheck { name: string; status: CheckStatus; url: string | null }

export interface PullRequestSummary {
  number: number;
  url: string;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  baseBranch: string;
  checks: { summary: ChecksSummary; runs: PullRequestCheck[] };
  review: ReviewDecision;
  /** Requested reviewers first, then people who reviewed; see reviewers(). */
  reviewers: PullRequestReviewer[];
  /** False when some reviewers could not be read, such as teams the login cannot see. */
  reviewersComplete: boolean;
  description: string;
}

export type PullRequestFailureReason = "offline" | "sign-in-needed" | "not-github" | "failed";

/** A whole lookup failed for a reason an app can act on; the message never carries a credential. */
export class PullRequestLookupFailure extends Error {
  constructor(readonly reason: PullRequestFailureReason, message: string) { super(message); }
}

/** Branches per GraphQL request, so one large repository stays well inside GitHub's query limits. */
const chunkSize = 20;
/** The newest pull requests considered per head branch name, and the checks listed per pull request. */
const pullRequestsPerHead = 10;
const checksPerPullRequest = 100;

const checkRunSchema = z.object({
  __typename: z.literal("CheckRun"), name: z.string(), status: z.string(),
  conclusion: z.string().nullable(), detailsUrl: z.string().nullable(),
});
const statusContextSchema = z.object({
  __typename: z.literal("StatusContext"), context: z.string(), state: z.string(), targetUrl: z.string().nullable(),
});
const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  baseRefName: z.string(),
  body: z.string(),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  headRefName: z.string(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable(),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({
    statusCheckRollup: z.object({
      state: z.string(),
      contexts: z.object({ nodes: z.array(z.union([checkRunSchema, statusContextSchema, z.object({ __typename: z.string() })]).nullable()) }),
    }).nullable(),
  }) }).nullable()) }),
}).extend(reviewersSchema.shape);
type PullRequestNode = z.infer<typeof pullRequestSchema>;
const connectionSchema = z.object({ nodes: z.array(pullRequestSchema.nullable()) });
const responseSchema = z.object({
  data: z.object({ repository: z.record(z.string(), connectionSchema).nullable() }).nullable().optional(),
  errors: z.array(z.object({ type: z.string().optional() })).optional(),
});

const fragment = (teams: boolean) => `fragment pr on PullRequest {
  number url title state isDraft baseRefName body reviewDecision headRefName
  headRepositoryOwner { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: ${checksPerPullRequest}) { nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl }
    ... on StatusContext { context state targetUrl }
  } } } } } }
  ${reviewerFields(teams)}
}`;

/** Branch names travel as variables, never as query text. */
function query(count: number, teams: boolean): string {
  const variables = Array.from({ length: count }, (_, index) => `$h${index}: String!`).join(", ");
  const fields = Array.from({ length: count }, (_, index) =>
    `h${index}: pullRequests(headRefName: $h${index}, first: ${pullRequestsPerHead}, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...pr } }`)
    .join("\n    ");
  return `query($owner: String!, $name: String!, ${variables}) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}\n${fragment(teams)}`;
}

function checkStatus(node: z.infer<typeof checkRunSchema> | z.infer<typeof statusContextSchema>): CheckStatus {
  if (node.__typename === "StatusContext") {
    return node.state === "SUCCESS" ? "passing" : node.state === "PENDING" || node.state === "EXPECTED" ? "pending" : "failing";
  }
  if (node.status !== "COMPLETED") return "pending";
  if (node.conclusion === "SUCCESS" || node.conclusion === "NEUTRAL") return "passing";
  if (node.conclusion === "SKIPPED") return "skipped";
  return "failing";
}

function summary(node: PullRequestNode): PullRequestSummary {
  const rollup = node.commits.nodes.at(-1)?.commit.statusCheckRollup ?? null;
  const runs = (rollup?.contexts.nodes ?? []).flatMap(check => {
    if (check === null) return [];
    const parsed = z.union([checkRunSchema, statusContextSchema]).safeParse(check);
    if (!parsed.success) return [];
    const value = parsed.data;
    return [{ name: value.__typename === "CheckRun" ? value.name : value.context, status: checkStatus(value),
      url: value.__typename === "CheckRun" ? value.detailsUrl : value.targetUrl }];
  });
  const checks: ChecksSummary = rollup === null ? "none"
    : rollup.state === "SUCCESS" ? "passing"
      : rollup.state === "PENDING" || rollup.state === "EXPECTED" ? "pending" : "failing";
  return {
    number: node.number, url: node.url, title: node.title,
    state: node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : node.isDraft ? "draft" : "open",
    baseBranch: node.baseRefName, checks: { summary: checks, runs },
    review: node.reviewDecision === "APPROVED" ? "approved"
      : node.reviewDecision === "CHANGES_REQUESTED" ? "changes-requested"
        : node.reviewDecision === "REVIEW_REQUIRED" ? "review-required" : "none",
    ...reviewers(node),
    description: node.body,
  };
}

/** Only pull requests whose head is this owner's branch; an open one wins over newer closed ones. */
function choose(nodes: readonly (PullRequestNode | null)[], head: PullRequestHead): PullRequestNode | null {
  const matching = nodes.filter((node): node is PullRequestNode => node !== null && node.headRefName === head.branch
    && node.headRepositoryOwner?.login.toLowerCase() === head.owner.toLowerCase());
  return matching.find(node => node.state === "OPEN") ?? matching[0] ?? null;
}

const timedOut = () => new PullRequestLookupFailure("offline", "GitHub did not answer in time; check connectivity and try again.");

async function post(body: unknown, token: string, runtime: GithubRuntime, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await runtime.fetch("https://api.github.com/graphql", {
      method: "POST", redirect: "error", signal, body: JSON.stringify(body),
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "timber" },
    });
  } catch {
    if (signal.aborted) throw timedOut();
    throw new PullRequestLookupFailure("offline", "Cannot reach GitHub; check connectivity and try again.");
  }
  if (!response.ok || response.redirected) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 401) {
      throw new PullRequestLookupFailure("sign-in-needed", "GitHub rejected the login; check your environment token or sign in with gh auth login.");
    }
    if (response.status === 403 || response.status === 429) {
      throw new PullRequestLookupFailure("failed", "GitHub denied access or rate limited the request; check permissions and rate limits.");
    }
    throw new PullRequestLookupFailure("failed", `GitHub request failed with status ${response.status}; try again later.`);
  }
  try { return await response.json(); } catch {
    if (signal.aborted) throw timedOut();
    throw new PullRequestLookupFailure("failed", "GitHub returned an invalid response.");
  }
}

/**
 * Reads the pull request for each head branch from one github.com repository.
 * Read-only GraphQL queries; every request shares the caller's deadline signal.
 */
export async function readPullRequests(
  repository: GithubRepository, heads: readonly PullRequestHead[], token: string, runtime: GithubRuntime, signal: AbortSignal,
): Promise<(PullRequestSummary | null)[]> {
  const chunks: PullRequestHead[][] = [];
  for (let index = 0; index < heads.length; index += chunkSize) chunks.push(heads.slice(index, index + chunkSize));
  const answers = await Promise.all(chunks.map(async chunk => {
    const variables: Record<string, string> = { owner: repository.owner, name: repository.name };
    chunk.forEach((head, index) => { variables[`h${index}`] = head.branch; });
    const ask = async (teams: boolean) => {
      const parsed = responseSchema.safeParse(await post({ query: query(chunk.length, teams), variables }, token, runtime, signal));
      if (!parsed.success) throw new PullRequestLookupFailure("failed", "GitHub returned an invalid response.");
      return parsed;
    };
    let parsed = await ask(true);
    // A login without read:org may be refused the whole query for naming team fields. Asking
    // once more without them still lists every other reviewer; teams then mark the list incomplete.
    if (!parsed.data.data?.repository && parsed.data.errors?.some(error => error.type === "INSUFFICIENT_SCOPES")) {
      parsed = await ask(false);
    }
    const found = parsed.data.data?.repository;
    if (found === null || found === undefined) {
      throw new PullRequestLookupFailure("failed", parsed.data.errors?.some(error => error.type === "NOT_FOUND")
        ? `GitHub repository ${repository.owner}/${repository.name} is missing or inaccessible to the selected account.`
        : "GitHub could not answer the pull request query.");
    }
    return chunk.map((head, index) => {
      const connection = found[`h${index}`];
      if (connection === undefined) throw new PullRequestLookupFailure("failed", "GitHub returned an invalid response.");
      const node = choose(connection.nodes, head);
      return node === null ? null : summary(node);
    });
  }));
  return answers.flat();
}
