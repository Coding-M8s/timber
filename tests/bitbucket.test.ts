import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readBitbucketLogin } from "../src/bitbucket/auth";
import type { BitbucketRuntime } from "../src/bitbucket/client";
import { loadSavedBitbucketLogin, readBitbucketCredentialStore, withBitbucketCredentialSave } from "../src/bitbucket/credentials";
import { findOpenBitbucketPullRequest } from "../src/bitbucket/pulls";
import { parseBitbucketRemoteUrl } from "../src/bitbucket/repository";
import { pullRequestRepositoryOfRemote } from "../src/github/repository";
import { repositoryFixture } from "./helpers/services";

test("bitbucket.org clone URLs are recognised and every other form is refused", () => {
  const widgets = { owner: "acme", name: "widgets" };
  for (const url of [
    "https://bitbucket.org/acme/widgets.git", "https://bitbucket.org/acme/widgets", "https://dev.name@bitbucket.org/acme/widgets.git",
    "git@bitbucket.org:acme/widgets.git", "ssh://git@bitbucket.org/acme/widgets.git", "git@ssh.bitbucket.org:acme/widgets.git",
    "ssh://git@altssh.bitbucket.org:443/acme/widgets.git",
  ]) expect(parseBitbucketRemoteUrl(url)).toEqual(widgets);
  expect(parseBitbucketRemoteUrl("https://bitbucket.org/my_team/repo.name.git")).toEqual({ owner: "my_team", name: "repo.name" });
  for (const url of [
    "https://dev:secret@bitbucket.org/acme/widgets.git", "http://bitbucket.org/acme/widgets.git",
    "https://bitbucket.example.com/acme/widgets.git", "https://evilbitbucket.org/acme/widgets.git",
    "https://bitbucket.org.evil/acme/widgets.git", "https://bitbucket.org/acme/widgets/extra",
    "https://bitbucket.org/acme/.git", "https://bitbucket.org/acme/..", "git@bitbucket.org:acme/widgets.git\n",
    "https://bitbucket.example.com/scm/acme/widgets.git", "https://github.com/acme/widgets.git",
  ]) expect(parseBitbucketRemoteUrl(url)).toBeNull();
});

