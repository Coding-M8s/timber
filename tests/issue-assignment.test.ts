import { expect, test } from "bun:test";
import { assignGithubIssue, resolveGithubTicket } from "../src/github/client";
import { assignJiraIssue, checkJiraConnection, resolveJiraTicket } from "../src/jira/client";
import type { JiraRuntime } from "../src/jira/client";
import { assignLinearIssue, checkLinearConnection, resolveLinearTicket } from "../src/linear/client";
import { planAssignment } from "../src/issue-assignment";

const secret = "canary-secret";
const repo = { owner: "team", name: "project" };
interface Call { url: string; method: string; body: unknown; authorization: string | null }

function recorder(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const call = { url: String(url), method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      authorization: new Headers(init.headers).get("Authorization") };
    calls.push(call);
    return answer(call);
  };
  return { calls, fetch };
}

const message = (promise: Promise<unknown>) => promise.then(() => { throw new Error("Unexpected success"); }, (error: Error) => error.message);

test("planAssignment writes only when the issue is not already the account's, and refuses another assignee without --reassign", () => {
  const me = { id: "Me", name: "Me" };
  const other = { id: "other", name: "Other" };
  expect(planAssignment("github", me, [], false)).toEqual({ kind: "assign" });
  expect(planAssignment("github", me, [{ id: "me", name: "me" }], true)).toEqual({ kind: "already-mine" });
  expect(planAssignment("github", me, [other], false)).toEqual({ kind: "refuse", others: [other] });
  expect(planAssignment("github", me, [other], true)).toEqual({ kind: "reassign", others: [other] });
  // Already among several: mine without --reassign; --reassign makes the list only me.
  expect(planAssignment("github", me, [other, me], false)).toEqual({ kind: "already-mine" });
  expect(planAssignment("github", me, [other, me], true)).toEqual({ kind: "reassign", others: [other] });
  // Jira and Linear IDs compare exactly.
  expect(planAssignment("jira", { id: "abc", name: "A" }, [{ id: "ABC", name: "A" }], false).kind).toBe("refuse");
});

test("GitHub lookup reports assignees, and unknown when the list is missing or unreadable", async () => {
  const issue = { number: 7, title: "Fix", state: "open" };
  const lookup = (body: object) => resolveGithubTicket(repo, 7, false, { token: async () => secret, timeoutMs: 100,
    fetch: async () => Response.json(body) });
  expect((await lookup({ ...issue, assignees: [{ login: "octo" }] })).assignees).toEqual([{ id: "octo", name: "octo" }]);
  expect((await lookup({ ...issue, assignees: [] })).assignees).toEqual([]);
  expect((await lookup(issue)).assignees).toBeUndefined();
  expect((await lookup({ ...issue, assignees: [{ login: "bad login" }] })).assignees).toBeUndefined();
  // Enterprise Managed User logins and app bots are logins too.
  expect((await lookup({ ...issue, assignees: [{ login: "ada_acme" }, { login: "helper[bot]" }] })).assignees)
    .toEqual([{ id: "ada_acme", name: "ada_acme" }, { id: "helper[bot]", name: "helper[bot]" }]);
});

test("GitHub assignment adds the login, or replaces the list with --reassign, and checks GitHub listed it", async () => {
  const added = recorder(() => Response.json({ assignees: [{ login: "someone" }, { login: "ME" }] }));
  await assignGithubIssue(repo, 7, "me", false, { token: async () => secret, fetch: added.fetch, timeoutMs: 100 });
  expect(added.calls).toEqual([{ url: "https://api.github.com/repos/team/project/issues/7/assignees", method: "POST",
    body: { assignees: ["me"] }, authorization: `Bearer ${secret}` }]);

  const replaced = recorder(() => Response.json({ assignees: [{ login: "me" }] }));
  await assignGithubIssue(repo, 7, "me", true, { token: async () => secret, fetch: replaced.fetch, timeoutMs: 100 });
  expect(replaced.calls.map(call => [call.method, call.url, call.body])).toEqual([
    ["PATCH", "https://api.github.com/repos/team/project/issues/7", { assignees: ["me"] }]]);

  // GitHub drops an assignee it may not assign without an error.
  const dropped = recorder(() => Response.json({ assignees: [] }));
  expect(await message(assignGithubIssue(repo, 7, "me", false, { token: async () => secret, fetch: dropped.fetch, timeoutMs: 100 })))
    .toContain("did not assign");
  for (const status of [401, 403, 404, 422, 500]) {
    const failed = recorder(() => Response.json({ message: secret }, { status }));
    const text = await message(assignGithubIssue(repo, 7, "me", false, { token: async () => secret, fetch: failed.fetch, timeoutMs: 100 }));
    expect(text).not.toContain(secret);
    expect(text).not.toContain("no workspace");
    if (status === 403 || status === 422) expect(text).toContain("write access");
  }
  const late = await message(assignGithubIssue(repo, 7, "me", false, { token: async () => secret, timeoutMs: 10, fetch: () => new Promise(() => {}) }));
  expect(late).toBe("GitHub assignment timed out.");
});

