import { z } from "zod";
import { bitbucketRequest, type BitbucketRuntime } from "./client";
import { fullName, path, quoted, sameName } from "./pulls";
import type { BitbucketRepository } from "./repository";
import { PullRequestLookupFailure } from "../github/pull-requests";
import type { ChecksSummary, CheckStatus, PullRequestCheck, PullRequestSummary, ReviewDecision } from "../github/pull-requests";
import type { PullRequestReviewer } from "../github/reviewers";

/** A branch as Bitbucket names it: the repository that holds it and its name there. */
export interface BitbucketHead { repository: BitbucketRepository; branch: string }

/** Branches per list request, as on GitHub. */
const chunkSize = 20;
/** Pull requests per list page; Bitbucket's largest page for pull requests. */
const pullRequestsPerPage = 50;
const statusesPerPullRequest = 100;
/** Requests for build statuses running at once. */
const statusConcurrency = 4;
const closedStates = ["MERGED", "DECLINED", "SUPERSEDED"] as const;

const invalid = () => new PullRequestLookupFailure("failed", "Bitbucket returned an invalid response.");

const pullRequestSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  description: z.string().nullable().optional(),
  summary: z.object({ raw: z.string().nullable().optional() }).nullable().optional(),
  source: z.object({
    branch: z.object({ name: z.string() }),
    // Null when the source fork was deleted; that is never this branch.
    repository: z.object({ full_name: z.string() }).nullable().optional(),
  }),
  destination: z.object({ branch: z.object({ name: z.string().min(1) }) }),
  author: z.object({ uuid: z.string().nullable().optional(), account_id: z.string().nullable().optional() }).nullable().optional(),
  // Kept loose: each participant is checked on its own, so one unreadable entry leaves the rest listed.
  participants: z.array(z.unknown()).optional(),
});
type PullRequestNode = z.infer<typeof pullRequestSchema>;
const pageSchema = z.object({ values: z.array(pullRequestSchema), next: z.string().nullable().optional() });

const accountSchema = z.object({
  type: z.string().optional(),
  display_name: z.string().nullable().optional(),
  nickname: z.string().nullable().optional(),
  uuid: z.string().nullable().optional(),
  account_id: z.string().nullable().optional(),
  links: z.object({ html: z.object({ href: z.string() }).nullable().optional() }).nullable().optional(),
});
const participantSchema = z.object({
  user: z.unknown(),
  role: z.string(),
  state: z.string().nullable().optional(),
  approved: z.boolean().optional(),
});

const statusSchema = z.object({
  key: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  state: z.string(),
  url: z.string().nullable().optional(),
});
const statusPageSchema = z.object({ values: z.array(z.unknown()) });

const link = (url: string | null | undefined) => typeof url === "string" && url.startsWith("https://") ? url : null;

/** Bitbucket's answer for a status code; never its body, which is not read. */
function rejected(code: number): Error {
  if (code === 401) {
    return new PullRequestLookupFailure("sign-in-needed",
      "Bitbucket did not accept the login; check BITBUCKET_EMAIL and BITBUCKET_API_TOKEN or run timber setup.");
  }
  if (code === 403 || code === 429) {
    return new PullRequestLookupFailure("failed",
      "Bitbucket denied access or rate limited the request; check the API token's pull request scopes, repository permissions and rate limits.");
  }
  if (code === 404 || code === 410) {
    return new PullRequestLookupFailure("failed", "Bitbucket repository is missing or inaccessible to the signed-in account.");
  }
  return new PullRequestLookupFailure("failed", code === 0
    ? "Bitbucket redirected the request; Timber does not follow redirects."
    : `Bitbucket request failed with status ${code}; try again later.`);
}

/** One GET; a failure that is not Bitbucket's answer means Bitbucket was not reached in time. */
async function get<T>(route: string, runtime: BitbucketRuntime, signal: AbortSignal, validate: (body: unknown) => T): Promise<T> {
  try {
    return await bitbucketRequest(route, runtime, validate, {
      timeout: "Bitbucket did not answer in time; check connectivity and try again.",
      malformed: invalid, rejected, signal,
    });
  } catch (error) {
    if (error instanceof PullRequestLookupFailure) throw error;
    throw new PullRequestLookupFailure("offline", signal.aborted
      ? "Bitbucket did not answer in time; check connectivity and try again."
      : "Cannot reach Bitbucket; check connectivity and try again.");
  }
}

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw invalid();
  return result.data;
}

