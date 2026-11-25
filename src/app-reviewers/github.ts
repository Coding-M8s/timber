import { z } from "zod";
import { githubHeaders, IssueReadFailure, json, send } from "../app-issue/trackers";
import type { MissingWording } from "../app-issue/trackers";
import type { GithubRuntime } from "../github/client";
import type { GithubRepository } from "../github/repository";
import { parseGithubReviewer } from "../github/review-requests";
import { candidate, maxPages, ReviewerListFailure, tooMany } from "./lists";
import type { ReviewerHost } from "./lists";

const api = "https://api.github.com";
const unreadable = "GitHub returned a list Timber could not read; try again later.";

const wording = (forbidden: string, notFound: string): MissingWording => ({ forbidden, notFound, unreadable,
  redirected: "GitHub redirected the request; the repository may have been renamed. Update the remote's URL." });

const missing = "GitHub has no repository at the remote, or hides this list from the login.";
const collaboratorWording = wording("The GitHub login cannot list this repository's collaborators; that needs write access.", missing);
const teamWording = wording("The GitHub login cannot list this repository's teams; check its access and the token's read:org scope.", missing);
const accountWording = wording("The GitHub login cannot read its own account, so the signed-in user may be listed.", "GitHub could not find the signed-in account, so the signed-in user may be listed.");

const collaborator = z.object({ login: z.string(), permissions: z.object({ push: z.boolean() }) });
const team = z.object({ slug: z.string() });
const user = z.object({ login: z.string().min(1) });

/** The lists of one github.com repository, read with one login. */
export function githubReviewers(base: GithubRepository, token: () => Promise<string>, runtime: Pick<GithubRuntime, "fetch">,
  signal: AbortSignal): ReviewerHost {
  const get = async (url: string, missingWording: MissingWording) => {
    const login = await token();
    try {
      const response = await send("github", runtime, url, { method: "GET", headers: githubHeaders(login) }, signal);
      const body = await json("github", response, undefined, missingWording);
      const next = /<([^>]+)>;\s*rel="next"/u.exec(response.headers.get("link") ?? "")?.[1] ?? null;
      return { body, next };
    } catch (error) {
      if (error instanceof IssueReadFailure) throw new ReviewerListFailure(error.reason, error.message);
      throw error;
    }
  };
  const pages = async <T>(first: string, schema: z.ZodType<T>, missingWording: MissingWording, each: (item: T) => void) => {
    let url: string | null = first;
    let damaged = false;
    for (let page = 0; url !== null; page++) {
      if (page === maxPages) throw tooMany("GitHub");
      const result: { body: unknown; next: string | null } = await get(url, missingWording);
      if (!Array.isArray(result.body)) throw new ReviewerListFailure("failed", unreadable);
      for (const value of result.body) {
        const item = schema.safeParse(value);
        if (item.success) each(item.data); else damaged = true;
      }
      // Follow only GitHub's own API; a next link elsewhere would send the login to another host.
      if (result.next !== null && !result.next.startsWith(`${api}/`)) throw new ReviewerListFailure("failed", unreadable);
      url = result.next;
    }
    if (damaged) throw new ReviewerListFailure("failed", unreadable);
  };
  const repository = `${api}/repos/${encodeURIComponent(base.owner)}/${encodeURIComponent(base.name)}`;
  return {
    account: async () => {
      const parsed = user.safeParse((await get(`${api}/user`, accountWording)).body);
      if (!parsed.success) throw new ReviewerListFailure("failed", "GitHub returned an account Timber could not read, so the signed-in user may be listed.");
      return parsed.data.login;
    },
    lists: [
      { name: "collaborators", read: add => pages(`${repository}/collaborators?permission=push&per_page=100`, collaborator, collaboratorWording, item => {
        // The filter is checked here too, not trusted. A bot's login cannot be requested.
        if (item.permissions.push && parseGithubReviewer(item.login)?.kind === "user") add(candidate("user", item.login));
      }) },
      { name: "teams", read: add => pages(`${repository}/teams?per_page=100`, team, teamWording, item => {
        const name = `${base.owner}/${item.slug}`;
        if (parseGithubReviewer(name)?.kind === "team") add(candidate("team", name));
      }) },
    ],
  };
}
