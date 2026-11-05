import { expect, test } from "bun:test";
import { checkLinearConnection, resolveLinearTicket } from "../src/linear/client";
import type { LinearRuntime } from "../src/linear/client";

const issue = { trashed: null, identifier: "ENG-123", title: "Fix login", url: "https://linear.app/workspace/issue/ENG-123/fix-login", state: { type: "started" } };
const json = (data: unknown) => new Response(JSON.stringify(data));
const runtime = (body: unknown): LinearRuntime => ({ token: async () => "SYNTHETIC_KEY", timeoutMs: 100, fetch: async () => json(body) });

for (const state of ["triage", "backlog", "unstarted", "started"]) {
  test(`Linear queries an exact identifier with variables, accepts canonical key and ${state}`, async () => {
    let calls = 0;
    const result = await resolveLinearTicket("OLD-1", { ...runtime(null), fetch: async (url, init) => {
      calls++;
      expect(url).toBe("https://api.linear.app/graphql");
      expect(init.method).toBe("POST"); expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("Authorization")).toBe("SYNTHETIC_KEY");
      expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
      const body = JSON.parse(init.body as string);
      expect(body.variables).toEqual({ id: "OLD-1" });
      expect(body.query).toContain("issue(id: $id)");
      expect(body.query).not.toContain("OLD-1");
      return json({ data: { issue: { ...issue, state: { type: state } } } });
    } });
    expect(result).toEqual({ key: issue.identifier, title: issue.title, url: issue.url });
    expect(calls).toBe(1);
  });
}

for (const state of ["completed", "canceled", "duplicate", "unknown", "", null, 12]) {
  test(`Linear refuses terminal/malformed state ${state}`, async () => {
    await expect(resolveLinearTicket("ENG-123", runtime({ data: { issue: { ...issue, state: { type: state } } } }))).rejects.toThrow(/Linear/u);
  });
}

for (const patch of [{ identifier: "eng-123" }, { identifier: null }, { title: " " }, { title: 42 }, { state: null }, { url: "http://linear.app/a" },
  { url: "https://linear.app.evil.invalid/a" }, { url: "https://evil.invalid/a" }, { url: "https://user:pass@linear.app/a" },
  { url: "https://linear.app:444/a" }, { url: "https://linear.app/a\n" }, { url: "https://linear.app/a\u001b[31m" }, { url: null }]) {
  test(`Linear rejects malformed issue property ${JSON.stringify(patch)}`, async () => {
    await expect(resolveLinearTicket("ENG-123", runtime({ data: { issue: { ...issue, ...patch } } }))).rejects.toThrow(/Linear/u);
  });
}

for (const body of [null, [], {}, { data: null }, { data: { issue: null } }, { data: { issue }, errors: [{ message: "PRIVATE_RAW_MESSAGE" }] },
  { errors: [{ message: "PRIVATE_RAW_MESSAGE" }] }, { data: { issue }, errors: "PRIVATE_RAW_MESSAGE" }, { data: { issue }, errors: null }]) {
  test("Linear refuses missing data and GraphQL errors including partial data without leaking bodies", async () => {
    try { await resolveLinearTicket("ENG-123", runtime(body)); throw new Error("unexpected success"); }
    catch (error) { expect(String(error)).toContain("Linear"); expect(String(error)).not.toContain("PRIVATE_RAW_MESSAGE"); }
  });
}

for (const status of [301, 401, 403, 404, 410, 429, 500]) {
  test(`Linear safely rejects HTTP ${status} without retries`, async () => {
    let calls = 0;
    try {
      await resolveLinearTicket("ENG-123", { ...runtime(null), fetch: async () => { calls++; return new Response("PRIVATE_BODY", { status }); } });
      throw new Error("unexpected success");
    } catch (error) { expect(String(error)).toContain("Linear"); expect(String(error)).not.toContain("PRIVATE_BODY"); }
    expect(calls).toBe(1);
  });
}

test("Linear safely rejects invalid JSON, redirected response, and transport errors", async () => {
  for (const fetch of [async () => new Response("PRIVATE_BODY"), async () => { throw new Error("PRIVATE_TRANSPORT SYNTHETIC_KEY"); },
    async () => { const response = json({ data: { issue } }); Object.defineProperty(response, "redirected", { value: true }); return response; }]) {
    try { await resolveLinearTicket("ENG-123", { ...runtime(null), fetch }); throw new Error("unexpected success"); }
    catch (error) { expect(String(error)).toContain("Linear"); expect(String(error)).not.toMatch(/PRIVATE|SYNTHETIC_KEY/u); }
  }
});

for (const stage of ["token", "fetch", "body"] as const) {
  test(`Linear deadline covers stalled ${stage} and aborts later work`, async () => {
    let signal: AbortSignal | undefined; let fetched = 0;
    let unblock!: (value: string) => void;
    const pending = new Promise<string>(resolve => { unblock = resolve; });
    const lookup = resolveLinearTicket("ENG-123", { timeoutMs: 10, token: async value => { signal = value; return stage === "token" ? pending : "KEY"; },
      fetch: async () => { fetched++; if (stage === "fetch") await pending;
        const response = json({ data: { issue } });
        if (stage === "body") response.json = async () => { await pending; return { data: { issue } }; };
        return response;
      } });
    await expect(lookup).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
    unblock("KEY"); await new Promise(resolve => setTimeout(resolve, 1));
    expect(fetched).toBe(stage === "token" ? 0 : 1);
  });
}

