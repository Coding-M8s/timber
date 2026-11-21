import { readGithubToken } from "./auth";
import type { GithubRepository } from "./repository";
import type { TrackerUser } from "../types";

export interface GithubTicket { key: string; title: string; url: string; assignees?: readonly TrackerUser[] }
export interface GithubRuntime {
  token: (signal: AbortSignal) => Promise<string>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs: number;
}
export const defaultGithubRuntime: GithubRuntime = { token: readGithubToken, fetch: (url, init) => fetch(url, init), timeoutMs: 10_000 };
const malformed = () => new Error("GitHub returned an invalid response; no workspace was created.");

/** Per-call wording and verbs; defaults keep issue lookup behavior. */
export interface GithubRequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  /** Diagnostic for a timeout; it says what this request leaves behind. */
  timeout?: string;
  /** Diagnostic for a body that fails validation or parsing. */
  malformed?: () => Error;
  /** Error for a non-success status, or undefined to use the shared mapping. The body is never echoed. */
  rejected?: (status: number, body: unknown) => Error | undefined;
}

export class GithubLookupFailure extends Error {
  constructor(message: string, readonly reason?: "not-found") { super(message); }
}

export async function request<T>(path: string, runtime: GithubRuntime, validate: (body: unknown) => T,
  options: GithubRequestOptions = {}): Promise<T> {
  const invalid = options.malformed ?? malformed;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(options.timeout ?? "GitHub lookup timed out; no workspace was created."));
      controller.abort();
    }, runtime.timeoutMs);
  });
  const operation = async () => {
    const token = await runtime.token(controller.signal);
    controller.signal.throwIfAborted();
    let response: Response;
    try {
      response = await runtime.fetch(`https://api.github.com${path}`, {
        method: options.method ?? "GET", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "timber",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch { throw new Error("GitHub network or redirect failure; check connectivity and retry explicitly."); }
    controller.signal.throwIfAborted();
    if (!response.ok || response.redirected) {
      if (options.rejected && !response.redirected) {
        let rejectedBody: unknown = null;
        try { rejectedBody = await response.json(); } catch { /* an unreadable body is classified by status alone */ }
        const custom = options.rejected(response.status, rejectedBody);
        if (custom) throw custom;
      } else void response.body?.cancel().catch(() => {});
      if (response.status === 401) throw new Error("GitHub authentication failed; check your environment token or run timber setup.");
      if (response.status === 403 || response.status === 429) throw new Error("GitHub denied access or rate limited the request; check permissions and rate limits.");
      if (response.status === 404 || response.status === 410) throw new GithubLookupFailure(
        "GitHub issue is missing or inaccessible to the selected account.",
        response.status === 404 && path.startsWith("/repos/") ? "not-found" : undefined);
      throw new Error("GitHub request failed or redirected; check the selected repository and try again.");
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw invalid(); }
    controller.signal.throwIfAborted();
    return validate(body);
  };
  try { return await Promise.race([operation(), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

export async function resolveGithubTicket(repo: GithubRepository, number: number, allowClosed: boolean,
  runtime: GithubRuntime = defaultGithubRuntime): Promise<GithubTicket> {
  return request(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues/${number}`, runtime, body => {
    if (typeof body !== "object" || body === null || !("number" in body) || body.number !== number
      || !("title" in body) || typeof body.title !== "string" || !body.title.trim()
      || !("state" in body) || typeof body.state !== "string" || !["open", "closed"].includes(body.state) || "pull_request" in body) throw malformed();
    if (body.state === "closed" && !allowClosed) {
      throw new Error(`GitHub issue #${number} is closed. To create a worktree anyway, rerun with -c.`);
    }
    const assignees = githubAssignees("assignees" in body ? body.assignees : undefined);
    return { key: `GH-${number}`, title: body.title,
      url: `https://github.com/${repo.owner}/${repo.name}/issues/${number}`,
      ...(assignees === undefined ? {} : { assignees }) };
  });
}

/** Ordinary logins, Enterprise Managed User logins such as `name_short`, and app bots such as `name[bot]`. */
const githubLogin = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}(?:\[bot\])?$/u;

/** The logins in an issue's `assignees`; undefined when the field is missing or unusable. */
export function githubAssignees(value: unknown): TrackerUser[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const users: TrackerUser[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || !("login" in entry) || typeof entry.login !== "string"
      || !githubLogin.test(entry.login)) return undefined;
    users.push({ id: entry.login, name: entry.login });
  }
  return users;
}

export async function checkGithubConnection(runtime: GithubRuntime = defaultGithubRuntime): Promise<string> {
  return request("/user", runtime, body => {
    if (typeof body !== "object" || body === null || !("login" in body) || typeof body.login !== "string"
      || !githubLogin.test(body.login)) throw malformed();
    return body.login;
  });
}

/**
 * Assign one issue to `me`. Without `replace` the login is added, so an
 * assignee who appeared since the lookup is never removed; with `replace` the
 * assignee list becomes only `me`. The answer must list `me`, because GitHub
 * silently drops assignees who may not be assigned.
 */
export async function assignGithubIssue(repo: GithubRepository, number: number, me: string, replace: boolean,
  runtime: GithubRuntime = defaultGithubRuntime): Promise<void> {
  const issuePath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues/${number}`;
  const invalid = () => new Error("GitHub returned an invalid response to the assignment.");
  await request(replace ? issuePath : `${issuePath}/assignees`, runtime, body => {
    const assignees = typeof body === "object" && body !== null && "assignees" in body ? githubAssignees(body.assignees) : undefined;
    if (assignees === undefined) throw invalid();
    if (!assignees.some(user => user.id.toLowerCase() === me.toLowerCase())) {
      throw new Error("GitHub did not assign the issue; the login may lack write access to this repository.");
    }
  }, {
    method: replace ? "PATCH" : "POST",
    body: { assignees: [me] },
    timeout: "GitHub assignment timed out.",
    malformed: invalid,
    rejected: status => status === 403 || status === 422
      ? new Error(`GitHub refused the assignment (${status}); check the login's write access to this repository's issues and rate limits.`)
      : undefined,
  });
}
