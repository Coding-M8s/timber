import type { IssueReadReason } from "../app-issue/trackers";

export type ReviewerListName = "collaborators" | "teams" | "code-owners" | "members" | "default-reviewers" | "account";
/** Why a list is incomplete; `no-base` only for code owners. */
export type ReviewerListReason = IssueReadReason | "no-base";

/** A classified failure of one list. The message is Timber's own wording and never carries a response body. */
export class ReviewerListFailure extends Error {
  constructor(readonly reason: ReviewerListReason, message: string) { super(message); }
}

export interface ReviewerCandidate {
  kind: "user" | "team";
  /** Exactly what `timber pr --reviewer` takes: a login, org/team, or Bitbucket account ID. */
  id: string;
  /** The same as `id` on GitHub; the display name, which is not unique, on Bitbucket. */
  name: string;
  codeOwner: boolean;
  defaultReviewer: boolean;
}

/** One list read from a host. Candidates are added as pages arrive, so a later failure keeps them. */
export interface ReviewerList {
  name: ReviewerListName;
  read(add: (candidate: ReviewerCandidate) => void): Promise<void>;
}

/** What a host answers: its lists, and who is signed in as an `id`. */
export interface ReviewerHost { lists: readonly ReviewerList[]; account(): Promise<string> }

export const maxPages = 10;
export const tooMany = (host: string) => new ReviewerListFailure("failed", `${host} listed more entries than Timber reads; the rest are missing.`);
export const candidate = (kind: "user" | "team", id: string, name = id, marks: { codeOwner?: boolean; defaultReviewer?: boolean } = {}): ReviewerCandidate =>
  ({ kind, id, name, codeOwner: marks.codeOwner === true, defaultReviewer: marks.defaultReviewer === true });
