import { expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLinearCredentialStore, loadSavedLinearKey, withLinearCredentialSave } from "../src/linear/credentials";
import { git, withRepository } from "./helpers/git";

async function fixture(run: (env: NodeJS.ProcessEnv, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "timber-linear-"));
  try { await run({ HOME: root, XDG_CONFIG_HOME: join(root, "xdg") }, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("Linear storage is private, shared, versioned and independent of other providers", async () => {
  await fixture(async env => {
    const store = await readLinearCredentialStore(env);
    expect(store.get()).toBeNull();
    expect(store.changes()).toEqual([]);
    await withLinearCredentialSave(store, async () => {});
    expect(await Bun.file(store.path).exists()).toBe(false);
    store.set("SYNTHETIC_KEY");
    await withLinearCredentialSave(store, async () => {});
    expect(store.path).toBe(join(env.XDG_CONFIG_HOME!, "timber/credentials/linear.json"));
    expect((await lstat(store.path)).mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(store.path))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual({ version: 1, token: "SYNTHETIC_KEY" });
    expect(await loadSavedLinearKey(env)).toBe("SYNTHETIC_KEY");
    const jira = join(dirname(store.path), "jira.json");
    await writeFile(jira, "OTHER_PROVIDER_BYTES", { mode: 0o600 });
    const edit = await readLinearCredentialStore(env); edit.set("REPLACEMENT");
    await withLinearCredentialSave(edit, async () => {});
    expect(await loadSavedLinearKey(env)).toBe("REPLACEMENT");
    const remove = await readLinearCredentialStore(env); remove.set(null);
    await withLinearCredentialSave(remove, async () => {});
    expect(await Bun.file(store.path).exists()).toBe(false);
    expect(await readFile(jira, "utf8")).toBe("OTHER_PROVIDER_BYTES");
  });
});

for (const initial of [null, "OLD_KEY"] as const) {
  for (const replacement of [null, "NEW_KEY"] as const) {
    test(`Linear failed publication restores exact old bytes (${initial}, ${replacement})`, async () => {
      await fixture(async env => {
        const first = await readLinearCredentialStore(env);
        if (initial) { first.set(initial); await withLinearCredentialSave(first, async () => {}); }
        const before = await readFile(first.path).catch(() => null);
        const edit = await readLinearCredentialStore(env); edit.set(replacement);
        await expect(withLinearCredentialSave(edit, async () => { throw new Error("config publication failed"); })).rejects.toThrow("config publication failed");
        expect(await readFile(first.path).catch(() => null)).toEqual(before);
      });
    });
  }
}

test("Linear cancellation, locks and concurrent edits preserve existing credentials", async () => {
  await fixture(async env => {
    const first = await readLinearCredentialStore(env); first.set("OLD"); await withLinearCredentialSave(first, async () => {});
    const stale = await readLinearCredentialStore(env); stale.set("STALE");
    const edit = await readLinearCredentialStore(env); edit.set("CURRENT"); await withLinearCredentialSave(edit, async () => {});
    await expect(withLinearCredentialSave(stale, async () => {})).rejects.toThrow("changed during setup");
    const controller = new AbortController(); controller.abort();
    await expect(withLinearCredentialSave(stale, async () => {}, controller.signal)).rejects.toThrow(/cancel/iu);
    const lock = join(dirname(first.path), ".linear.lock"); await writeFile(lock, "OTHER_LOCK");
    await expect(withLinearCredentialSave(stale, async () => {})).rejects.toThrow("locked");
    expect(await readFile(lock, "utf8")).toBe("OTHER_LOCK");
    expect(await loadSavedLinearKey(env)).toBe("CURRENT");
  });
});

for (const kind of ["schema", "version", "blank", "permissions", "symlink", "hardlink", "directory-link"] as const) {
  test(`Linear rejects unsafe or malformed storage: ${kind}`, async () => {
    await fixture(async (env, root) => {
      const store = await readLinearCredentialStore(env); store.set("KEY"); await withLinearCredentialSave(store, async () => {});
      if (kind === "schema") await writeFile(store.path, JSON.stringify({ version: 1, token: "KEY", extra: "PRIVATE" }));
      if (kind === "version") await writeFile(store.path, JSON.stringify({ version: 99, token: "KEY" }));
      if (kind === "blank") await writeFile(store.path, JSON.stringify({ version: 1, token: " " }));
      if (kind === "permissions") await chmod(store.path, 0o644);
      if (kind === "symlink") { await rm(store.path); await writeFile(join(root, "other"), "PRIVATE"); await symlink(join(root, "other"), store.path); }
      if (kind === "hardlink") await link(store.path, join(root, "other"));
      if (kind === "directory-link") { await rm(dirname(store.path), { recursive: true }); await mkdir(join(root, "other"), { mode: 0o700 }); await symlink(join(root, "other"), dirname(store.path)); }
      await expect(readLinearCredentialStore(env)).rejects.toThrow(/Linear/u);
    });
  });
}

test("Linear uses HOME for relative XDG and refuses credential paths inside Git including ancestor links", async () => {
  await fixture(async env => {
    const store = await readLinearCredentialStore({ ...env, XDG_CONFIG_HOME: "relative" });
    expect(store.path).toBe(join(env.HOME!, ".config/timber/credentials/linear.json"));
  });
  await withRepository(async (primary, root) => {
    await expect(readLinearCredentialStore({ XDG_CONFIG_HOME: primary })).rejects.toThrow("outside all Git");
    await git(primary, "status", "--porcelain");
    const shortcut = join(root, "linked"); await symlink(primary, shortcut);
    await expect(readLinearCredentialStore({ XDG_CONFIG_HOME: join(shortcut, "config") })).rejects.toThrow("outside all Git");
  });
});

test("Linear rollback preserves concurrent changes and reports incomplete restoration safely", async () => {
  await fixture(async env => {
    const store = await readLinearCredentialStore(env); store.set("DRAFT");
    await expect(withLinearCredentialSave(store, async () => {
      await writeFile(store.path, JSON.stringify({ version: 1, token: "CONCURRENT" }));
      throw new Error("do not overwrite");
    })).rejects.toThrow("rollback was incomplete");
    expect(await loadSavedLinearKey(env)).toBe("CONCURRENT");
  });
});
