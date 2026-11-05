import { readGithubToken } from "./auth";
import type { GithubRepository } from "./repository";

export interface GithubTicket { key: string; title: string; url: string }
export interface GithubRuntime {
  token: (signal: AbortSignal) => Promise<string>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs: number;
}
const defaultRuntime: GithubRuntime = { token: readGithubToken, fetch: (url, init) => fetch(url, init), timeoutMs: 10_000 };
const malformed = () => new Error("GitHub returned an invalid response; no workspace was created.");

export class GithubLookupFailure extends Error {
  constructor(message: string, readonly reason?: "not-found") { super(message); }
}

async function request<T>(path: string, runtime: GithubRuntime, validate: (body: unknown) => T): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("GitHub lookup timed out; no workspace was created."));
      controller.abort();
    }, runtime.timeoutMs);
  });
  const operation = async () => {
    const token = await runtime.token(controller.signal);
    controller.signal.throwIfAborted();
    let response: Response;
    try {
      response = await runtime.fetch(`https://api.github.com${path}`, {
        method: "GET", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "timber" },
      });
    } catch { throw new Error("GitHub network or redirect failure; check connectivity and retry explicitly."); }
    controller.signal.throwIfAborted();
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401) throw new Error("GitHub authentication failed; check your environment token or run timber setup.");
      if (response.status === 403 || response.status === 429) throw new Error("GitHub denied access or rate limited the request; check permissions and rate limits.");
      if (response.status === 404 || response.status === 410) throw new GithubLookupFailure(
        "GitHub issue is missing or inaccessible to the selected account.",
        response.status === 404 && path.startsWith("/repos/") ? "not-found" : undefined);
      throw new Error("GitHub request failed or redirected; check the selected repository and try again.");
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw malformed(); }
    controller.signal.throwIfAborted();
    return validate(body);
  };
  try { return await Promise.race([operation(), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

export async function resolveGithubTicket(repo: GithubRepository, number: number, allowClosed: boolean,
  runtime: GithubRuntime = defaultRuntime): Promise<GithubTicket> {
  return request(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues/${number}`, runtime, body => {
    if (typeof body !== "object" || body === null || !("number" in body) || body.number !== number
      || !("title" in body) || typeof body.title !== "string" || !body.title.trim()
      || !("state" in body) || typeof body.state !== "string" || !["open", "closed"].includes(body.state) || "pull_request" in body) throw malformed();
    if (body.state === "closed" && !allowClosed) {
      throw new Error(`GitHub issue #${number} is closed. To create a worktree anyway, rerun with -c.`);
    }
    return { key: `GH-${number}`, title: body.title,
      url: `https://github.com/${repo.owner}/${repo.name}/issues/${number}` };
  });
}

export async function checkGithubConnection(runtime: GithubRuntime = defaultRuntime): Promise<string> {
  return request("/user", runtime, body => {
    if (typeof body !== "object" || body === null || !("login" in body) || typeof body.login !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(body.login)) throw malformed();
    return body.login;
  });
}