/**
 * Pull requests from these heads into the base repository, in the given states, newest
 * first, and whether Bitbucket had more than one page of them.
 */
async function list(base: BitbucketRepository, heads: readonly BitbucketHead[], states: readonly string[],
  runtime: BitbucketRuntime, signal: AbortSignal): Promise<{ nodes: PullRequestNode[]; more: boolean }> {
  // Bitbucket ignores the state parameter once q is given, so the states go in q.
  const state = states.map(value => `state = ${quoted(value)}`).join(" OR ");
  // BBQL compares case-sensitively and Bitbucket stores workspace IDs and slugs in lower case,
  // while a remote URL may carry any case.
  const branches = heads.map(head => `(source.branch.name = ${quoted(head.branch)} AND source.repository.full_name = ${
    quoted(fullName(head.repository).toLowerCase())})`).join(" OR ");
  const query = new URLSearchParams({ q: `(${state}) AND (${branches})`, sort: "-created_on",
    pagelen: String(pullRequestsPerPage), fields: "+values.participants" });
  const page = await get(`${path(base)}/pullrequests?${query}`, runtime, signal, body => parsed(pageSchema, body));
  // The filter is checked here too, not trusted.
  return { nodes: page.values.filter(node => states.includes(node.state)), more: typeof page.next === "string" && page.next !== "" };
}

/**
 * The newest pull request per head in the given states. A branch with many pull requests
 * can fill the shared page and push the others off it, so while Bitbucket has more and a
 * round answered someone, the heads still unanswered are listed again together. The
 * crowding branch was answered, so it is not asked again.
 */
async function newestPerHead(base: BitbucketRepository, heads: readonly BitbucketHead[], states: readonly string[],
  runtime: BitbucketRuntime, signal: AbortSignal): Promise<(PullRequestNode | null)[]> {
  const found: (PullRequestNode | null)[] = heads.map(() => null);
  let waiting = heads.map((_head, index) => index);
  while (waiting.length > 0) {
    const page = await list(base, waiting.map(index => heads[index]!), states, runtime, signal);
    const left = waiting.filter(index => (found[index] = newest(page.nodes, heads[index]!)) === null);
    if (!page.more || left.length === waiting.length) break;
    waiting = left;
  }
  return found;
}

const fromHead = (node: PullRequestNode, head: BitbucketHead) => node.source.branch.name === head.branch
  && typeof node.source.repository?.full_name === "string" && sameName(node.source.repository.full_name, fullName(head.repository));

/** The newest of this head's pull requests; ids grow with creation. */
function newest(nodes: readonly PullRequestNode[], head: BitbucketHead): PullRequestNode | null {
  return nodes.filter(node => fromHead(node, head)).reduce<PullRequestNode | null>(
    (best, node) => best === null || node.id > best.id ? node : best, null);
}

/** A state Bitbucket adds later is shown as pending rather than as a failure. */
function checkStatus(state: string): CheckStatus {
  if (state === "SUCCESSFUL") return "passing";
  if (state === "FAILED" || state === "STOPPED") return "failing";
  return "pending";
}

/** The head commit's build statuses, as Bitbucket lists them for the pull request. */
async function checks(base: BitbucketRepository, id: number, runtime: BitbucketRuntime,
  signal: AbortSignal): Promise<PullRequestSummary["checks"]> {
  const query = new URLSearchParams({ pagelen: String(statusesPerPullRequest) });
  const page = await get(`${path(base)}/pullrequests/${id}/statuses?${query}`, runtime, signal, body => parsed(statusPageSchema, body));
  const runs: PullRequestCheck[] = page.values.flatMap(value => {
    const status = statusSchema.safeParse(value);
    if (!status.success) return [];
    const name = status.data.name || status.data.key;
    return name ? [{ name, status: checkStatus(status.data.state), url: link(status.data.url) }] : [];
  });
  const summary: ChecksSummary = runs.length === 0 ? "none"
    : runs.some(run => run.status === "failing") ? "failing"
      : runs.some(run => run.status === "pending") ? "pending" : "passing";
  return { summary, runs };
}

/**
 * Reviewers come from participants: a REVIEWER who has neither approved nor asked for
 * changes is still requested and listed first; then everyone who approved, asked for
 * changes or took part, except the author. Bitbucket has no teams, dismissals or review history.
 */