test("a pull request remote is read as GitHub or Bitbucket, and any other host is refused without echoing the URL", async () => {
  const repository = repositoryFixture({ remotes: [{ name: "origin" }] as never });
  const reading = (url: string) => async () => [url];
  expect(await pullRequestRepositoryOfRemote(repository, "origin", "base", false, reading("git@bitbucket.org:acme/widgets.git")))
    .toEqual({ host: "bitbucket", owner: "acme", name: "widgets" });
  expect(await pullRequestRepositoryOfRemote(repository, "origin", "base", false, reading("https://github.com/acme/widgets.git")))
    .toEqual({ host: "github", owner: "acme", name: "widgets" });
  for (const url of ["https://gitlab.com/acme/widgets.git", "https://dev:TOPSECRET@bitbucket.org/acme/widgets.git"]) {
    const refused = await pullRequestRepositoryOfRemote(repository, "origin", "publish", true, reading(url)).catch((error: Error) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBe("The publish remote \"origin\" does not identify one github.com or bitbucket.org repository; Timber creates pull requests only on github.com and bitbucket.org.");
  }
});

test("a supplied Bitbucket login pair wins, a partial or invalid pair fails without fallback, then the saved login is used", async () => {
  let reads = 0;
  const saved = async () => { reads++; return { email: "saved@example.com", token: "SYNTHETIC_SAVED" }; };
  expect(await readBitbucketLogin({ BITBUCKET_EMAIL: "env@example.com", BITBUCKET_API_TOKEN: "SYNTHETIC_ENV" }, saved))
    .toEqual({ email: "env@example.com", token: "SYNTHETIC_ENV" });
  for (const env of [{ BITBUCKET_EMAIL: "env@example.com" }, { BITBUCKET_API_TOKEN: "SYNTHETIC_ENV" },
    { BITBUCKET_EMAIL: "not-an-email", BITBUCKET_API_TOKEN: "t" }, { BITBUCKET_EMAIL: "env@example.com", BITBUCKET_API_TOKEN: "a b" },
    { BITBUCKET_EMAIL: "env@example.com", BITBUCKET_API_TOKEN: "" }]) {
    await expect(readBitbucketLogin(env, saved)).rejects.toThrow(/BITBUCKET_EMAIL and BITBUCKET_API_TOKEN/u);
  }
  expect(reads).toBe(0);
  expect(await readBitbucketLogin({}, saved)).toEqual({ email: "saved@example.com", token: "SYNTHETIC_SAVED" });
  expect(reads).toBe(1);
  await expect(readBitbucketLogin({}, async () => null)).rejects.toThrow("Run timber setup");
});

test("the Bitbucket login is saved privately beside other providers and can be replaced and removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber-bitbucket-"));
  try {
    const env = { HOME: root, XDG_CONFIG_HOME: join(root, "xdg") };
    const store = await readBitbucketCredentialStore(env);
    expect(store.get()).toBeNull();
    expect(() => store.set({ email: "nope", token: "t" })).toThrow("Atlassian account email");
    store.set({ email: "dev@example.com", token: "SYNTHETIC_TOKEN" });
    expect(store.changes()).toEqual([{ action: "save" }]);
    await withBitbucketCredentialSave(store, async () => {});
    expect(store.path).toBe(join(env.XDG_CONFIG_HOME, "timber/credentials/bitbucket.json"));
    expect((await lstat(store.path)).mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(store.path))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual({ version: 1, email: "dev@example.com", token: "SYNTHETIC_TOKEN" });
    const linear = join(dirname(store.path), "linear.json");
    await writeFile(linear, "OTHER_PROVIDER_BYTES", { mode: 0o600 });

    const same = await readBitbucketCredentialStore(env);
    same.set({ email: "dev@example.com", token: "SYNTHETIC_TOKEN" });
    expect(same.changes()).toEqual([]);
    const edit = await readBitbucketCredentialStore(env);
    edit.set({ email: "dev@example.com", token: "REPLACEMENT" });
    await withBitbucketCredentialSave(edit, async () => {});
    expect(await loadSavedBitbucketLogin(env)).toEqual({ email: "dev@example.com", token: "REPLACEMENT" });
    const remove = await readBitbucketCredentialStore(env);
    remove.set(null);
    expect(remove.changes()).toEqual([{ action: "remove" }]);
    await withBitbucketCredentialSave(remove, async () => {});
    expect(await Bun.file(store.path).exists()).toBe(false);
    expect(await readFile(linear, "utf8")).toBe("OTHER_PROVIDER_BYTES");

    await writeFile(store.path, JSON.stringify({ version: 1, email: "dev@example.com", token: "T", extra: 1 }), { mode: 0o600 });
    expect(() => remove.set({ email: "dev\u001b@example.com", token: "T" })).toThrow("Atlassian account email");
    expect(remove.serialize()).toBe(JSON.stringify({ version: 1, email: null, token: null }, null, 2) + "\n");
    const damaged = await readBitbucketCredentialStore(env).catch((error: Error) => error);
    expect((damaged as Error).message).toContain("Cannot read Bitbucket credential store");
    expect((damaged as Error).message).not.toContain("dev@example.com");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the Bitbucket lookup quotes the branch, refuses redirects and times out with a fixed message", async () => {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const runtime = (fetch: BitbucketRuntime["fetch"], timeoutMs = 200): BitbucketRuntime => ({ timeoutMs,
    login: async () => ({ email: "dev@example.com", token: "T" }), fetch });
  const repo = { owner: "acme", name: "widgets" };
  expect(await findOpenBitbucketPullRequest(repo, repo, 'say-"hi"', "main", runtime(async (url, init) => {
    urls.push(url); inits.push(init); return Response.json({ values: [] });
  }))).toBeNull();
  expect(new URL(urls[0]!).searchParams.get("q")).toBe('state = "OPEN" AND source.branch.name = "say-\\"hi\\"" AND destination.branch.name = "main"');
  expect(inits[0]!.redirect).toBe("error");

  await expect(findOpenBitbucketPullRequest(repo, repo, "b", "main", runtime(async () => { throw new TypeError("redirect"); })))
    .rejects.toThrow("Bitbucket network or redirect failure");
  await expect(findOpenBitbucketPullRequest(repo, repo, "b", "main", runtime(() => new Promise(() => {}), 20)))
    .rejects.toThrow("Bitbucket did not answer the pull request lookup in time; nothing was created.");
});
