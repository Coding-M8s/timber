import { Buffer } from "node:buffer";
import { readBitbucketLogin } from "./auth";
import type { BitbucketLogin } from "./credentials";

export interface BitbucketRuntime {
  login: (signal: AbortSignal) => Promise<BitbucketLogin>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs: number;
}
export const defaultBitbucketRuntime: BitbucketRuntime = {
  login: signal => readBitbucketLogin(process.env, undefined, signal),
  fetch: (url, init) => fetch(url, init), timeoutMs: 10_000,
};

export const bitbucketApi = "https://api.bitbucket.org/2.0";

export interface BitbucketRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Diagnostic for a timeout; it says what this request leaves behind. */
  timeout: string;
  /** Diagnostic for a body that fails validation or parsing. */
  malformed: () => Error;
  /** Error for a non-success status. The response body is never echoed. */
  rejected: (status: number, body?: unknown) => Error;
  /** Statuses whose JSON body is parsed and passed to rejected; other bodies are discarded unread. */
  inspect?: readonly number[];
  /** An outer deadline; aborting it cancels this request too. */
  signal?: AbortSignal;
}

/** One bounded request to the fixed Bitbucket Cloud API; never retried, never redirected. */
export async function bitbucketRequest<T>(path: string, runtime: BitbucketRuntime, validate: (body: unknown) => T,
  options: BitbucketRequestOptions): Promise<T> {
  const controller = new AbortController();
  const outer = options.signal;
  const stop = () => controller.abort();
  outer?.addEventListener("abort", stop, { once: true });
  if (outer?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(options.timeout)); controller.abort(); }, runtime.timeoutMs);
  });
  const operation = async () => {
    const login = await runtime.login(controller.signal);
    controller.signal.throwIfAborted();
    const authorization = `Basic ${Buffer.from(`${login.email}:${login.token}`, "utf8").toString("base64")}`;
    let response: Response;
    try {
      response = await runtime.fetch(`${bitbucketApi}${path}`, {
        method: options.method ?? "GET", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/json", Authorization: authorization, "User-Agent": "timber",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch { throw new Error("Bitbucket network or redirect failure; check connectivity and retry explicitly."); }
    controller.signal.throwIfAborted();
    if (!response.ok || response.redirected) {
      if (!response.redirected && options.inspect?.includes(response.status)) {
        let body: unknown;
        try { body = await response.json(); } catch { body = undefined; }
        throw options.rejected(response.status, body);
      }
      void response.body?.cancel().catch(() => {});
      throw options.rejected(response.redirected ? 0 : response.status);
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw options.malformed(); }
    controller.signal.throwIfAborted();
    return validate(body);
  };
  try { return await Promise.race([operation(), deadline]); }
  finally { clearTimeout(timer); outer?.removeEventListener("abort", stop); controller.abort(); }
}

/** Bitbucket recognised the login but refused the scope; the sign-in itself was accepted. */
const scopeDenied = new Error("Bitbucket accepted the login but denied the account lookup.");

/** Bitbucket's own answer to a recognised login that lacks a scope, not a proxy's or firewall's 403. */
function missingScope(body: unknown): boolean {
  const record = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const error = record(record(body)?.error), required = record(error?.detail)?.required;
  return record(body)?.type === "error" && Array.isArray(required) && required.length > 0
    && required.every(scope => typeof scope === "string");
}

/**
 * One read-only GET of the current user. A token limited to the pull request
 * scopes Timber asks for cannot read the account, and Bitbucket answers 403 to a
 * login it recognised with a body naming the required scopes, so 200 and that
 * 403 both mean the login was accepted.
 * Scopes and repository access are not checked.
 */
export async function checkBitbucketConnection(runtime: BitbucketRuntime): Promise<void> {
  try {
    await bitbucketRequest("/user", runtime, body => {
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Bitbucket returned an invalid current-user response.");
    }, {
      timeout: "Bitbucket did not answer the login check in time; check connectivity and retry.",
      malformed: () => new Error("Bitbucket returned an invalid current-user response."),
      inspect: [403],
      rejected: (code, body) => {
        if (code === 403 && missingScope(body)) return scopeDenied;
        if (code === 403) return new Error("Bitbucket or a network device denied the login check; check the login, proxy and network, then retry.");
        if (code === 401) return new Error("Bitbucket did not accept the login; check the Atlassian account email and the API token.");
        if (code === 429) return new Error("Bitbucket rate limited the login check; retry later.");
        return new Error("Bitbucket failed while checking the login; retry when Bitbucket is reachable.");
      },
    });
  } catch (error) {
    if (error !== scopeDenied) throw error;
  }
}