function reviewers(node: PullRequestNode): { reviewers: PullRequestReviewer[]; reviewersComplete: boolean; review: ReviewDecision } {
  if (node.participants === undefined) return { reviewers: [], reviewersComplete: false, review: "none" };
  let complete = true;
  const requested: PullRequestReviewer[] = [];
  const others: PullRequestReviewer[] = [];
  // The author shows up as a participant once they comment; they are not reviewing.
  const seen = new Set<string>([node.author?.uuid, node.author?.account_id].filter((value): value is string => !!value));
  let anyReviewer = false;
  for (const value of node.participants) {
    const participant = participantSchema.safeParse(value);
    const account = participant.success ? accountSchema.safeParse(participant.data.user) : null;
    const name = account?.success ? account.data.display_name || account.data.nickname : null;
    const identity = account?.success ? account.data.uuid || account.data.account_id || null : null;
    if (!participant.success || !account?.success || !name || !identity) { complete = false; continue; }
    if (seen.has(identity) || (account.data.account_id && seen.has(account.data.account_id))) continue;
    seen.add(identity);
    const { role, state } = participant.data;
    if (role === "REVIEWER") anyReviewer = true;
    const approved = state === "approved" || (state == null && participant.data.approved === true);
    const reviewer: PullRequestReviewer = {
      kind: account.data.type === "app_user" ? "bot" : "user", name, url: link(account.data.links?.html?.href),
      state: state === "changes_requested" ? "changes-requested" : approved ? "approved" : role === "REVIEWER" ? "requested" : "commented",
    };
    (reviewer.state === "requested" ? requested : others).push(reviewer);
  }
  const listed = [...requested, ...others];
  const review: ReviewDecision = listed.some(reviewer => reviewer.state === "changes-requested") ? "changes-requested"
    : listed.some(reviewer => reviewer.state === "approved") ? "approved" : anyReviewer ? "review-required" : "none";
  return { reviewers: listed, reviewersComplete: complete, review };
}

function summary(base: BitbucketRepository, node: PullRequestNode, read: PullRequestSummary["checks"]): PullRequestSummary {
  const { reviewers: listed, reviewersComplete, review } = reviewers(node);
  return {
    number: node.id,
    url: `https://bitbucket.org/${encodeURIComponent(base.owner)}/${encodeURIComponent(base.name)}/pull-requests/${node.id}`,
    title: node.title,
    state: node.state === "OPEN" ? (node.draft === true ? "draft" : "open") : node.state === "MERGED" ? "merged" : "closed",
    baseBranch: node.destination.branch.name,
    checks: read, review, reviewers: listed, reviewersComplete,
    description: node.description ?? node.summary?.raw ?? "",
  };
}

async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]!); }
  }));
  return results;
}

/**
 * Reads the pull request for each head branch from one bitbucket.org repository.
 * Per 20 branches one request lists open pull requests, then one lists the merged,
 * declined and superseded ones for the branches with none open, so an open pull
 * request always wins over newer closed ones.
 * Build statuses are read only for open and draft pull requests. The runtime's
 * login must already be read; every request shares the caller's deadline signal.
 */
export async function readBitbucketPullRequests(base: BitbucketRepository, heads: readonly BitbucketHead[],
  runtime: BitbucketRuntime, signal: AbortSignal): Promise<(PullRequestSummary | null)[]> {
  const chunks: BitbucketHead[][] = [];
  for (let index = 0; index < heads.length; index += chunkSize) chunks.push(heads.slice(index, index + chunkSize));
  const chosen = (await Promise.all(chunks.map(async chunk => {
    const open = await newestPerHead(base, chunk, ["OPEN"], runtime, signal);
    // Only branches without an open pull request need the others.
    const rest = chunk.filter((_head, index) => open[index] === null);
    const closed = rest.length === 0 ? [] : await newestPerHead(base, rest, closedStates, runtime, signal);
    let next = 0;
    return open.map(node => node ?? closed[next++] ?? null);
  }))).flat();
  const none: PullRequestSummary["checks"] = { summary: "none", runs: [] };
  return inBatches(chosen, statusConcurrency, async node => node === null ? null
    : summary(base, node, node.state === "OPEN" ? await checks(base, node.id, runtime, signal) : none));
}
