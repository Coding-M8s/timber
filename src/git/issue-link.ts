import { isAbsolute, join } from "node:path";
import { samePath } from "../platform/paths";
import { isJiraTicketKey } from "../jira/branch";
import type { IssueTracker, RepositoryContext, Worktree } from "../types";
import { preparePrivateDirectory, readPrivateRecord, replacePrivateFile } from "./private-record";
import { WorktreeReadPhase, type WorktreeMetadataLocation } from "./worktree-read-phase";

/** A tracker an issue link can name; unlike the configured default tracker it is never "none". */
export type LinkedTracker = Exclude<IssueTracker, "none">;

/** The tracker issue a worktree belongs to. `key` is the GitHub number or the Jira/Linear key. */
export interface IssueLink { tracker: LinkedTracker; key: string; url: string }

export type IssueLinkRead =
  | ({ kind: "linked" } & IssueLink)
  | { kind: "none" }
  | { kind: "invalid"; reason: "malformed" | "stale" | "unreadable" };

export type IssueLinkWrite = "saved" | "unchanged";

/** Refused because the worktree already belongs to another issue. Nothing was changed. */
export class IssueLinkConflict extends Error {
  constructor(readonly existing: IssueLink) {
    super(`This worktree is already linked to ${issueSelector(existing)}; nothing was changed. Rerun with --replace-issue to replace the link.`);
  }
}

interface Location extends WorktreeMetadataLocation { file: string }

const maxRecordBytes = 4096;
const maxUrlLength = 2048;
const unsafeText = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/u;

export function issueSelector(link: Pick<IssueLink, "tracker" | "key">): string {
  return `${link.tracker}:${link.key}`;
}

export function sameIssue(left: Pick<IssueLink, "tracker" | "key">, right: Pick<IssueLink, "tracker" | "key">): boolean {
  return left.tracker === right.tracker && left.key === right.key;
}

function validKey(tracker: LinkedTracker, key: string): boolean {
  if (tracker === "github") return /^[1-9][0-9]*$/u.test(key) && Number.isSafeInteger(Number(key));
  return isJiraTicketKey(key);
}

function validUrl(tracker: LinkedTracker, key: string, value: string): boolean {
  if (value.length > maxUrlLength || unsafeText.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.href !== value || url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (tracker === "github") {
    return url.hostname === "github.com" && url.search === "" && url.hash === ""
      && /^\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/u.test(url.pathname)
      && url.pathname.endsWith(`/issues/${key}`);
  }
  if (tracker === "linear") return url.hostname === "linear.app";
  return url.pathname === `/browse/${key}`;
}

/** Accepts only links Timber could have saved; never trusts other stored content. */
export function validIssueLink(value: unknown): value is IssueLink {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const link = value as Record<string, unknown>;
  return (link.tracker === "github" || link.tracker === "jira" || link.tracker === "linear")
    && typeof link.key === "string" && validKey(link.tracker, link.key)
    && typeof link.url === "string" && validUrl(link.tracker, link.key, link.url);
}

function validRecord(value: unknown): value is IssueLink & {
  version: 1; worktreePath: string; commonGitDir: string; worktreeGitDir: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "commonGitDir,key,tracker,url,version,worktreeGitDir,worktreePath"
    && record.version === 1 && validIssueLink(record)
    && typeof record.worktreePath === "string" && typeof record.commonGitDir === "string"
    && typeof record.worktreeGitDir === "string"
    && isAbsolute(record.worktreePath) && isAbsolute(record.commonGitDir) && isAbsolute(record.worktreeGitDir);
}

async function location(
  repository: RepositoryContext, worktree: Worktree, phase = new WorktreeReadPhase(repository),
): Promise<Location> {
  const place = await phase.metadataLocation(worktree);
  return { ...place, file: join(place.directory, "issue.json") };
}

async function readAt(place: Location): Promise<IssueLinkRead> {
  const read = await readPrivateRecord(place.directory, place.file, maxRecordBytes);
  if (read.kind === "missing") return { kind: "none" };
  if (read.kind === "invalid") return read;
  const record = read.value;
  if (!validRecord(record)) return { kind: "invalid", reason: "malformed" };
  if (!samePath(record.worktreePath, place.worktreePath) || !samePath(record.commonGitDir, place.commonGitDir)
    || !samePath(record.worktreeGitDir, place.worktreeGitDir)) return { kind: "invalid", reason: "stale" };
  return { kind: "linked", tracker: record.tracker, key: record.key, url: record.url };
}

/** Offline read after checking Git's reciprocal worktree identity; reports damage as a value. */
export async function readIssueLink(
  repository: RepositoryContext, worktree: Worktree, phase?: WorktreeReadPhase,
): Promise<IssueLinkRead> {
  try { return await readAt(await location(repository, worktree, phase)); }
  catch { return { kind: "invalid", reason: "stale" }; }
}

/**
 * Save the link offline beside the saved base. A different existing link is
 * refused unless `replace` is set; damaged metadata is never overwritten.
 */
export async function writeIssueLink(
  repository: RepositoryContext, worktree: Worktree, link: IssueLink, options: { replace?: boolean } = {},
): Promise<IssueLinkWrite> {
  if (!validIssueLink(link)) throw new Error("Invalid issue link; nothing was saved.");
  if (worktree.isPrimary) throw new Error("The primary worktree cannot be linked to an issue; nothing was saved.");
  let place: Location;
  try { place = await location(repository, worktree); }
  catch { throw new Error("Cannot verify this Git worktree; no issue link saved."); }
  const previous = await readAt(place);
  if (previous.kind === "invalid" && previous.reason !== "stale") {
    throw new Error("Issue link metadata is malformed or unreadable; inspect the worktree's private Git metadata before linking an issue.");
  }
  if (previous.kind === "linked") {
    if (sameIssue(previous, link) && previous.url === link.url) return "unchanged";
    if (!sameIssue(previous, link) && options.replace !== true) {
      throw new IssueLinkConflict({ tracker: previous.tracker, key: previous.key, url: previous.url });
    }
  }
  const record = JSON.stringify({ version: 1, tracker: link.tracker, key: link.key, url: link.url,
    worktreePath: place.worktreePath, commonGitDir: place.commonGitDir, worktreeGitDir: place.worktreeGitDir }) + "\n";
  if (Buffer.byteLength(record) > maxRecordBytes) {
    throw new Error("Issue link is too large to save; nothing was saved.");
  }
  await preparePrivateDirectory(place.directory, "issue link");
  try {
    await replacePrivateFile(place.directory, place.file, "issue", record);
  } catch {
    throw new Error("Could not save the issue link; the worktree was retained. Fix Git directory permissions, then retry.");
  }
  return "saved";
}
