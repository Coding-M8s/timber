import { expect, test } from "bun:test";
import { createPullRequest, findOpenPullRequest } from "../src/github/pulls";
import type { GithubRuntime } from "../src/github/client";

const base = { owner: "acme", name: "widgets" };
const fork = { owner: "someone", name: "widgets-fork" };
const pull = (number: number, ref = "GH-157-pr", repo = "acme/widgets", extra: Record<string, unknown> = {}) => ({
  number, html_url: "https://evil.example", draft: false, head: { ref, repo: { full_name: repo } }, base: { ref: "main" }, ...extra,
});

function runtime(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const value: GithubRuntime = {
    token: async () => "canary-token", timeoutMs: 200,
    fetch: async (url, init) => {
      calls.push({ url, method: String(init.method), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return respond(url, init);
    },
  };
  return { runtime: value, calls };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("lookup filters by head branch and repository on the client and builds its own URL", async () => {
  // GitHub returns every open pull request when it cannot parse the head filter.
  const fake = runtime(() => json([pull(9, "other-branch"), pull(8, "GH-157-pr", "someone-else/widgets"), pull(12), pull(11)]));
  expect(await findOpenPullRequest(base, base, "GH-157-pr", "main", fake.runtime))
    .toEqual({ number: 11, url: "https://github.com/acme/widgets/pull/11", base: "main", draft: false });
  const url = new URL(fake.calls[0]!.url);
  expect(url.origin + url.pathname).toBe("https://api.github.com/repos/acme/widgets/pulls");
  expect(Object.fromEntries(url.searchParams)).toEqual({ state: "open", head: "acme:GH-157-pr", base: "main", per_page: "100" });
  expect(fake.calls[0]!.method).toBe("GET");

  expect(await findOpenPullRequest(base, base, "GH-157-pr", "main", runtime(() => json([pull(3, "other")])).runtime)).toBeNull();
  // An open pull request into another base does not count: GitHub allows one per head and base.
  expect(await findOpenPullRequest(base, base, "GH-157-pr", "main", runtime(() => json([pull(4, "GH-157-pr", "acme/widgets", { base: { ref: "release" } })])).runtime)).toBeNull();
  // A deleted fork has a null head repository and never matches.
  expect(await findOpenPullRequest(base, fork, "GH-157-pr", "main", runtime(() => json([pull(3, "GH-157-pr", null as never, { head: { ref: "GH-157-pr", repo: null } })])).runtime)).toBeNull();
  for (const invalid of [{}, [{ number: "1" }], [{ ...pull(1), base: {} }], null]) {
    await expect(findOpenPullRequest(base, base, "GH-157-pr", "main", runtime(() => json(invalid)).runtime)).rejects.toThrow("invalid pull request response");
  }
});

test("creation posts a cross-repository head, the base branch and the draft flag", async () => {
  const fake = runtime(() => json(pull(42, "GH-157-pr", "someone/widgets-fork", { draft: true }), 201));
  expect(await createPullRequest(base, fork, { branch: "GH-157-pr", baseBranch: "main", title: "Add pr", body: "Refs #157", draft: true }, fake.runtime))
    .toEqual({ number: 42, url: "https://github.com/acme/widgets/pull/42", base: "main", draft: true });
  expect(fake.calls).toEqual([{ url: "https://api.github.com/repos/acme/widgets/pulls", method: "POST",
    body: { title: "Add pr", head: "someone:GH-157-pr", base: "main", body: "Refs #157", draft: true } }]);
});

test("rejections map to fixed wording and never echo GitHub's text or the token", async () => {
  const create = (response: Response) => createPullRequest(base, base,
    { branch: "GH-157-pr", baseBranch: "main", title: "t", body: "", draft: false }, runtime(() => response).runtime);
  const failure = async (response: Response) => (await create(response).catch(error => error)) as Error & { reason?: string };
  const exists = await failure(json({ message: "Validation Failed", errors: [{ message: "A pull request already exists for acme:GH-157-pr. canary-token" }] }, 422));
  expect(exists.reason).toBe("already-exists");
  expect((await failure(json({ message: "Validation Failed", errors: [{ message: "No commits between main and GH-157-pr" }] }, 422))).message).toContain("no commits");
  expect((await failure(json({ message: "Draft pull requests are not supported in this repository." }, 422))).message).toContain("--draft");
  expect((await failure(json({ message: "Validation Failed", errors: [{ field: "base", code: "invalid" }] }, 422))).message).toContain("base branch does not exist");
  expect((await failure(json({ message: "canary-token" }, 422))).message).toContain("rejected the pull request as invalid");
  for (const status of [401, 403, 404, 410, 429, 500, 502]) {
    const error = await failure(json({ message: "canary-token" }, status));
    expect(String(error)).not.toContain("canary-token");
    // Pull request failures never borrow the issue lookup's wording.
    expect(String(error)).not.toContain("issue");
    expect(error.reason).toBeUndefined();
  }
  expect((await failure(new Response("not json", { status: 422 }))).message).toContain("rejected the pull request as invalid");
});

test("a creation timeout says the pull request may exist", async () => {
  const stalled: GithubRuntime = { token: async () => "t", timeoutMs: 10, fetch: () => new Promise(() => {}) };
  await expect(createPullRequest(base, base, { branch: "b", baseBranch: "main", title: "t", body: "", draft: false }, stalled))
    .rejects.toThrow("may have been created");
  await expect(findOpenPullRequest(base, base, "b", "main", stalled)).rejects.toThrow("nothing was created");
});
