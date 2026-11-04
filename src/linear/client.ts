import { z } from "zod";
import { isJiraTicketKey } from "../jira/branch";
import { SetupCancelled } from "../setup/types";
import { readLinearKey } from "./auth";

export interface LinearTicket { key: string; title: string; url: string }
export interface LinearRuntime {
  token: (signal: AbortSignal) => Promise<string>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs: number;
}
const defaultRuntime: LinearRuntime = { token: signal => readLinearKey(undefined, undefined, signal), fetch: (url, init) => fetch(url, init), timeoutMs: 10_000 };
const malformed = () => new Error("Linear returned an invalid response; no workspace was created.");
const object = z.record(z.string(), z.unknown());

async function request<T>(query: string, variables: Record<string, string>, runtime: LinearRuntime,
  validate: (data: Record<string, unknown>) => T, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Linear lookup timed out; no workspace was created."));
      controller.abort();
    }, runtime.timeoutMs);
    cancel = () => { reject(new SetupCancelled()); controller.abort(); };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
  const operation = async () => {
    controller.signal.throwIfAborted();
    const token = await runtime.token(controller.signal);
    controller.signal.throwIfAborted();
    let response: Response;
    try {
      response = await runtime.fetch("https://api.linear.app/graphql", {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({ query, variables }),
      });
    } catch { throw new Error("Linear network or redirect failure; check connectivity and retry explicitly."); }
    controller.signal.throwIfAborted();
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401) throw new Error("Linear authentication failed; check LINEAR_API_KEY or run timber setup.");
      if (response.status === 403) throw new Error("Linear access denied; check personal API key Read permission and team access.");
      if (response.status === 404 || response.status === 410) throw new Error("Linear issue is missing or inaccessible to this account.");
      if (response.status === 429) throw new Error("Linear rate limit reached; retry explicitly later.");
      throw new Error("Linear request failed or redirected; check connectivity and permissions.");
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw malformed(); }
    controller.signal.throwIfAborted();
    const envelope = object.safeParse(body);
    if (!envelope.success) throw malformed();
    if ("errors" in envelope.data) {
      const errors = envelope.data.errors;
      if (!Array.isArray(errors) || errors.length > 0) {
        throw new Error("Linear query failed; check authentication, Read permission, issue access and rate limits. No workspace was created.");
      }
    }
    const data = object.safeParse(envelope.data.data);
    if (!data.success) throw malformed();
    return validate(data.data);
  };
  try { return await Promise.race([deadline, operation()]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); controller.abort(); }
}

const issueSchema = z.object({
  trashed: z.boolean().nullable(),
  identifier: z.string().refine(isJiraTicketKey),
  title: z.string().refine(value => value.trim().length > 0),
  url: z.string().refine(value => {
    if (/[\u0000-\u0020\u007f-\u009f\u2028\u2029]/u.test(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "linear.app" && !url.port && !url.username && !url.password;
    } catch { return false; }
  }),
  state: z.object({ type: z.string() }),
});

export async function resolveLinearTicket(key: string, runtime: LinearRuntime = defaultRuntime): Promise<LinearTicket> {
  if (!isJiraTicketKey(key)) throw new Error("Invalid Linear issue key; use an uppercase key such as ENG-123.");
  return request("query TimberLinearIssue($id: String!) { issue(id: $id) { identifier title url trashed state { type } } }", { id: key }, runtime, data => {
    if (data.issue === null) throw new Error("Linear issue is missing or inaccessible to this account.");
    const issue = issueSchema.safeParse(data.issue);
    if (!issue.success) throw malformed();
    if (issue.data.trashed) throw new Error("Linear issue is deleted; no workspace was created.");
    if (!["triage", "backlog", "unstarted", "started"].includes(issue.data.state.type)) {
      throw new Error("Linear issue is completed, canceled, duplicate or has an unsupported state; no workspace was created.");
    }
    return { key: issue.data.identifier, title: issue.data.title, url: issue.data.url };
  });
}

export async function checkLinearConnection(runtime: LinearRuntime = defaultRuntime, signal?: AbortSignal): Promise<void> {
  await request("query TimberLinearConnection { viewer { id } }", {}, runtime, data => {
    const parsed = z.object({ id: z.string().refine(value => value.trim().length > 0) }).safeParse(data.viewer);
    if (!parsed.success) throw malformed();
  }, signal);
}
