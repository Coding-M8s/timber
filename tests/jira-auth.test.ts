import { expect, test } from "bun:test";
import { checkJiraConnection, resolveJiraTicket } from "../src/jira/client";
import type { JiraRuntime } from "../src/jira/client";
const config = { siteUrl: "https://example.atlassian.net" };
const saved = { email: "saved@example.invalid", token: "SAVED_SYNTHETIC" };
const issue = { key: "TEST-1", fields: { summary: "Synthetic title", status: { statusCategory: { key: "new" } } } };
function runtime(overrides: Partial<JiraRuntime> = {}): JiraRuntime {
  return { env: {}, timeoutMs: 100, loadCredentials: async () => saved,
    fetch: async () => Response.json(issue), ...overrides };
}

test("lazy saved credentials supply Basic auth only when no environment variable is supplied", async () => {
  let authorization = "";
  await resolveJiraTicket(config, "TEST-1", runtime({ fetch: async (_url, init) => {
    authorization = new Headers(init.headers).get("Authorization")!; return Response.json(issue);
  } }));
  expect(authorization).toBe(`Basic ${Buffer.from("saved@example.invalid:SAVED_SYNTHETIC").toString("base64")}`);
  await resolveJiraTicket(config, "TEST-1", runtime({
    env: { JIRA_EMAIL: "override@example.invalid", JIRA_API_TOKEN: "OVERRIDE_SYNTHETIC" },
    loadCredentials: async () => { throw new Error("Store must not be read"); },
    fetch: async (_url, init) => {
      expect(new Headers(init.headers).get("Authorization")).toBe(`Basic ${Buffer.from("override@example.invalid:OVERRIDE_SYNTHETIC").toString("base64")}`);
      return Response.json(issue);
    },
  }));
});

test("partial and blank environment overrides never mix with stored credentials or contact HTTP", async () => {
  for (const env of [{ JIRA_EMAIL: "override@example.invalid" }, { JIRA_API_TOKEN: "OVERRIDE_SYNTHETIC" },
    { JIRA_EMAIL: "", JIRA_API_TOKEN: "OVERRIDE_SYNTHETIC" }, { JIRA_EMAIL: "a@b", JIRA_API_TOKEN: "  " }]) {
    let read = false; let fetched = false;
    const failure = await resolveJiraTicket(config, "TEST-1", runtime({ env,
      loadCredentials: async () => { read = true; return saved; },
      fetch: async () => { fetched = true; return Response.json(issue); },
    })).then(() => new Error("Unexpected success"), error => error as Error);
    expect(failure.message).toMatch(/JIRA_EMAIL.*JIRA_API_TOKEN/);
    expect(failure.message).not.toContain("OVERRIDE_SYNTHETIC");
    expect(read).toBe(false); expect(fetched).toBe(false);
  }
});

test("missing saved pair points to setup and invalid ticket never opens store", async () => {
  await expect(resolveJiraTicket(config, "TEST-1", runtime({ loadCredentials: async () => null }))).rejects.toThrow(/setup/);
  let read = false;
  await expect(resolveJiraTicket(config, "invalid", runtime({ loadCredentials: async () => { read = true; return saved; } }))).rejects.toThrow(/ticket key/);
  expect(read).toBe(false);
});

test("connection check requests current user without mutations or exposing response details", async () => {
  let requests = 0;
  await checkJiraConnection(config, runtime({ fetch: async (url, init) => {
    requests++;
    expect(url).toBe("https://example.atlassian.net/rest/api/3/myself");
    expect(init.method).toBe("GET"); expect(init.redirect).toBe("error");
    return Response.json({ accountId: "synthetic-account", displayName: "PRIVATE_NAME" });
  } }));
  expect(requests).toBe(1);
  for (const status of [401, 403, 429, 500, 302]) {
    const error = await checkJiraConnection(config, runtime({ fetch: async () => new Response("BODY_SYNTHETIC", { status }) })).then(() => new Error("Unexpected success"), error => error as Error);
    expect(error.message).not.toContain("BODY_SYNTHETIC");
    expect(error.message).not.toContain(saved.token);
    expect(error.message).toMatch(/authentication|access denied|rate limited|unavailable|redirect/);
  }
  await expect(checkJiraConnection(config, runtime({ fetch: async () => Response.json({ accountId: " " }) }))).rejects.toThrow(/Unexpected Jira/);
  await expect(checkJiraConnection(config, runtime({ fetch: async () => { throw new Error("TRANSPORT_SYNTHETIC"); } }))).rejects.toThrow(/network/);
});

test("connection deadline and external cancellation abort HTTP", async () => {
  let signal: AbortSignal | undefined;
  const stalled = (init: RequestInit) => {
    signal = init.signal!;
    return new Promise<Response>(() => {});
  };
  await expect(checkJiraConnection(config, runtime({ timeoutMs: 10, fetch: async (_url, init) => stalled(init) }))).rejects.toThrow(/timed out/);
  expect(signal?.aborted).toBe(true);
  const controller = new AbortController();
  const checking = checkJiraConnection(config, runtime({ signal: controller.signal, fetch: async (_url, init) => {
    const response = stalled(init); controller.abort(); return response;
  } }));
  const failure = await checking.then(() => new Error("Unexpected success"), error => error as Error);
  expect(failure.name).toBe("AbortError");
  expect(failure.message).not.toMatch(/setup cancelled/i);
  expect(signal?.aborted).toBe(true);
});

test("deadline abort after a settled request does not become an unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => { rejections.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const controller = new AbortController();
    let release!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const checking = checkJiraConnection(config, runtime({
      timeoutMs: 50,
      signal: controller.signal,
      fetch: async (_url, init) => {
        init.signal?.addEventListener("abort", () => {}, { once: true });
        return pending;
      },
    }));
    release(Response.json({ accountId: "synthetic-account" }));
    await checking;
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(rejections).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
