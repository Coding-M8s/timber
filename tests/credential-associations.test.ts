import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryCredentialKey, selectCredential } from "../src/credential-selection";
import { loadSavedLinearKey, readLinearCredentialStore, withLinearCredentialSave } from "../src/linear/credentials";
import { readLinearKey } from "../src/linear/auth";
import { resolveLinearTicket } from "../src/linear/client";
import { loadSavedCredentials, readCredentialStore, withCredentialSave } from "../src/jira/credentials";
import { resolveJiraTicket } from "../src/jira/client";
import { createNewHandler } from "../src/commands/new";
import { discoverRepository } from "../src/git/repository";
import { resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { writeBaseAssociation } from "../src/git/base-metadata";
import { createServiceDouble } from "./helpers/services";
import { git, withRepository } from "./helpers/git";

async function withConfig(run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "timber-associations-"));
  try { await run({ HOME: root, XDG_CONFIG_HOME: join(root, "xdg") }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const site = { siteUrl: "https://example.atlassian.net" };
const scoped = { siteUrl: "https://example.atlassian.net", cloudId: "00000000-0000-4000-8000-000000000000" };
const issue = { data: { issue: { trashed: null, identifier: "ENG-123", title: "Fix login", state: { type: "started" }, url: "https://linear.app/w/issue/ENG-123" } } };

test("selection treats one entry as the default and requires an association for several", () => {
  expect(selectCredential([], null)).toEqual({ kind: "missing" });
  expect(selectCredential(["default"], null)).toEqual({ kind: "selected", label: "default" });
  expect(selectCredential(["acme", "home"], null)).toEqual({ kind: "unselected" });
  expect(selectCredential(["acme", "home"], "home")).toEqual({ kind: "selected", label: "home" });
});

test("linked worktrees share the primary checkout's repository identity; separate clones do not", async () => {
  await withRepository(async (primary, root) => {
    const linked = join(root, "linked tree");
    await git(primary, "worktree", "add", "-b", "side", linked);
    const clone = join(root, "clone");
    await git(root, "clone", "-q", primary, clone);
    const keys = await Promise.all([primary, linked, clone].map(async cwd =>
      repositoryCredentialKey((await discoverRepository(cwd)).commonGitDir)));
    expect(keys[0]).toBe(keys[1]!);
    expect(keys[2]).not.toBe(keys[0]!);
  });
}, 30_000);

test("Linear keeps the single-key format until a second entry or association exists", async () => {
  await withConfig(async env => {
    const first = await readLinearCredentialStore(env); first.set("SYNTHETIC_ONE");
    await withLinearCredentialSave(first, async () => {});
    expect(JSON.parse(await readFile(first.path, "utf8"))).toEqual({ version: 1, token: "SYNTHETIC_ONE" });
    expect(await loadSavedLinearKey(env, undefined, "/elsewhere/.git")).toBe("SYNTHETIC_ONE");

    const second = await readLinearCredentialStore(env);
    expect(second.labels()).toEqual(["default"]);
    second.set("SYNTHETIC_TWO", "acme"); second.associate("/repo-a/.git", "acme");
    await withLinearCredentialSave(second, async () => {});
    expect(JSON.parse(await readFile(first.path, "utf8"))).toEqual({ version: 2,
      entries: [{ label: "default", token: "SYNTHETIC_ONE" }, { label: "acme", token: "SYNTHETIC_TWO" }],
      associations: [{ repository: "/repo-a/.git", label: "acme" }] });
    expect(await loadSavedLinearKey(env, undefined, "/repo-a/.git")).toBe("SYNTHETIC_TWO");
    await expect(loadSavedLinearKey(env, undefined, "/repo-b/.git")).rejects.toThrow("none is selected for this repository");
    await expect(loadSavedLinearKey(env)).rejects.toThrow("timber setup");

    // Removing an entry drops its associations; the remaining entry becomes the default again.
    const removal = await readLinearCredentialStore(env);
    expect(removal.users("acme")).toEqual(["/repo-a/.git"]);
    removal.set(null, "acme");
    expect(removal.changes()).toEqual([{ kind: "entry", action: "remove", label: "acme" }]);
    await withLinearCredentialSave(removal, async () => {});
    expect(JSON.parse(await readFile(first.path, "utf8"))).toEqual({ version: 1, token: "SYNTHETIC_ONE" });
    expect(await loadSavedLinearKey(env, undefined, "/repo-a/.git")).toBe("SYNTHETIC_ONE");
  });
});

test("Linear clearing an association keeps the entry used by other repositories", async () => {
  await withConfig(async env => {
    const store = await readLinearCredentialStore(env);
    store.set("SYNTHETIC_A", "acme"); store.set("SYNTHETIC_B", "home");
    store.associate("/repo-a/.git", "acme"); store.associate("/repo-b/.git", "acme");
    await withLinearCredentialSave(store, async () => {});
    const edit = await readLinearCredentialStore(env); edit.associate("/repo-a/.git", null);
    expect(edit.changes()).toEqual([{ kind: "association", repository: "/repo-a/.git", label: null }]);
    await withLinearCredentialSave(edit, async () => {});
    expect(await loadSavedLinearKey(env, undefined, "/repo-b/.git")).toBe("SYNTHETIC_A");
    await expect(loadSavedLinearKey(env, undefined, "/repo-a/.git")).rejects.toThrow("none is selected");
  });
});

for (const [kind, source] of [
  ["duplicate label", { version: 2, entries: [{ label: "a", token: "K" }, { label: "a", token: "L" }], associations: [] }],
  ["dangling association", { version: 2, entries: [{ label: "a", token: "K" }], associations: [{ repository: "/r/.git", label: "b" }] }],
  ["relative repository", { version: 2, entries: [{ label: "a", token: "K" }], associations: [{ repository: "r/.git", label: "a" }] }],
  ["invalid label", { version: 2, entries: [{ label: "Has Space", token: "K" }], associations: [] }],
  ["duplicate association", { version: 2, entries: [{ label: "a", token: "K" }], associations: [{ repository: "/r/.git", label: "a" }, { repository: "/r/.git", label: "a" }] }],
] as const) {
  test(`Linear rejects malformed multi-entry storage: ${kind}`, async () => {
    await withConfig(async env => {
      const store = await readLinearCredentialStore(env); store.set("KEY"); await withLinearCredentialSave(store, async () => {});
      await writeFile(store.path, JSON.stringify(source));
      const error = await readLinearCredentialStore(env).catch(caught => caught as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Cannot read Linear credential store");
      expect((error as Error).message).not.toMatch(/KEY|Has Space/u);
    });
  });
}

test("Linear environment override wins over several saved keys and rejects blank values without fallback", async () => {
  await withConfig(async env => {
    const store = await readLinearCredentialStore(env);
    store.set("SYNTHETIC_A", "acme"); store.set("SYNTHETIC_B", "home");
    await withLinearCredentialSave(store, async () => {});
    expect(await readLinearKey({ ...env, LINEAR_API_KEY: "SYNTHETIC_ENV" }, undefined, undefined, "/r/.git")).toBe("SYNTHETIC_ENV");
    await expect(readLinearKey({ ...env, LINEAR_API_KEY: " " }, undefined, undefined, "/r/.git")).rejects.toThrow("No saved-key fallback");
    await expect(readLinearKey(env, undefined, undefined, "/r/.git")).rejects.toThrow("LINEAR_API_KEY");
  });
});

test("Linear lookup uses the key selected from a linked worktree and refuses unselected repositories intact", async () => {
  await withConfig(async env => {
    await withRepository(async (primary, root) => {
      const linked = join(root, "linked");
      await git(primary, "worktree", "add", "-b", "side", linked);
      const repository = await discoverRepository(linked);
      const store = await readLinearCredentialStore(env);
      store.set("SYNTHETIC_PERSONAL", "personal"); store.set("SYNTHETIC_ACME", "acme");
      store.associate(await repositoryCredentialKey(repository.commonGitDir), "acme");
      await withLinearCredentialSave(store, async () => {});

      const used: string[] = [];
      const config = { baseBranch: "trunk", remote: null, worktreeDir: null, editor: null, agent: null };
      const handler = createNewHandler(createServiceDouble({
        discoverRepository, loadConfig: async () => config, resolveBase,
        resolveLinearTicket: (key, allowClosed, repo) => resolveLinearTicket(key, {
          token: signal => readLinearKey(env, undefined, signal, repo?.commonGitDir), timeoutMs: 5_000,
          fetch: async (_url, init) => { used.push(new Headers(init.headers).get("Authorization")!); return Response.json(issue); },
        }, allowClosed),
        createWorktree, writeBaseAssociation, launchEditor: async () => ({ kind: "skipped" }),
      }));
      await handler("linear:ENG-123", { base: "trunk" }, { cwd: primary, io: { stdout() {}, stderr() {} } });
      expect(used).toEqual(["SYNTHETIC_ACME"]);

      await withRepository(async other => {
        const refs = await git(other, "show-ref");
        const trees = await git(other, "worktree", "list", "--porcelain");
        const error = await handler("linear:ENG-123", { base: "trunk" }, { cwd: other, io: { stdout() {}, stderr() {} } })
          .then(() => null, caught => caught as Error);
        expect(error?.message).toContain("none is selected for this repository");
        expect(error?.message).not.toMatch(/SYNTHETIC/u);
        expect(await git(other, "show-ref")).toBe(refs);
        expect(await git(other, "worktree", "list", "--porcelain")).toBe(trees);
        expect(used).toHaveLength(1);
      });
    });
  });
}, 60_000);

test("Jira entries and associations stay isolated by site and token mode", async () => {
  await withConfig(async env => {
    const store = await readCredentialStore(env);
    store.set(site, { email: "one@example.invalid", token: "SYNTHETIC_ONE" });
    store.set(scoped, { email: "scoped@example.invalid", token: "SYNTHETIC_SCOPED" });
    await withCredentialSave(store, async () => {});
    expect(JSON.parse(await readFile(store.path, "utf8")).version).toBe(1);

    const edit = await readCredentialStore(env);
    edit.set(site, { email: "two@example.invalid", token: "SYNTHETIC_TWO" }, "work");
    edit.associate(site, "/repo-a/.git", "work");
    await withCredentialSave(edit, async () => {});
    expect(await loadSavedCredentials(site, env, "/repo-a/.git")).toEqual({ email: "two@example.invalid", token: "SYNTHETIC_TWO" });
    await expect(loadSavedCredentials(site, env, "/repo-b/.git")).rejects.toThrow("none is selected for this repository");
    // The scoped mode still has one entry, so it remains the default even in an associated repository.
    expect(await loadSavedCredentials(scoped, env, "/repo-a/.git")).toEqual({ email: "scoped@example.invalid", token: "SYNTHETIC_SCOPED" });
    expect(await loadSavedCredentials({ siteUrl: "https://other.atlassian.net" }, env, "/repo-a/.git")).toBeNull();
    const reread = await readCredentialStore(env);
    expect(reread.labels(site)).toEqual(["default", "work"]);
    expect(reread.association(scoped, "/repo-a/.git")).toBeNull();
    expect(() => reread.associate(scoped, "/repo-a/.git", "work")).toThrow("unsaved");
  });
});

test("Jira lookup uses the selected pair, keeps environment overrides strict and never mixes sources", async () => {
  await withConfig(async env => {
    const store = await readCredentialStore(env);
    store.set(site, { email: "a@example.invalid", token: "SYNTHETIC_A" }, "alpha");
    store.set(site, { email: "b@example.invalid", token: "SYNTHETIC_B" }, "beta");
    store.associate(site, "/repo/.git", "beta");
    await withCredentialSave(store, async () => {});
    const auth: string[] = [];
    const runtime = (overrides: Record<string, string>, repository: string | null) => ({
      env: overrides, timeoutMs: 5_000,
      loadCredentials: (config: typeof site) => loadSavedCredentials(config, env, repository),
      fetch: async (_url: string, init: RequestInit) => {
        auth.push(Buffer.from(new Headers(init.headers).get("Authorization")!.slice(6), "base64").toString());
        return Response.json({ key: "ENG-1", fields: { summary: "Fix", status: { statusCategory: { key: "indeterminate" } } } });
      },
    });
    await resolveJiraTicket(site, "ENG-1", runtime({}, "/repo/.git"));
    await resolveJiraTicket(site, "ENG-1", runtime({ JIRA_EMAIL: "env@example.invalid", JIRA_API_TOKEN: "SYNTHETIC_ENV" }, null));
    await expect(resolveJiraTicket(site, "ENG-1", runtime({ JIRA_EMAIL: "env@example.invalid" }, "/repo/.git"))).rejects.toThrow("sources are never mixed");
    await expect(resolveJiraTicket(site, "ENG-1", runtime({}, "/unselected/.git"))).rejects.toThrow("none is selected");
    expect(auth).toEqual(["b@example.invalid:SYNTHETIC_B", "env@example.invalid:SYNTHETIC_ENV"]);
  });
});

test("Jira legacy stores migrate on save and failed publication restores exact bytes", async () => {
  await withConfig(async env => {
    const first = await readCredentialStore(env);
    first.set(site, { email: "one@example.invalid", token: "SYNTHETIC_ONE" });
    await withCredentialSave(first, async () => {});
    const before = await readFile(first.path);
    const draft = await readCredentialStore(env);
    draft.set(site, { email: "two@example.invalid", token: "SYNTHETIC_TWO" }, "work");
    draft.associate(site, "/repo/.git", "work");
    await expect(withCredentialSave(draft, async () => { throw new Error("config publication failed"); })).rejects.toThrow("config publication failed");
    expect(await readFile(first.path)).toEqual(before);
    expect((await readdir(join(first.path, ".."))).filter(name => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
  });
});
