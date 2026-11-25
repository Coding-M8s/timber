import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { snapshot } from "./helpers/snapshot";
import { readAppReviewers } from "../src/app-reviewers/read";
import type { AppReviewersServices } from "../src/app-reviewers/read";
import { loadRepositoryConfig } from "../src/config";
import { readBaseAssociation, writeBaseAssociation } from "../src/git/base-metadata";
import { readCodeOwners } from "../src/git/code-owners";
import { discoverRepository } from "../src/git/repository";
import { listWorktreeInventory, listWorktrees } from "../src/git/worktrees";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const token = "ghp_SECRET_TOKEN_9b1d";
const email = "dev@example.invalid";
const bitbucketToken = "ATATT_SECRET_TOKEN_7c2f";

type Answer = (url: URL) => Response | Promise<Response>;
interface Seen { urls: URL[]; logins: number; authorization: string[] }
const fresh = (): Seen => ({ urls: [], logins: 0, authorization: [] });

/** Real Git reads; `answer` is the host. */
function services(seen: Seen, answer: Answer, overrides: Partial<AppReviewersServices> = {}): AppReviewersServices {
  const fetch = async (url: string, init: RequestInit) => {
    expect(init.method).toBe("GET");
    expect(["manual", "error"]).toContain(String(init.redirect));
    seen.authorization.push(String((init.headers as Record<string, string>).Authorization));
    const parsed = new URL(url);
    seen.urls.push(parsed);
    return answer(parsed);
  };
  return {
    discoverRepository: cwd => discoverRepository(cwd),
    loadConfig: repository => loadRepositoryConfig(repository),
    listWorktreeInventory: repository => listWorktreeInventory(repository),
    readBase: (repository, tree) => readBaseAssociation(repository, tree),
    env: {},
    github: { token: async () => { seen.logins++; return token; }, fetch },
    bitbucket: { login: async () => { seen.logins++; return { email, token: bitbucketToken }; }, fetch },
    timeoutMs: 5_000,
    ...overrides,
  };
}

async function commit(path: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(path, name)), { recursive: true });
    await writeFile(join(path, name), content);
  }
  await git(path, "add", ".");
  await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "change");
}

const codeowners = "* @acme/everyone\n/src/ @Alice @acme/core\n/docs/ @docs-owner docs@example.invalid\n/web/ @other-org/web @ME\n";

