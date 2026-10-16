import { expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { credentialIdentity, readCredentialStore, loadSavedCredentials, withCredentialSave } from "../src/jira/credentials";

const site = { siteUrl: "https://example.atlassian.net" };
const pair = { email: "person@example.invalid", token: "SYNTHETIC_TOKEN" };
async function fixture(run: (env: NodeJS.ProcessEnv, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "timber-credentials-"));
  try { await run({ HOME: root, XDG_CONFIG_HOME: join(root, "xdg") }, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("private XDG credentials isolate site and token mode and normalize origins/UUIDs", async () => {
  await fixture(async (env) => {
    const store = await readCredentialStore(env);
    store.set(site, pair);
    await withCredentialSave(store, async () => {});
    expect(store.path).toBe(join(env.XDG_CONFIG_HOME!, "timber/credentials/jira.json"));
    expect((await lstat(store.path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(env.XDG_CONFIG_HOME!, "timber/credentials"))).mode & 0o777).toBe(0o700);
    expect(await loadSavedCredentials({ siteUrl: "https://EXAMPLE.atlassian.net/" }, env)).toEqual(pair);
    expect(await loadSavedCredentials({ siteUrl: "https://other.atlassian.net" }, env)).toBeNull();
    expect(await loadSavedCredentials({ ...site, cloudId: "00000000-0000-4000-8000-000000000000" }, env)).toBeNull();
    expect(credentialIdentity({ ...site, cloudId: "ABCDEF00-0000-4000-8000-000000000000" }))
      .toBe(credentialIdentity({ ...site, cloudId: "abcdef00-0000-4000-8000-000000000000" }));
  });
});

test("relative XDG falls back to HOME and cancel/no edits do not create storage", async () => {
  await fixture(async (env) => {
    env.XDG_CONFIG_HOME = "relative";
    const store = await readCredentialStore(env);
    expect(store.path).toBe(join(env.HOME!, ".config/timber/credentials/jira.json"));
    await withCredentialSave(store, async () => {});
    expect(await Bun.file(store.path).exists()).toBe(false);
    store.set(site, pair);
    const controller = new AbortController(); controller.abort();
    await expect(withCredentialSave(store, async () => {}, controller.signal)).rejects.toThrow(/cancel/i);
    expect(await Bun.file(store.path).exists()).toBe(false);
  });
});

test("replace and remove retain other identities; failed config save restores exact prior bytes", async () => {
  await fixture(async env => {
    const first = await readCredentialStore(env);
    first.set(site, pair);
    first.set({ siteUrl: "https://other.atlassian.net" }, { ...pair, token: "OTHER_SYNTHETIC" });
    await withCredentialSave(first, async () => {});
    const original = await readFile(first.path);
    const edit = await readCredentialStore(env);
    edit.set(site, { ...pair, token: "REPLACEMENT_SYNTHETIC" });
    await expect(withCredentialSave(edit, async () => { throw new Error("publication failed"); })).rejects.toThrow("publication failed");
    expect(await readFile(first.path)).toEqual(original);
    const remove = await readCredentialStore(env); remove.set(site, null);
    await withCredentialSave(remove, async () => {});
    expect(await loadSavedCredentials(site, env)).toBeNull();
    expect(await loadSavedCredentials({ siteUrl: "https://other.atlassian.net" }, env)).toEqual({ ...pair, token: "OTHER_SYNTHETIC" });
  });
});

test("removing the last pair deletes the store file instead of leaving empty records", async () => {
  await fixture(async env => {
    const store = await readCredentialStore(env);
    store.set(site, pair);
    await withCredentialSave(store, async () => {});
    expect(await Bun.file(store.path).exists()).toBe(true);
    const empty = await readCredentialStore(env);
    empty.set(site, null);
    await withCredentialSave(empty, async () => {});
    expect(await Bun.file(empty.path).exists()).toBe(false);
    expect(await loadSavedCredentials(site, env)).toBeNull();
  });
});

test("publishConfig errors keep their message even when they carry a system code", async () => {
  await fixture(async env => {
    const store = await readCredentialStore(env);
    store.set(site, pair);
    const failure = Object.assign(new Error("publication EACCES detail"), { code: "EACCES" });
    await expect(withCredentialSave(store, async () => { throw failure; })).rejects.toThrow("publication EACCES detail");
    expect(await Bun.file(store.path).exists()).toBe(false);
  });
});

test("failed new-store save removes owned publication; concurrent edits and stale drafts survive", async () => {
  await fixture(async env => {
    const store = await readCredentialStore(env); store.set(site, pair);
    await expect(withCredentialSave(store, async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    expect(await Bun.file(store.path).exists()).toBe(false);
    const stale = await readCredentialStore(env); stale.set(site, pair);
    const fresh = await readCredentialStore(env); fresh.set(site, { ...pair, token: "FRESH_SYNTHETIC" });
    await withCredentialSave(fresh, async () => {});
    await expect(withCredentialSave(stale, async () => {})).rejects.toThrow(/changed/i);
    const editing = await readCredentialStore(env); editing.set(site, pair);
    await expect(withCredentialSave(editing, async () => {
      await writeFile(editing.path, "CONCURRENT_SYNTHETIC", { mode: 0o600 });
      throw new Error("fail");
    })).rejects.toThrow(/rollback.*incomplete/i);
    expect(await readFile(editing.path, "utf8")).toBe("CONCURRENT_SYNTHETIC");
  });
});

test("unsafe modes, malformed stores, links, and repository locations fail closed without contents in errors", async () => {
  await fixture(async (env, root) => {
    const store = await readCredentialStore(env); store.set(site, pair);
    await withCredentialSave(store, async () => {});
    await chmod(store.path, 0o644);
    await expect(loadSavedCredentials(site, env)).rejects.toThrow(/permissions/i);
    await chmod(store.path, 0o600);
    await writeFile(store.path, "SYNTHETIC_PRIVATE_BODY");
    const failure = await loadSavedCredentials(site, env).then(() => new Error("Unexpected success"), error => error as Error);
    expect(failure.message).toMatch(/credential store/i);
    expect(failure.message).not.toContain("SYNTHETIC_PRIVATE_BODY");
    await rm(store.path);
    const target = join(root, "secret"); await writeFile(target, "SYNTHETIC_PRIVATE_BODY");
    await symlink(target, store.path);
    await expect(loadSavedCredentials(site, env)).rejects.toThrow(/regular|symlink/i);
    const repo = join(root, "repo"); await mkdir(repo);
    await execa("git", ["init", "--quiet", repo]);
    await expect(readCredentialStore({ HOME: root, XDG_CONFIG_HOME: join(repo, "personal") })).rejects.toThrow(/outside.*Git/i);
    await expect(readCredentialStore({ HOME: root, XDG_CONFIG_HOME: join(repo, ".git/personal") })).rejects.toThrow(/outside.*Git/i);
  });
});

test("private-directory permissions, store locks, duplicate records, and bare Git stores are rejected", async () => {
  await fixture(async (env, root) => {
    const store = await readCredentialStore(env); store.set(site, pair); await withCredentialSave(store, async () => {});
    const original = await readFile(store.path);
    const directory = join(env.XDG_CONFIG_HOME!, "timber/credentials");
    await chmod(directory, 0o755);
    await expect(loadSavedCredentials(site, env)).rejects.toThrow(/permissions/i);
    await chmod(directory, 0o700);
    const locked = await readCredentialStore(env); locked.set(site, { ...pair, token: "REPLACEMENT_SYNTHETIC" });
    await writeFile(join(directory, ".jira.lock"), "", { mode: 0o600 });
    await expect(withCredentialSave(locked, async () => {})).rejects.toThrow(/locked/);
    expect(await readFile(store.path)).toEqual(original);
    await rm(join(directory, ".jira.lock"));
    const duplicate = JSON.parse(original.toString()); duplicate.records.push(duplicate.records[0]);
    await writeFile(store.path, JSON.stringify(duplicate));
    await expect(loadSavedCredentials(site, env)).rejects.toThrow(/credential store/);
    const bare = join(root, "bare.git"); await execa("git", ["init", "--bare", "--quiet", bare]);
    await expect(readCredentialStore({ HOME: root, XDG_CONFIG_HOME: join(bare, "private") })).rejects.toThrow(/outside.*Git/);
  });
});

test("cancellation before config publication rolls back, while config commit point retains saved credentials", async () => {
  await fixture(async env => {
    const initial = await readCredentialStore(env); initial.set(site, pair); await withCredentialSave(initial, async () => {});
    const original = await readFile(initial.path);
    const controller = new AbortController();
    const draft = await readCredentialStore(env); draft.set(site, { ...pair, token: "REPLACEMENT_SYNTHETIC" });
    await expect(withCredentialSave(draft, async () => {
      controller.abort(); throw new Error("Cancelled before config publication");
    }, controller.signal)).rejects.toThrow(/Cancelled/);
    expect(await readFile(initial.path)).toEqual(original);
    const committed = await readCredentialStore(env); committed.set(site, { ...pair, token: "COMMITTED_SYNTHETIC" });
    const afterCommit = new AbortController();
    await withCredentialSave(committed, async () => { afterCommit.abort(); }, afterCommit.signal);
    expect(await loadSavedCredentials(site, env)).toEqual({ ...pair, token: "COMMITTED_SYNTHETIC" });
  });
});

test("Git discovery policy refusals and ceiling overrides cannot permit credentials inside repositories", async () => {
  await fixture(async (_env, root) => {
    const module = fileURLToPath(new URL("../src/jira/credentials.ts", import.meta.url));
    for (const bare of [true, false]) {
      const repo = join(root, bare ? "bare.git" : "worktree");
      await execa("git", ["init", ...(bare ? ["--bare"] : []), "--quiet", repo]);
      const xdg = join(repo, "private");
      const source = `import {readCredentialStore,withCredentialSave} from ${JSON.stringify(module)};
        try { const s=await readCredentialStore(); s.set({siteUrl:'https://example.atlassian.net'}, {email:'test@example.invalid',token:'SYNTHETIC'}); await withCredentialSave(s,async()=>{}); }
        catch(error) { process.stderr.write(error.message); process.exitCode=1; }`;
      const result = await execa(process.execPath, ["--no-env-file", "--eval", source], {
        reject: false, env: { HOME: root, XDG_CONFIG_HOME: xdg,
          GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit",
          ...(bare ? {} : { GIT_CEILING_DIRECTORIES: repo }),
        },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toContain("SYNTHETIC");
      expect(await Bun.file(join(xdg, "timber/credentials/jira.json")).exists()).toBe(false);
    }
  });
});

test("new-store publication preserves a competing file at the final publication boundary", async () => {
  await fixture(async env => {
    const store = await readCredentialStore(env); store.set(site, pair);
    let configPublished = false;
    await expect(withCredentialSave(store, async () => { configPublished = true; }, undefined, {
      link: async (source, destination) => {
        await writeFile(destination, "CONCURRENT_SYNTHETIC", { mode: 0o600 });
        return link(source, destination);
      },
    })).rejects.toThrow(/preserved/);
    expect(await readFile(store.path, "utf8")).toBe("CONCURRENT_SYNTHETIC");
    expect(configPublished).toBe(false);
  });
});

test("last-record rollback cannot replace a concurrently created store", async () => {
  await fixture(async env => {
    const initial = await readCredentialStore(env); initial.set(site, pair);
    await withCredentialSave(initial, async () => {});
    const empty = await readCredentialStore(env); empty.set(site, null);
    await expect(withCredentialSave(empty, async () => { throw new Error("Config publication failed"); }, undefined, {
      link: async (source, destination) => {
        await writeFile(destination, "CONCURRENT_SYNTHETIC", { mode: 0o600 });
        return link(source, destination);
      },
    })).rejects.toThrow(/rollback was incomplete/);
    expect(await readFile(empty.path, "utf8")).toBe("CONCURRENT_SYNTHETIC");
  });
});
