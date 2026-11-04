import { expect, test } from "bun:test";
import { resolveGithubTicket, checkGithubConnection } from "../src/github/client";

const repo = { owner: "team", name: "project" };
const issue = { number: 123, title: "Fix login", state: "open", html_url: "https://evil.example" };
const runtime = (value: unknown, status = 200) => ({ token: async () => "canary-secret", fetch: async () => new Response(JSON.stringify(value), { status }), timeoutMs: 100 });

test("GitHub lookup validates exact issue and builds its own browse URL", async () => {
  const result = await resolveGithubTicket(repo, 123, false, {
    ...runtime(issue), fetch: async (url, init) => {
      expect(String(url)).toBe("https://api.github.com/repos/team/project/issues/123");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer canary-secret");
      return new Response(JSON.stringify(issue));
    },
  });
  expect(result).toEqual({ key: "GH-123", title: "Fix login", url: "https://github.com/team/project/issues/123" });
});

test("closed issues require explicit consent but PRs and invalid responses always refuse", async () => {
  await expect(resolveGithubTicket(repo, 123, false, runtime({ ...issue, state: "closed" }))).rejects.toThrow("-c");
  expect((await resolveGithubTicket(repo, 123, true, runtime({ ...issue, state: "closed" }))).key).toBe("GH-123");
  for (const invalid of [{ ...issue, pull_request: {} }, { ...issue, pull_request: null }, { ...issue, number: 124 }, { ...issue, title: " " }, { ...issue, state: "unknown" }, { ...issue, state: ["open"] }, null]) {
    await expect(resolveGithubTicket(repo, 123, true, runtime(invalid))).rejects.toThrow();
  }
});

test("HTTP and transport failures never expose payloads or tokens", async () => {
  for (const status of [301, 401, 403, 404, 410, 429, 500]) {
    try { await resolveGithubTicket(repo, 123, false, runtime({ secret: "canary-secret" }, status)); }
    catch (error) { expect(String(error)).not.toContain("canary-secret"); continue; }
    throw new Error(`Expected status ${status} refusal`);
  }
  await expect(resolveGithubTicket(repo, 123, false, { ...runtime(issue), fetch: async () => { throw new Error("canary-secret"); } })).rejects.toThrow("network");
  await expect(resolveGithubTicket(repo, 123, false, { ...runtime(issue), fetch: async () => new Response("bad-json") })).rejects.toThrow("response");
});

test("one deadline bounds credentials and stalled bodies even when doubles ignore abort", async () => {
  await expect(resolveGithubTicket(repo, 123, false, { ...runtime(issue), timeoutMs: 10, token: () => new Promise(() => {}) })).rejects.toThrow("timed out");
  await expect(resolveGithubTicket(repo, 123, false, { ...runtime(issue), timeoutMs: 10,
    fetch: async () => new Response(new ReadableStream({ start() {} })),
  })).rejects.toThrow("timed out");
});

test("connection checks validate account without claiming repository access", async () => {
  expect(await checkGithubConnection(runtime({ login: "octocat" }))).toBe("octocat");
  await expect(checkGithubConnection(runtime({ login: "bad\nlogin" }))).rejects.toThrow();
});