/** A feature worktree based on origin/trunk, with CODEOWNERS in the base. */
async function withFeature(remote: string, run: (fixture: { primary: string; directory: string; feature: string }) => Promise<void>,
  setBase = true, owners = codeowners) {
  await withRepository(async (primary, directory) => {
    await git(primary, "remote", "add", "origin", remote);
    await commit(primary, { ".github/CODEOWNERS": owners, "CODEOWNERS": "* @not-used\n" });
    await git(primary, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    const feature = join(directory, "feature");
    await git(primary, "worktree", "add", "-b", "feature/a", feature);
    // The branch's own CODEOWNERS is not the one GitHub uses.
    await commit(feature, { "src/a.ts": "a\n", "web/b.ts": "b\n", "src/CODEOWNERS": "x\n" });
    // Neither later base work nor uncommitted files belong to the branch.
    await commit(primary, { "docs/later.md": "later\n" });
    await git(primary, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    await mkdir(join(feature, "docs"), { recursive: true });
    await writeFile(join(feature, "docs", "untracked.md"), "x\n");
    if (setBase) await saveBase(feature, "refs/remotes/origin/trunk");
    await run({ primary, directory, feature });
  });
}

async function saveBase(path: string, ref: string) {
  const repository = await discoverRepository(path);
  const tree = (await listWorktrees(repository)).find(item => item.path === repository.currentWorktreeRoot)!;
  await writeBaseAssociation(repository, tree, ref);
}

const person = (login: string, push = true) => ({ login, type: "User", permissions: { pull: true, push }, role_name: push ? "write" : "read" });
const githubAnswer = (overrides: Record<string, Answer> = {}): Answer => url => {
  const route = url.pathname.replace("/repos/acme/widgets/", "");
  if (overrides[route]) return overrides[route](url);
  if (route === "/user") return Response.json({ login: "Me" });
  if (route === "collaborators") return Response.json([person("alice"), person("Zed"), person("me"), person("reader", false), person("ci[bot]")]);
  if (route === "teams") return Response.json([{ slug: "core", permission: "push" }, { slug: "design", permission: "pull" }]);
  throw new Error(`unexpected ${url}`);
};
const entryOf = (kind: "user" | "team", id: string, codeOwner = false) => ({ kind, id, name: id, codeOwner, defaultReviewer: false });

const full = [entryOf("user", "Alice", true), entryOf("team", "acme/core", true), entryOf("team", "acme/design"), entryOf("user", "Zed")]
  .map(item => item.id === "Alice" ? { ...item, id: "alice", name: "alice" } : item);

test("GitHub lists collaborators with write access, teams and code owners of committed changes without the signed-in user", async () => {
  await withFeature("git@github.com:acme/widgets.git", async ({ primary, directory, feature }) => {
    const seen = fresh();
    const before = await snapshot(directory, [primary, feature]);
    const record = await readAppReviewers(primary, feature, services(seen, githubAnswer()));
    expect(await snapshot(directory, [primary, feature])).toBe(before);
    expect(record).toMatchObject({ schemaVersion: 1, outcome: "found", reason: null, diagnostic: null, incomplete: [],
      worktree: { path: feature, branch: "feature/a", isPrimary: false },
      pullRequestRepository: { host: "github", owner: "acme", name: "widgets" } });
    expect(record.reviewers).toEqual([full[1]!, full[0]!, full[2]!, full[3]!]);
    expect(seen.logins).toBe(1);
    expect(new Set(seen.authorization)).toEqual(new Set([`Bearer ${token}`]));
    expect(seen.urls.map(url => url.href).sort()).toEqual([
      "https://api.github.com/repos/acme/widgets/collaborators?permission=push&per_page=100",
      "https://api.github.com/repos/acme/widgets/teams?per_page=100", "https://api.github.com/user"]);
    // A branch name selects the same worktree from any directory of the repository.
    expect((await readAppReviewers(feature, "feature/a", services(fresh(), githubAnswer()))).reviewers).toEqual(record.reviewers);
    expect(JSON.stringify(record)).not.toContain(token);
  });
});

test("GitHub pages are followed only on GitHub's API, and a list cut short keeps what was read", async () => {
  await withFeature("https://github.com/acme/widgets.git", async ({ feature }) => {
    const paged = (last: string): Answer => url => url.searchParams.has("page")
      ? Response.json([person("second")], last ? { headers: { link: `<${last}>; rel="next"` } } : {})
      : Response.json([person("first"), { login: 3 }], { headers: { link: `<https://api.github.com/repos/acme/widgets/collaborators?page=2>; rel="next", <https://api.github.com/x>; rel="last"` } });
    const read = async (last: string) => {
      const seen = fresh();
      const record = await readAppReviewers(feature, feature, services(seen, githubAnswer({ collaborators: paged(last) })));
      expect(record.reviewers.map(item => item.id)).toEqual(expect.arrayContaining(["first", "second", "acme/design"]));
      expect(record.incomplete).toMatchObject([{ list: "collaborators", reason: "failed" }]);
      return seen.urls;
    };
    // An unreadable entry, a next link to another host, and more pages than Timber reads.
    expect(await read("")).toHaveLength(4);
    expect((await read("https://evil.example.invalid/next")).every(url => url.origin === "https://api.github.com")).toBe(true);
    expect((await read("https://api.github.com/repos/acme/widgets/collaborators?page=3")).filter(url => url.pathname.endsWith("collaborators"))).toHaveLength(10);
  });
});

test("a list that cannot be read is incomplete with fixed wording and the others stay listed", async () => {
  await withFeature("git@github.com:acme/widgets.git", async ({ feature }) => {
    const leak = `leaked ${token} body`;
    const cases: [string, string, Answer, string][] = [
      ["collaborators", "collaborators", () => Response.json({ message: leak }, { status: 403 }), "forbidden"],
      ["teams", "teams", () => Response.json({ message: leak }, { status: 404 }), "not-found"],
      ["teams", "teams", () => new Response(leak, { status: 401 }), "sign-in-needed"],
      ["teams", "teams", () => new Response(leak, { status: 429 }), "failed"],
      ["teams", "teams", () => new Response(leak, { status: 500 }), "failed"],
      ["collaborators", "collaborators", () => new Response(leak, { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "failed"],
      ["teams", "teams", () => new Response(null, { status: 301, headers: { location: "https://evil.example.invalid" } }), "failed"],
      ["teams", "teams", () => new Response(leak), "failed"],
      ["teams", "teams", () => Response.json({ leak }), "failed"],
      ["collaborators", "collaborators", () => { throw new TypeError(leak); }, "offline"],
      ["/user", "account", () => Response.json({ message: leak }, { status: 403 }), "forbidden"],
      ["/user", "account", () => Response.json({ id: leak }), "failed"],
    ];
    for (const [route, list, answer, reason] of cases) {
      const record = await readAppReviewers(feature, feature, services(fresh(), githubAnswer({ [route]: answer })));
      expect(record.outcome).toBe("found");
      expect(record.incomplete).toMatchObject([{ list, reason }]);
      const text = JSON.stringify(record);
      expect(text).not.toContain("leaked");
      expect(text).not.toContain(token);
      expect(text).not.toContain("issue");
      const ids = record.reviewers.map(item => item.id);
      // Code owners come from Git, so they are listed whatever the host answers.
      expect(ids.map(id => id.toLowerCase())).toContain("alice");
      expect(ids).toContain("acme/core");
      expect(ids.includes("acme/design")).toBe(list !== "teams");
      expect(ids.includes("Zed")).toBe(list !== "collaborators");
      // Without an account, the signed-in user cannot be told apart.
      expect(ids.some(id => id.toLowerCase() === "me")).toBe(list === "account");
    }
  });
});

test("a missing login and a host that never answers leave local code owners, within the time limit", async () => {
  await withFeature("git@github.com:acme/widgets.git", async ({ feature }) => {
    const seen = fresh();
    const signedOut = await readAppReviewers(feature, feature, services(seen, githubAnswer(), {
      github: { token: async () => { throw new Error(`no ${token}`); }, fetch: async () => { throw new Error("must not contact GitHub"); } } }));
    expect(signedOut).toMatchObject({ outcome: "found", incomplete: [
      { list: "collaborators", reason: "sign-in-needed" }, { list: "teams", reason: "sign-in-needed" }, { list: "account", reason: "sign-in-needed" }] });
    expect(signedOut.reviewers.map(item => item.id)).toEqual(["acme/core", "Alice", "ME"]);

    const hang = () => new Promise<Response>(() => {});
    const started = performance.now();
    const slow = await readAppReviewers(feature, feature, services(fresh(), githubAnswer({ teams: hang }), { timeoutMs: 400 }));
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(slow.incomplete).toMatchObject([{ list: "teams", reason: "offline" }]);
    expect(slow.reviewers.map(item => item.id)).toEqual(["acme/core", "alice", "Zed"]);
    const stuck = await readAppReviewers(feature, feature, services(fresh(), githubAnswer(), { timeoutMs: 200,
      github: { token: () => new Promise<string>(() => {}), fetch: async () => { throw new Error("must not contact GitHub"); } } }));
    expect(stuck.incomplete.map(item => [item.list, item.reason])).toEqual([["collaborators", "offline"], ["teams", "offline"], ["account", "offline"]]);
  });
});

test("the saved base decides the code owners and the repository; without one only code owners are incomplete", async () => {
  await withFeature("git@github.com:someone/fork.git", async ({ primary, feature }) => {
    await git(primary, "remote", "add", "upstream", "https://github.com/acme/widgets.git");
    const answer: Answer = url => url.pathname === "/user" ? Response.json({ login: "me" }) : Response.json([]);
    const read = () => readAppReviewers(feature, feature, services(fresh(), answer));
    const none = await read();
    expect(none.pullRequestRepository).toEqual({ host: "github", owner: "someone", name: "fork" });
    expect(none.reviewers).toEqual([]);
    expect(none.incomplete).toMatchObject([{ list: "code-owners", reason: "no-base" }]);

    await git(primary, "update-ref", "refs/remotes/upstream/trunk", "refs/remotes/origin/trunk");
    await saveBase(feature, "refs/remotes/upstream/trunk");
    const upstream = await read();
    expect(upstream.pullRequestRepository).toEqual({ host: "github", owner: "acme", name: "widgets" });
    // Another organization's team is never an owner here.
    expect(upstream.reviewers.map(item => item.id)).toEqual(["acme/core", "Alice"]);
    expect(upstream.incomplete).toEqual([]);

    // A commit base has CODEOWNERS too.
    await saveBase(feature, (await git(feature, "rev-parse", "HEAD~1")));
    expect((await read()).reviewers.map(item => item.id)).toEqual(["Alice"]);
    await saveBase(feature, "refs/heads/trunk");
    expect((await read()).reviewers.map(item => item.id)).toEqual(["Alice"]);

    // Without a saved remote branch: the configured remote, then origin, then the only remote.
    const remoteOf = async (remote: string | null) => readAppReviewers(feature, feature, services(fresh(), answer, {
      loadConfig: async repository => ({ ...await loadRepositoryConfig(repository), remote }) }));
    expect((await remoteOf("upstream")).pullRequestRepository?.owner).toBe("acme");
    await git(primary, "remote", "rename", "origin", "fork");
    expect(await remoteOf(null)).toMatchObject({ outcome: "failed", reason: "not-supported", diagnostic: expect.stringContaining("No remote is selected") });
    await saveBase(feature, "refs/remotes/removed/trunk");
    expect(await read()).toMatchObject({ outcome: "failed", reason: "not-supported", diagnostic: expect.stringContaining("no longer configured") });

    await saveBase(feature, "refs/remotes/upstream/trunk");
    await git(primary, "update-ref", "-d", "refs/remotes/upstream/trunk");
    expect((await read()).incomplete).toMatchObject([{ list: "code-owners", reason: "failed", diagnostic: expect.stringContaining("no longer exists") }]);
  }, false);
});

test("code owners: file order, symlinks, missing files, renames and deletions, unrelated history", async () => {
  await withRepository(async primary => {
    const base = await git(primary, "rev-parse", "HEAD");
    const repository = await discoverRepository(primary);
    const names = async (from: string, to = "HEAD") => (await readCodeOwners(repository, from, await git(primary, "rev-parse", to))).map(owner => owner.name).sort();
    await commit(primary, { "a.txt": "a\n" });
    expect(await names(base)).toEqual([]);
    await commit(primary, { "docs/CODEOWNERS": "* @docs\n" });
    const docs = await git(primary, "rev-parse", "HEAD");
    await commit(primary, { "b.txt": "b\n" });
    expect(await names(docs)).toEqual(["docs"]);
    await symlink("docs/CODEOWNERS", join(primary, "CODEOWNERS"));
    await commit(primary, {});
    const linked = await git(primary, "rev-parse", "HEAD");
    await commit(primary, { "c.txt": "c\n" });
    expect(await names(linked)).toEqual(["docs"]);
    await git(primary, "rm", "-q", "CODEOWNERS");
    await commit(primary, { "CODEOWNERS": "/old* @old\n/new* @new\n/tracked.txt @gone\n/é/ @accent\n" });
    const root = await git(primary, "rev-parse", "HEAD");
    await git(primary, "mv", "old name.txt", "new name.txt");
    await git(primary, "rm", "-q", "tracked.txt");
    await commit(primary, { "é/x": "x\n" });
    expect(await names(root)).toEqual(["accent", "gone", "new", "old"]);
    const orphan = (await git(primary, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit-tree", "HEAD^{tree}", "-m", "orphan"));
    await expect(readCodeOwners(repository, root, orphan)).rejects.toThrow("share no commit");
    await expect(readCodeOwners(repository, "--all", root)).rejects.toThrow("not a branch or a commit");
    await commit(primary, Object.fromEntries(Array.from({ length: 3001 }, (_, index) => [`many/${index}`, "x\n"])));
    await expect(readCodeOwners(repository, root, await git(primary, "rev-parse", "HEAD"))).rejects.toThrow("more than 3,000 files");
    await commit(primary, { "CODEOWNERS": `* @big\n${"#".repeat(3 * 1024 * 1024)}\n` });
    const big = await git(primary, "rev-parse", "HEAD");
    await commit(primary, { "d.txt": "d\n" });
    await expect(readCodeOwners(repository, big, await git(primary, "rev-parse", "HEAD"))).rejects.toThrow("larger than 3 MB");
  });
});

const account = (id: string, name: string | null, extra: Record<string, unknown> = {}) => ({ type: "user", account_id: id, display_name: name, nickname: "nick", uuid: `{${id}}`, ...extra });
const bitbucketAnswer = (overrides: Record<string, Answer> = {}): Answer => url => {
  const route = url.pathname.replace("/2.0/", "");
  if (overrides[route]) return overrides[route](url);
  if (route === "user") return Response.json(account("557058:me", "Dev"));
  if (route === "workspaces/acme/members") {
    return Response.json({ values: ["557058:me", "id-rita", "id-sam"].map(id => ({ type: "workspace_membership", user: account(id, id === "557058:me" ? "Dev" : "Sam Smith") }))
      .concat([{ type: "workspace_membership", user: account("id-app", "Bot", { type: "app_user" }) },
        { type: "workspace_membership", user: account("id-gone", "Gone", { account_status: "inactive" }) }]) });
  }
  if (route === "repositories/acme/widgets/effective-default-reviewers") {
    return Response.json({ values: [{ type: "default_reviewer", reviewer_type: "project", user: account("id-rita", "Rita") },
      { type: "default_reviewer", reviewer_type: "repository", user: account("557058:me", "Dev") }] });
  }
  throw new Error(`unexpected ${url}`);
};
const member = (id: string, name: string, defaultReviewer = false) => ({ kind: "user", id, name, codeOwner: false, defaultReviewer });

test("Bitbucket lists workspace members and default reviewers by account ID without the signed-in user", async () => {
  await withFeature("https://dev@bitbucket.org/acme/widgets.git", async ({ primary, directory, feature }) => {
    const seen = fresh();
    const before = await snapshot(directory, [primary, feature]);
    const record = await readAppReviewers(feature, feature, services(seen, bitbucketAnswer()));
    expect(await snapshot(directory, [primary, feature])).toBe(before);
    expect(record).toMatchObject({ outcome: "found", incomplete: [], pullRequestRepository: { host: "bitbucket", owner: "acme", name: "widgets" } });
    // Display names are not unique; CODEOWNERS in the base is a GitHub file and is not used.
    expect(record.reviewers).toEqual([member("id-rita", "Rita", true), member("id-sam", "Sam Smith")] as typeof record.reviewers);
    expect(seen.logins).toBe(1);
    expect(seen.urls).toHaveLength(3);
    expect(new Set(seen.authorization)).toEqual(new Set([`Basic ${Buffer.from(`${email}:${bitbucketToken}`).toString("base64")}`]));
  });
});

test("Bitbucket lists that cannot be read are incomplete without dropping the others or echoing anything", async () => {
  await withFeature("git@bitbucket.org:acme/widgets.git", async ({ feature }) => {
    const leak = `leaked ${bitbucketToken} ${email}`;
    const members = "workspaces/acme/members", defaults = "repositories/acme/widgets/effective-default-reviewers";
    const cases: [string, string, Answer, string][] = [
      [members, "members", () => Response.json({ error: { message: leak } }, { status: 403 }), "forbidden"],
      [members, "members", () => new Response(leak, { status: 401 }), "sign-in-needed"],
      [members, "members", () => new Response(leak, { status: 404 }), "not-found"],
      [members, "members", () => new Response(leak, { status: 429 }), "failed"],
      [members, "members", () => new Response(leak), "failed"],
      [members, "members", () => Response.json({ values: leak }), "failed"],
      [members, "members", () => { throw new TypeError(leak); }, "offline"],
      [members, "members", () => new Promise<Response>(() => {}), "offline"],
      [members, "members", () => Response.json({ values: [{ user: account("id-kim", null) }, { user: account("id-old", "Old", { account_id: null }) }, { user: null }] }), "failed"],
      [members, "members", () => Response.json({ values: [], next: "https://evil.example.invalid/2.0/workspaces/acme/members?page=2" }), "failed"],
      [members, "members", () => Response.json({ values: [], next: "https://api.bitbucket.org/2.0/user" }), "failed"],
      [members, "members", url => Response.json({ values: [], next: `${url.origin}${url.pathname}?page=2` }), "failed"],
      [defaults, "default-reviewers", () => Response.json({ error: { message: leak } }, { status: 403 }), "forbidden"],
      ["user", "account", () => Response.json({ error: { message: leak } }, { status: 403 }), "forbidden"],
      ["user", "account", () => Response.json({ display_name: leak }), "failed"],
    ];
    for (const [route, list, answer, reason] of cases) {
      const record = await readAppReviewers(feature, feature, services(fresh(), bitbucketAnswer({ [route]: answer }), { timeoutMs: 500 }));
      expect([list, record.outcome]).toEqual([list, "found"]);
      expect(record.incomplete).toMatchObject([{ list, reason }]);
      const text = JSON.stringify(record);
      expect(text).not.toContain("leaked");
      expect(text).not.toContain(bitbucketToken);
      expect(text).not.toContain(email);
      const ids = record.reviewers.map(item => item.id);
      expect(ids).toContain("id-rita");
      expect(ids.includes("id-sam")).toBe(list !== "members");
      expect(ids.includes("557058:me")).toBe(list === "account");
      expect(record.reviewers.find(item => item.id === "id-rita")!.defaultReviewer).toBe(list !== "default-reviewers");
      if (ids.includes("id-kim")) expect(record.reviewers).toContainEqual(member("id-kim", "nick") as typeof record.reviewers[number]);
    }
  });
});

test("Bitbucket pages are read from the same list", async () => {
  await withFeature("git@bitbucket.org:acme/widgets.git", async ({ feature }) => {
    const seen = fresh();
    const record = await readAppReviewers(feature, feature, services(seen, bitbucketAnswer({ "workspaces/acme/members": url => url.searchParams.get("page") === "2"
      ? Response.json({ values: [{ user: account("id-two", "Two") }] })
      : Response.json({ values: [{ user: account("id-one", "One") }], next: "https://api.bitbucket.org/2.0/workspaces/acme/members?pagelen=100&page=2" }) })));
    expect(record.incomplete).toEqual([]);
    expect(record.reviewers.map(item => item.id)).toEqual(["id-rita", "id-one", "id-two"]);
  });
});

test("an unknown worktree or another host fails without reading a login or contacting anything", async () => {
  await withFeature("git@gitlab.com:acme/widgets.git", async ({ feature }) => {
    const seen = fresh();
    const never: Answer = () => { throw new Error("must not contact a host"); };
    expect(await readAppReviewers(feature, "nowhere", services(seen, never))).toMatchObject({ outcome: "failed", reason: "failed", worktree: null,
      diagnostic: expect.stringContaining("No registered worktree") });
    expect(await readAppReviewers(feature, feature, services(seen, never))).toMatchObject({ outcome: "failed", reason: "not-supported",
      pullRequestRepository: null, reviewers: [], incomplete: [] });
    expect(seen).toEqual(fresh());
  });
});

test("the CLI prints one record with no prompt, no token and no change", async () => {
  await withFeature("git@github.com:acme/widgets.git", async ({ primary, directory, feature }) => {
    const home = join(directory, "config home");
    await mkdir(home);
    const run = async (cwd: string, target: string, env: Record<string, string | undefined>) => {
      const result = await execa(process.execPath, ["--no-env-file", entry, "__app-reviewers", "--", target], {
        cwd, reject: false, timeout: 30_000, stdin: "ignore",
        env: { CI: "true", XDG_CONFIG_HOME: home, GITHUB_TOKEN: undefined, ...env },
      });
      expect(result.stdout + result.stderr).not.toContain(token);
      return { exitCode: result.exitCode, record: JSON.parse(result.stdout) };
    };
    const before = await snapshot(directory, [primary, feature]);
    // Connection refused at a local proxy stands in for having no network.
    const offline = await run(primary, feature, { GH_TOKEN: token, HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" });
    const signedOut = await run(feature, "feature/a", { GH_TOKEN: "" });
    const unknown = await run(primary, "nowhere", { GH_TOKEN: token });
    expect(await snapshot(directory, [primary, feature])).toBe(before);
    for (const [result, reason] of [[offline, "offline"], [signedOut, "sign-in-needed"]] as const) {
      expect(result.exitCode).toBe(0);
      expect(result.record).toMatchObject({ outcome: "found", incomplete: [{ list: "collaborators", reason }, { list: "teams", reason }, { list: "account", reason }] });
      expect(result.record.reviewers.map((item: { id: string }) => item.id)).toEqual(["acme/core", "Alice", "ME"]);
    }
    expect(unknown).toMatchObject({ exitCode: 1, record: { outcome: "failed", reason: "failed" } });
    await git(primary, "remote", "set-url", "origin", "git@bitbucket.org:acme/widgets.git");
    const bitbucket = await run(primary, feature, { BITBUCKET_EMAIL: undefined, BITBUCKET_API_TOKEN: undefined });
    expect(bitbucket).toMatchObject({ exitCode: 0, record: { outcome: "found", reviewers: [], pullRequestRepository: { host: "bitbucket" },
      incomplete: ["default-reviewers", "members", "account"].map(list => ({ list, reason: "sign-in-needed" })) } });
    const outside = await run(directory, feature, { GH_TOKEN: token });
    expect(outside).toMatchObject({ exitCode: 1, record: { schemaVersion: 1, repository: null, outcome: "failed", reason: "failed" } });
  });
});
