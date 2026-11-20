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
  rejected: (status: number) => Error;
}

/** One bounded request to the fixed Bitbucket Cloud API; never retried, never redirected. */
export async function bitbucketRequest<T>(path: string, runtime: BitbucketRuntime, validate: (body: unknown) => T,
  options: BitbucketRequestOptions): Promise<T> {
  const controller = new AbortController();
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
      void response.body?.cancel().catch(() => {});
      throw options.rejected(response.redirected ? 0 : response.status);
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw options.malformed(); }
    controller.signal.throwIfAborted();
    return validate(body);
  };
  try { return await Promise.race([operation(), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}