const jiraConfig = { siteUrl: "https://example.atlassian.net" };
const jiraRuntime = (fetch: JiraRuntime["fetch"]): JiraRuntime => ({ env: { JIRA_EMAIL: "a@example.invalid", JIRA_API_TOKEN: secret },
  timeoutMs: 100, fetch });

test("Jira lookup reports the assignee and the current account", async () => {
  const issue = (assignee: unknown) => ({ key: "ENG-1", fields: { summary: "Fix", status: { statusCategory: { key: "new" } }, assignee } });
  const lookup = async (assignee: unknown) => {
    const seen = recorder(() => Response.json(issue(assignee)));
    const ticket = await resolveJiraTicket(jiraConfig, "ENG-1", jiraRuntime(seen.fetch));
    expect(new URL(seen.calls[0]!.url).searchParams.get("fields")).toBe("summary,status,assignee");
    return ticket.assignees;
  };
  expect(await lookup({ accountId: "acc-1", displayName: "Ada" })).toEqual([{ id: "acc-1", name: "Ada" }]);
  expect(await lookup(null)).toEqual([]);
  expect(await lookup({ displayName: "No account" })).toBeUndefined();
  expect(await checkJiraConnection(jiraConfig, jiraRuntime(async () => Response.json({ accountId: "acc-1", displayName: " Ada " }))))
    .toEqual({ id: "acc-1", name: "Ada" });
});

test("Jira assignment sets the account and maps refusals without echoing the login or body", async () => {
  const seen = recorder(() => new Response(null, { status: 204 }));
  await assignJiraIssue(jiraConfig, "ENG-1", "acc-1", jiraRuntime(seen.fetch));
  expect(seen.calls.map(call => [call.method, call.url, call.body])).toEqual([
    ["PUT", "https://example.atlassian.net/rest/api/3/issue/ENG-1/assignee", { accountId: "acc-1" }]]);
  expect(seen.calls[0]!.authorization).toStartWith("Basic ");
  const expected: Record<number, string> = { 400: "not be assignable", 401: "authentication", 403: "Assign Issues", 404: "404", 500: "unavailable" };
  for (const [status, text] of Object.entries(expected)) {
    const failure = await message(assignJiraIssue(jiraConfig, "ENG-1", "acc-1", jiraRuntime(async () => Response.json({ errorMessages: [secret] }, { status: Number(status) }))));
    expect(failure).toContain(text);
    expect(failure).not.toContain(secret);
  }
  await expect(assignJiraIssue(jiraConfig, "bad key", "acc-1", jiraRuntime(async () => { throw new Error("must not fetch"); }))).rejects.toThrow("key");
});

const linearRuntime = (fetch: (url: string, init: RequestInit) => Promise<Response>) => ({ token: async () => secret, fetch, timeoutMs: 100 });

test("Linear lookup reports the assignee and the viewer", async () => {
  const node = { id: "uuid-1", identifier: "ENG-1", title: "Fix", url: "https://linear.app/acme/issue/ENG-1/fix", trashed: false, state: { type: "started" } };
  const seen = recorder(() => Response.json({ data: { issue: { ...node, assignee: { id: "user-1", displayName: "Ada" } } } }));
  const ticket = await resolveLinearTicket("ENG-1", linearRuntime(seen.fetch));
  expect(ticket.assignees).toEqual([{ id: "user-1", name: "Ada" }]);
  expect(ticket.id).toBe("uuid-1");
  expect((seen.calls[0]!.body as { query: string }).query).toContain("assignee { id displayName }");
  expect((await resolveLinearTicket("ENG-1", linearRuntime(async () => Response.json({ data: { issue: { ...node, assignee: null } } })))).assignees).toEqual([]);
  expect(await checkLinearConnection(linearRuntime(async () => Response.json({ data: { viewer: { id: "user-1", displayName: "Ada" } } }))))
    .toEqual({ id: "user-1", name: "Ada" });
});

test("Linear assignment updates the assignee and checks Linear's answer", async () => {
  const seen = recorder(() => Response.json({ data: { issueUpdate: { success: true, issue: { assignee: { id: "user-1" } } } } }));
  await assignLinearIssue("uuid-1", "user-1", linearRuntime(seen.fetch));
  const body = seen.calls[0]!.body as { query: string; variables: unknown };
  expect(body.query).toStartWith("mutation TimberLinearAssign(");
  expect(body.variables).toEqual({ id: "uuid-1", assignee: "user-1" });
  expect(seen.calls[0]!.authorization).toBe(secret);

  for (const answer of [
    Response.json({ data: { issueUpdate: { success: false, issue: null } } }),
    Response.json({ data: { issueUpdate: { success: true, issue: { assignee: { id: "someone-else" } } } } }),
    Response.json({ data: null, errors: [{ message: secret, extensions: { code: "FORBIDDEN" } }] }),
    Response.json({ message: secret }, { status: 500 }),
  ]) {
    const failure = await message(assignLinearIssue("ENG-1", "user-1", linearRuntime(async () => answer)));
    expect(failure).not.toContain(secret);
    expect(failure).not.toContain("No workspace");
  }
  expect(await message(assignLinearIssue("ENG-1", "user-1", { ...linearRuntime(() => new Promise(() => {})), timeoutMs: 10 })))
    .toBe("Linear assignment timed out.");
});