test("Linear viewer check is read-only, validates minimal response and observes external cancellation", async () => {
  await checkLinearConnection({ ...runtime(null), fetch: async (_url, init) => {
    expect(JSON.parse(init.body as string)).toEqual({ query: "query TimberLinearConnection { viewer { id } }", variables: {} });
    return json({ data: { viewer: { id: "viewer-id" } } });
  } });
  await expect(checkLinearConnection(runtime({ data: { viewer: { id: " " } } }))).rejects.toThrow(/invalid response/u);
  const controller = new AbortController(); let signal: AbortSignal | undefined;
  const check = checkLinearConnection({ ...runtime(null), fetch: async (_url, init) => { signal = init.signal!; return new Promise<Response>(() => {}); } }, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 1)); controller.abort();
  await expect(check).rejects.toThrow(/cancel/iu);
  expect(signal?.aborted).toBe(true);
  let fetched = false;
  await expect(checkLinearConnection({ ...runtime(null), fetch: async () => { fetched = true; return json(null); } }, controller.signal)).rejects.toThrow(/cancel/iu);
  expect(fetched).toBe(false);
});

test("Linear rejects soft-deleted issues even with a nonterminal workflow state", async () => {
  await expect(resolveLinearTicket("ENG-123", runtime({ data: { issue: { ...issue, trashed: true } } })))
    .rejects.toThrow("deleted");
  for (const trashed of [undefined, "false", 0]) {
    await expect(resolveLinearTicket("ENG-123", runtime({ data: { issue: { ...issue, trashed } } }))).rejects.toThrow("invalid response");
  }
  expect(await resolveLinearTicket("ENG-123", runtime({ data: { issue: { ...issue, trashed: false } } })))
    .toEqual({ key: issue.identifier, title: issue.title, url: issue.url });
});

for (const state of ["completed", "canceled", "duplicate"]) {
  test(`-c permits Linear ${state} but never trashed or unknown data`, async () => {
    expect((await resolveLinearTicket("ENG-123", runtime({ data: { issue: { ...issue, state: { type: state } } } }), true)).key).toBe("ENG-123");
    await expect(resolveLinearTicket("ENG-123", runtime({ data: { issue: { ...issue, trashed: true } } }), true)).rejects.toThrow("deleted");
    await expect(resolveLinearTicket("ENG-123", runtime({ data: { issue: { ...issue, state: { type: "future-state" } } } }), true)).rejects.toThrow("unsupported");
  });
}

const missingIssue = { data: null, errors: [{ message: "Entity not found: Issue", path: ["issue"], extensions: { code: "INPUT_ERROR", type: "invalid input", userError: true, userPresentableMessage: "Could not find referenced Issue." } }] };
for (const status of [200, 400]) {
  test(`Linear classifies only a complete exact issue missing error at HTTP ${status}`, async () => {
    const failure = await resolveLinearTicket("ENG-123", { ...runtime(null), fetch: async () => new Response(JSON.stringify(missingIssue), { status }) }).catch(error => error);
    expect(failure.reason).toBe("not-found");
    for (const body of [
      { ...missingIssue, data: { issue } },
      { ...missingIssue, errors: [...missingIssue.errors, { message: "forbidden", extensions: { code: "FORBIDDEN" } }] },
      { data: null, errors: [{ ...missingIssue.errors[0], message: "Entity not found: Project" }] },
      { data: null, errors: [{ ...missingIssue.errors[0], extensions: { code: "FORBIDDEN" } }] },
      { data: null, errors: [{ ...missingIssue.errors[0], path: ["viewer"] }] },
    ]) {
      const refused = await resolveLinearTicket("ENG-123", { ...runtime(null), fetch: async () => new Response(JSON.stringify(body), { status }) }).catch(error => error);
      expect(refused.reason).toBeUndefined();
    }
  });
}

test("Linear recognizes documented missing wording without assuming optional path/type metadata", async () => {
  for (const error of [
    { message: "Entity not found: Issue", extensions: { code: "INPUT_ERROR" } },
    { message: "Could not find referenced Issue.", extensions: { code: "INPUT_ERROR", userPresentableMessage: "Could not find referenced Issue." } },
  ]) {
    const failure = await resolveLinearTicket("ENG-123", runtime({ errors: [error] })).catch(error => error);
    expect(failure.reason).toBe("not-found");
  }
  for (const error of [
    { message: "Entity not found: Issue", extensions: { code: "INPUT_ERROR", type: "forbidden" } },
    { message: "unrelated validation failure", extensions: { code: "INPUT_ERROR" } },
    { message: "Entity not found: Project", extensions: { code: "INPUT_ERROR", userPresentableMessage: "Could not find referenced Project." } },
    { message: null, extensions: { code: "INPUT_ERROR", userPresentableMessage: "Could not find referenced Issue." } },
    { message: "Entity not found: Issue", path: null, extensions: { code: "INPUT_ERROR" } },
    { message: "Entity not found: Issue", extensions: { code: "INPUT_ERROR", type: null } },
  ]) {
    const failure = await resolveLinearTicket("ENG-123", runtime({ errors: [error] })).catch(error => error);
    expect(failure.reason).toBeUndefined();
  }
});
