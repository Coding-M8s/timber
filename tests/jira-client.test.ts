import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  findJiraSuggestions,
  JiraLookupFailure,
  resolveJiraTicket,
  type JiraRuntime,
} from "../src/jira/client";
import type { JiraConfig } from "../src/types";

const siteConfig: JiraConfig = { siteUrl: "https://example.atlassian.net" };
const credentials = { JIRA_EMAIL: "person@example.invalid", JIRA_API_TOKEN: "synthetic-token" };

function issue(key = "ABU-834", summary = "Fix login", categoryKey = "indeterminate") {
  return {
    key,
    fields: {
      summary,
      status: {
        name: "In Progress",
        statusCategory: { key: categoryKey, name: "In Progress" },
      },
      unrelated: "ignored",
    },
    unrelated: "ignored",
  };
}

function runtime(
  fetch: JiraRuntime["fetch"],
  overrides: Partial<JiraRuntime> = {},
): JiraRuntime {
  return { env: credentials, fetch, timeoutMs: 10_000, ...overrides };
}

async function errorMessage(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    error => error instanceof Error ? error.message : "unknown error",
  );
}

function response(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

test("uses the Jira v3 summary and status fields with Basic auth and no redirects", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const ticket = await resolveJiraTicket(siteConfig, "ABU-834", runtime(async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return response({ ...issue(), unexpected: "ignored" });
  }));

  expect(new URL(requestUrl).pathname).toBe("/rest/api/3/issue/ABU-834");
  expect(new URL(requestUrl).searchParams.get("fields")).toBe("summary,status");
  expect(requestInit?.method).toBe("GET");
  expect(requestInit?.redirect).toBe("error");
  expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  const headers = new Headers(requestInit?.headers);
  expect(headers.get("accept")).toBe("application/json");
  expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("person@example.invalid:synthetic-token").toString("base64")}`);
  expect(headers.has("content-type")).toBe(false);
  expect(ticket).toEqual({
    key: "ABU-834",
    title: "Fix login",
    url: "https://example.atlassian.net/browse/ABU-834",
  });
});

test("uses the fixed Atlassian gateway for a scoped token", async () => {
  const config: JiraConfig = {
    siteUrl: "https://example.atlassian.net",
    cloudId: "00000000-0000-4000-8000-000000000000",
  };
  let requestUrl = "";
  const ticket = await resolveJiraTicket(config, "ABU-834", runtime(async (url) => {
    requestUrl = url;
    return response(issue());
  }));

  const url = new URL(requestUrl);
  expect(url.origin).toBe("https://api.atlassian.com");
  expect(url.pathname).toBe("/ex/jira/00000000-0000-4000-8000-000000000000/rest/api/3/issue/ABU-834");
  expect(url.searchParams.get("fields")).toBe("summary,status");
  expect(ticket.url).toBe("https://example.atlassian.net/browse/ABU-834");
});

test("uses Jira's canonical key when an issue has moved", async () => {
  const ticket = await resolveJiraTicket(siteConfig, "ABU-834", runtime(async () =>
    response(issue("XYZ-91", "Moved issue"))));

  expect(ticket).toEqual({
    key: "XYZ-91",
    title: "Moved issue",
    url: "https://example.atlassian.net/browse/XYZ-91",
  });
});

test("accepts only known active Jira status categories", async () => {
  for (const category of ["new", "indeterminate"]) {
    const ticket = await resolveJiraTicket(siteConfig, "ABU-834", runtime(async () =>
      response(issue("ABU-834", "Fix login", category))));
    expect(ticket.key).toBe("ABU-834");
  }
});

test("rejects completed Jira issues using the canonical key and status category", async () => {
  const failure = await resolveJiraTicket(siteConfig, "ABU-834", runtime(async () =>
    response({
      key: "XYZ-91",
      fields: {
        summary: "PRIVATE_SUMMARY_MARKER",
        status: {
          name: "Clôturé",
          statusCategory: { key: "done", name: "Done" },
        },
      },
    }))).then(() => null, error => error);

  expect(failure).toBeInstanceOf(JiraLookupFailure);
  expect(failure.reason).toBe("done");
  expect(failure.message).toContain("XYZ-91");
  expect(failure.message).toMatch(/complete/i);
  expect(failure.message).not.toContain("ABU-834");
  expect(failure.message).not.toContain("PRIVATE_SUMMARY_MARKER");
  expect(failure.message).not.toContain("Clôturé");
});

test("fails closed when Jira status category is missing, null, or unknown", async () => {
  const variants: Array<{ label: string; status?: unknown }> = [
    { label: "missing status" },
    { label: "null status", status: null },
    { label: "missing status category", status: { name: "Done" } },
    { label: "null status category", status: { statusCategory: null } },
    { label: "missing category key", status: { statusCategory: {} } },
    { label: "unknown category even when display name says Done", status: {
      name: "Done", statusCategory: { key: "custom-complete", name: "Done" },
    } },
  ];

  for (const variant of variants) {
    const message = await errorMessage(resolveJiraTicket(siteConfig, "ABU-834", runtime(async () =>
      response({
        key: "XYZ-92",
        fields: { summary: "Fix login", ...(variant.status === undefined ? {} : { status: variant.status }) },
      }))));

    expect(message).toContain("XYZ-92");
    expect(message).toMatch(/unknown status category/i);
    expect(message).not.toContain("Fix login");
  }
});

test("validates the requested key before reading credentials or calling fetch", async () => {
  let calls = 0;
  const message = await errorMessage(resolveJiraTicket(siteConfig, "ABU-834\nsecret", runtime(async () => {
    calls += 1;
    return response(issue());
  }, { env: {} })));

  expect(message).toMatch(/invalid.*ticket key/i);
  expect(message).not.toContain("secret");
  expect(calls).toBe(0);
});

test("missing and blank credentials name the missing variables and skip fetch", async () => {
  for (const example of [
    { env: {}, missing: ["JIRA_EMAIL", "JIRA_API_TOKEN"] },
    { env: { JIRA_EMAIL: "person@example.invalid" }, missing: ["JIRA_API_TOKEN"] },
    { env: { JIRA_EMAIL: "   ", JIRA_API_TOKEN: "" }, missing: ["JIRA_EMAIL", "JIRA_API_TOKEN"] },
  ]) {
    let calls = 0;
    const message = await errorMessage(resolveJiraTicket(siteConfig, "ABU-834", runtime(async () => {
      calls += 1;
      return response(issue());
    }, { env: example.env })));

    expect(message).toContain("JIRA credentials are missing");
    for (const name of example.missing) expect(message).toContain(name);
    expect(message).not.toContain("synthetic-token");
    expect(calls).toBe(0);
  }
});

for (const example of [
  { status: 401, message: /authentication rejected/i },
  { status: 403, message: /access denied/i },
  { status: 404, message: /unavailable or not visible/i },
  { status: 429, message: /rate limited/i },
  { status: 500, message: /Jira is unavailable/i },
  { status: 418, message: /unexpected Jira response/i },
]) {
  test(`maps HTTP ${example.status} to a safe error`, async () => {
    const message = await errorMessage(resolveJiraTicket(siteConfig, "ABU-834", runtime(async () =>
      new Response("BODY_SECRET_MARKER", { status: example.status }))));

    expect(message).toMatch(example.message);
    expect(message).not.toContain("BODY_SECRET_MARKER");
    expect(message).not.toContain("synthetic-token");
  });
}

test("assigns a typed not-found reason only to exact issue 404 responses", async () => {
  const missing = await resolveJiraTicket(siteConfig, "ABU-834", runtime(async () =>
    new Response(null, { status: 404 }))).then(() => null, error => error);
  const denied = await resolveJiraTicket(siteConfig, "ABU-834", runtime(async () =>
    new Response(null, { status: 401 }))).then(() => null, error => error);

  expect(missing).toBeInstanceOf(JiraLookupFailure);
  expect(missing.reason).toBe("not-found");
  expect(denied).toBeInstanceOf(JiraLookupFailure);
  expect(denied.reason).toBeUndefined();
});

test("rejects a redirect without making a second credentialed request", async () => {
  const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const message = await errorMessage(resolveJiraTicket(siteConfig, "ABU-834", runtime(async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    return new Response(null, { status: 302, headers: { location: "https://attacker.invalid/collect" } });
  })));

  expect(message).toMatch(/redirect/i);
  expect(calls).toEqual([{
    url: "https://example.atlassian.net/rest/api/3/issue/ABU-834?fields=summary%2Cstatus",
    redirect: "error",
  }]);
});

test("maps malformed JSON and invalid success payloads without exposing bodies", async () => {
  const malformed = await errorMessage(resolveJiraTicket(siteConfig, "ABU-834", runtime(async () =>
    new Response("BODY_SECRET_MARKER", { status: 200 }))));
  expect(malformed).toMatch(/unexpected Jira response/i);
  expect(malformed).not.toContain("BODY_SECRET_MARKER");

  for (const invalid of [
    { key: "ABU-834", fields: {} },
    { key: "ABU-834", fields: { summary: "  \n " } },
    { key: "ABU-834", fields: { summary: 123 } },
    { key: "abu-834", fields: { summary: "Fix login" } },
    { key: "ABU-834\n", fields: { summary: "Fix login" } },
  ]) {
    const message = await errorMessage(resolveJiraTicket(siteConfig, "ABU-834", runtime(async () =>
      response(invalid))));
    expect(message).toMatch(/unexpected Jira response/i);
    expect(message).not.toContain("synthetic-token");
  }
});

test("maps transport exceptions without exposing their message", async () => {
  const message = await errorMessage(resolveJiraTicket(siteConfig, "ABU-834", runtime(async () => {
    throw new Error("NETWORK_SECRET_MARKER");
  })));

  expect(message).toMatch(/request failed/i);
  expect(message).not.toContain("NETWORK_SECRET_MARKER");
  expect(message).not.toContain("synthetic-token");
});

test("times out before response headers and aborts the request", async () => {
  let requestSignal: AbortSignal | undefined;
  const message = await errorMessage(resolveJiraTicket(siteConfig, "ABU-834", runtime((_url, init) => {
    requestSignal = init.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => reject(new Error("TRANSPORT_SECRET_MARKER")), { once: true });
    });
  }, { timeoutMs: 15 })));

  expect(message).toMatch(/timed out/i);
  expect(message).not.toContain("TRANSPORT_SECRET_MARKER");
  expect(requestSignal?.aborted).toBe(true);
});

test("keeps the deadline active through a stalled response body", async () => {
  let requestSignal: AbortSignal | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const message = await errorMessage(resolveJiraTicket(siteConfig, "ABU-834", runtime((_url, init) => {
    requestSignal = init.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        requestSignal?.addEventListener("abort", () => controller.error(new Error("BODY_SECRET_MARKER")), { once: true });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  }, { timeoutMs: 15 })));

  expect(message).toMatch(/timed out/i);
  expect(message).not.toContain("BODY_SECRET_MARKER");
  expect(requestSignal?.aborted).toBe(true);
  expect(streamController).toBeDefined();
});

test("clears the timeout after success and HTTP failure", async () => {
  for (const status of [200, 401]) {
    let requestSignal: AbortSignal | undefined;
    const result = resolveJiraTicket(siteConfig, "ABU-834", runtime(async (_url, init) => {
      requestSignal = init.signal as AbortSignal;
      return status === 200 ? response(issue()) : new Response(null, { status });
    }, { timeoutMs: 25 }));

    if (status === 200) await result;
    else await expect(result).rejects.toThrow(/authentication rejected/i);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(requestSignal?.aborted).toBe(false);
  }
});

function searchIssue(key: string, categoryKey: string, summary = `Title ${key}`) {
  return {
    key,
    fields: {
      summary,
      status: { statusCategory: { key: categoryKey } },
    },
  };
}

test("searches only the same Jira project and collects sorted active full-key-prefix matches", async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const pages = [
    {
      issues: [
        searchIssue("ABU-41", "indeterminate"),
        searchIssue("ABU-4", "new"),
        searchIssue("ABU-400", "new"),
        searchIssue("ABU-42", "done"),
        searchIssue("XABU-43", "new"),
        searchIssue("ABU-43", "custom", "Must not be selected"),
        { key: "ABU-44", fields: { summary: "Missing category" } },
      ],
      isLast: false,
      nextPageToken: "page-two-token",
    },
    {
      issues: [searchIssue("ABU-40", "new"), searchIssue("ABU-41", "indeterminate", "Duplicate title")],
      isLast: true,
    },
  ];

  const tickets = await findJiraSuggestions(siteConfig, "ABU-4", runtime(async (url, init) => {
    calls.push({ url: new URL(url), init });
    return response(pages[calls.length - 1]);
  }));

  expect(calls).toHaveLength(2);
  expect(calls[0]?.url.pathname).toBe("/rest/api/3/search/jql");
  expect(calls[0]?.url.searchParams.get("jql")).toBe('project = "ABU" AND statusCategory != Done ORDER BY key ASC');
  expect(calls[0]?.url.searchParams.get("fields")).toBe("summary,status");
  expect(calls[0]?.url.searchParams.get("maxResults")).toBe("100");
  expect(calls[0]?.url.searchParams.has("nextPageToken")).toBe(false);
  expect(calls[1]?.url.searchParams.get("nextPageToken")).toBe("page-two-token");
  for (const call of calls) {
    expect(call.init.method).toBe("GET");
    expect(call.init.redirect).toBe("error");
    expect(new Headers(call.init.headers).get("authorization")).toMatch(/^Basic /);
  }
  expect(tickets).toEqual([
    { key: "ABU-40", title: "Title ABU-40", url: "https://example.atlassian.net/browse/ABU-40" },
    { key: "ABU-400", title: "Title ABU-400", url: "https://example.atlassian.net/browse/ABU-400" },
    { key: "ABU-41", title: "Title ABU-41", url: "https://example.atlassian.net/browse/ABU-41" },
  ]);
});

test("excludes the exact requested key and rejects invalid suggestion keys before fetch", async () => {
  let calls = 0;
  const suggestions = await findJiraSuggestions(siteConfig, "ABU-4", runtime(async () => {
    calls += 1;
    return response({ issues: [searchIssue("ABU-4", "new")], isLast: true });
  }));
  expect(suggestions).toEqual([]);

  await expect(findJiraSuggestions(siteConfig, "ABU-4\n", runtime(async () => {
    calls += 1;
    return response({ issues: [], isLast: true });
  }))).rejects.toThrow(/invalid.*ticket key/i);
  expect(calls).toBe(1);
});

test("fails safely when a nonfinal search page has no continuation token", async () => {
  const message = await errorMessage(findJiraSuggestions(siteConfig, "ABU-4", runtime(async () =>
    response({ issues: [], isLast: false }))));

  expect(message).toMatch(/suggestions.*complete/i);
  expect(message).not.toContain("synthetic-token");
});

test("fails safely when Jira repeats a continuation token", async () => {
  let calls = 0;
  const message = await errorMessage(findJiraSuggestions(siteConfig, "ABU-4", runtime(async () => {
    calls += 1;
    return response({ issues: [], isLast: false, nextPageToken: "repeat" });
  })));

  expect(message).toMatch(/suggestions.*complete/i);
  expect(calls).toBe(2);
});

test("fails safely if any search page cannot be read", async () => {
  let calls = 0;
  const message = await errorMessage(findJiraSuggestions(siteConfig, "ABU-4", runtime(async () => {
    calls += 1;
    return calls === 1
      ? response({ issues: [], isLast: false, nextPageToken: "next" })
      : new Response("SEARCH_BODY_SECRET_MARKER", { status: 403 });
  })));

  expect(message).toMatch(/access denied \(403\)/i);
  expect(message).not.toContain("SEARCH_BODY_SECRET_MARKER");
  expect(calls).toBe(2);
});

test("search deadline spans paginated body consumption and aborts a stalled page", async () => {
  let requestSignal: AbortSignal | undefined;
  const message = await errorMessage(findJiraSuggestions(siteConfig, "ABU-4", runtime((_url, init) => {
    requestSignal = init.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        requestSignal?.addEventListener("abort", () => controller.error(new Error("SEARCH_BODY_SECRET_MARKER")), { once: true });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  }, { timeoutMs: 15 })));

  expect(message).toMatch(/timed out/i);
  expect(message).not.toContain("SEARCH_BODY_SECRET_MARKER");
  expect(requestSignal?.aborted).toBe(true);
});

test("one search deadline spans every page instead of restarting for each request", async () => {
  let calls = 0;
  let requestSignal: AbortSignal | undefined;
  const message = await errorMessage(findJiraSuggestions(siteConfig, "ABU-4", runtime((_url, init) => {
    calls += 1;
    requestSignal = init.signal as AbortSignal;
    return new Promise<Response>(resolve => setTimeout(() => resolve(response(calls === 1
      ? { issues: [], isLast: false, nextPageToken: "next" }
      : { issues: [], isLast: true })), 9));
  }, { timeoutMs: 15 })));

  expect(message).toMatch(/timed out after 15 ms/i);
  expect(calls).toBe(2);
  expect(requestSignal?.aborted).toBe(true);
});
