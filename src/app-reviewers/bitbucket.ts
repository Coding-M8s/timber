import { z } from "zod";
import { bitbucketApi, bitbucketRequest, type BitbucketRuntime } from "../bitbucket/client";
import type { BitbucketLogin } from "../bitbucket/credentials";
import { path } from "../bitbucket/pulls";
import type { BitbucketRepository } from "../bitbucket/repository";
import { isBitbucketAccountId } from "../github/review-requests";
import { candidate, maxPages, ReviewerListFailure, tooMany } from "./lists";
import type { ReviewerHost, ReviewerList } from "./lists";

const unreadable = () => new ReviewerListFailure("failed", "Bitbucket returned a list Timber could not read; try again later.");
const account = z.object({
  type: z.string().optional(),
  account_id: z.string().refine(isBitbucketAccountId),
  display_name: z.string().nullable().optional(),
  nickname: z.string().nullable().optional(),
});
// Kept loose: each entry is checked on its own, so one unreadable account leaves the rest listed.
const page = z.object({ values: z.array(z.unknown()), next: z.string().nullable().optional() });
const entry = z.object({ user: z.unknown() });

/** App accounts, and accounts Bitbucket says are no longer active. */
const cannotReview = (user: object) => ("type" in user && user.type === "app_user")
  || ("account_status" in user && typeof user.account_status === "string" && user.account_status !== "active");

/** The lists of one bitbucket.org repository, read with one login. */
export function bitbucketReviewers(base: BitbucketRepository, login: () => Promise<BitbucketLogin>, runtime: BitbucketRuntime,
  signal: AbortSignal): ReviewerHost {
  const get = async <T>(route: string, scope: string, validate: (body: unknown) => T): Promise<T> => {
    const signedIn = await login();
    try {
      return await bitbucketRequest(route, { ...runtime, login: async () => signedIn }, validate, {
        signal, timeout: "Bitbucket did not answer in time; check connectivity and try again.", malformed: unreadable,
        rejected: code => {
          if (code === 401) return new ReviewerListFailure("sign-in-needed", "Bitbucket did not accept the login; check BITBUCKET_EMAIL and BITBUCKET_API_TOKEN or run timber setup.");
          if (code === 403) return new ReviewerListFailure("forbidden", `The Bitbucket login cannot read this; check its permissions and that the API token has the ${scope} scope.`);
          if (code === 404 || code === 410) return new ReviewerListFailure("not-found", "Bitbucket has no repository or workspace at the remote, or hides it from the login.");
          if (code === 429) return new ReviewerListFailure("failed", "Bitbucket is rate limiting requests; try again later.");
          if (code === 0) return new ReviewerListFailure("failed", "Bitbucket redirected the request; Timber does not follow redirects.");
          return new ReviewerListFailure("failed", `Bitbucket answered with HTTP ${code}; try again later.`);
        },
      });
    } catch (error) {
      if (error instanceof ReviewerListFailure) throw error;
      throw new ReviewerListFailure("offline", signal.aborted ? "Bitbucket did not answer in time; check connectivity and try again."
        : "Bitbucket could not be reached; check connectivity and try again.");
    }
  };
  const list = (name: ReviewerList["name"], route: string, scope: string, defaultReviewer: boolean): ReviewerList => ({
    name,
    read: async add => {
      let url: string | null = `${route}?pagelen=100`;
      let damaged = false;
      for (let count = 0; url !== null; count++) {
        if (count === maxPages) throw tooMany("Bitbucket");
        const body: z.infer<typeof page> = await get(url, scope, value => {
          const parsed = page.safeParse(value);
          if (!parsed.success) throw unreadable();
          return parsed.data;
        });
        for (const value of body.values) {
          const row = entry.safeParse(value);
          const user = row.success ? row.data.user : undefined;
          if (typeof user === "object" && user !== null && cannotReview(user)) continue;
          const parsed = account.safeParse(user);
          if (!parsed.success) { damaged = true; continue; }
          const { account_id: id, display_name: display, nickname } = parsed.data;
          add(candidate("user", id, display || nickname || id, { defaultReviewer }));
        }
        if (!body.next) break;
        // Follow only this list on Bitbucket's own API; a next link elsewhere would send the login to another host.
        const next: string = body.next;
        if (!next.startsWith(`${bitbucketApi}/`) || new URL(next).pathname.toLowerCase() !== new URL(`${bitbucketApi}${route}`).pathname.toLowerCase()) throw unreadable();
        url = next.slice(bitbucketApi.length);
      }
      if (damaged) throw unreadable();
    },
  });
  return {
    account: () => get("/user", "read:user:bitbucket", body => {
      const parsed = z.object({ account_id: z.string().min(1) }).safeParse(body);
      if (!parsed.success) throw new ReviewerListFailure("failed", "Bitbucket returned an account Timber could not read, so the signed-in user may be listed.");
      return parsed.data.account_id;
    }),
    lists: [
      list("default-reviewers", `${path(base)}/effective-default-reviewers`, "read:pullrequest:bitbucket", true),
      list("members", `/workspaces/${encodeURIComponent(base.owner)}/members`, "read:workspace:bitbucket", false),
    ],
  };
}
