import { expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { inspectSetupTarget, saveSetupConfig } from "../src/setup/storage";
import { renderConfig } from "../src/setup/render";
import { createSetupPrompt } from "../src/setup/terminal";
import { git, withRepository } from "./helpers/git";

const env = (directory: string) => ({ HOME: directory, XDG_CONFIG_HOME: join(directory, "config") });

for (const place of ["primary", "nested", "linked"]) {
  test(`local setup from ${place} writes primary config and common exclusion with unchanged Git status`, async () => {
    await withRepository(async (primary, directory) => {
      let cwd = primary;
      if (place === "nested") { cwd = join(primary, "nested"); await mkdir(cwd); }
      if (place === "linked") { cwd = join(directory, "linked"); await git(primary, "worktree", "add", "-b", "feature", cwd); }
      const before = await git(primary, "status", "--porcelain=v1");
      const refs = await git(primary, "show-ref");
      const target = await inspectSetupTarget(false, cwd, env(directory));
      expect(target.path).toBe(join(primary, ".timber.toml"));
      expect(target.branches).toContain("trunk");
      await saveSetupConfig(target, renderConfig({ editor: false, remote: "upstream" }), false);
      expect(await git(primary, "status", "--porcelain=v1")).toBe(before);
      expect(await git(primary, "show-ref")).toBe(refs);
      expect(await readFile(target.exclude!.path, "utf8")).toContain("/.timber.toml\n");
      const again = await inspectSetupTarget(false, cwd, env(directory));
      expect(again.file.values.editor).toBe(false);
      await saveSetupConfig(again, renderConfig(again.file.values), false);
      expect((await readFile(target.exclude!.path, "utf8")).split("/.timber.toml")).toHaveLength(2);
      expect(await readFile(join(primary, ".gitignore"), "utf8")).toBe(".env\n");
    });
  });
}

test("global setup works outside repositories and never writes repository exclusion", async () => {
  await withRepository(async (primary, directory) => {
    const target = await inspectSetupTarget(true, directory, env(directory));
    expect(target.repository).toBeNull();
    expect(target.exclude).toBeNull();
    await saveSetupConfig(target, renderConfig({ agent: { command: "codex", args: [], enabled: false } }), false);
    expect(await readFile(join(directory, "config/timber/config.toml"), "utf8")).toContain('command = "codex"');
    expect(await git(primary, "status", "--porcelain=v1")).toBe("");
  });
});

test("tracked settings need explicit editing authorization and index bytes remain intact", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(primary, ".timber.toml");
    await writeFile(path, 'remote = "origin"\n');
    await git(primary, "add", ".timber.toml");
    const indexPath = join(primary, ".git/index");
    const before = await readFile(indexPath);
    const target = await inspectSetupTarget(false, primary, env(directory));
    expect(target.tracked).toBe(true);
    await expect(saveSetupConfig(target, renderConfig({ remote: "upstream" }), false)).rejects.toThrow("tracked");
    expect(await readFile(path, "utf8")).toBe('remote = "origin"\n');
    expect(await readFile(indexPath)).toEqual(before);
    await saveSetupConfig(target, renderConfig({ remote: "upstream" }), true);
    expect(await readFile(indexPath)).toEqual(before);
    expect(await git(primary, "ls-files", "--", ".timber.toml")).toBe(".timber.toml");
  });
});

test("invalid existing TOML is reported and preserved before writing exclusion", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(primary, ".timber.toml");
    await writeFile(path, "invalid [ toml");
    const exclude = await readFile(join(primary, ".git/info/exclude"));
    await expect(inspectSetupTarget(false, primary, env(directory))).rejects.toThrow("Invalid TOML");
    expect(await readFile(path, "utf8")).toBe("invalid [ toml");
    expect(await readFile(join(primary, ".git/info/exclude"))).toEqual(exclude);
  });
});

test("failed config publication restores original exclusion bytes including non-UTF8 entries", async () => {
  await withRepository(async (primary, directory) => {
    const exclude = join(primary, ".git/info/exclude");
    const original = Buffer.from([35, 32, 255, 10]);
    await writeFile(exclude, original);
    const target = await inspectSetupTarget(false, primary, env(directory));
    await expect(saveSetupConfig(target, renderConfig({}), false, undefined, {
      link: async () => { throw new Error("injected write failure"); },
    })).rejects.toThrow("save");
    expect(await readFile(exclude)).toEqual(original);
    expect(await readdir(primary)).not.toContain(".timber.toml");
    expect(await git(primary, "status", "--porcelain=v1")).toBe("");
  });
});

for (const rule of ["project", "local"]) {
  test(`${rule} ignore negation prevents unsafe visibility without rewriting project files`, async () => {
    await withRepository(async (primary, directory) => {
      const exclude = join(primary, ".git/info/exclude");
      if (rule === "project") await writeFile(join(primary, ".gitignore"), ".env\n!.timber.toml\n");
      else await writeFile(exclude, "/.timber.toml\n!/.timber.toml\n");
      const before = await readFile(exclude);
      const status = await git(primary, "status", "--porcelain=v1");
      const target = await inspectSetupTarget(false, primary, env(directory));
      await expect(saveSetupConfig(target, renderConfig({}), false)).rejects.toThrow("global");
      expect(await readFile(exclude)).toEqual(before);
      expect(await git(primary, "status", "--porcelain=v1")).toBe(status);
      expect(await readdir(primary)).not.toContain(".timber.toml");
    });
  });
}

test("a destination changed since the questionnaire is preserved", async () => {
  await withRepository(async (primary, directory) => {
    const target = await inspectSetupTarget(false, primary, env(directory));
    await writeFile(target.path, 'remote = "concurrent"\n');
    await expect(saveSetupConfig(target, renderConfig({}), false)).rejects.toThrow("changed");
    expect(await readFile(target.path, "utf8")).toBe('remote = "concurrent"\n');
  });
});

test("no-clobber publication preserves a config created after the final recheck", async () => {
  await withRepository(async (primary, directory) => {
    const target = await inspectSetupTarget(false, primary, env(directory));
    const before = await readFile(target.exclude!.path);
    await expect(saveSetupConfig(target, renderConfig({}), false, undefined, {
      link: async (from, to) => {
        await writeFile(to, 'remote = "arrived"\n');
        return link(from, to);
      },
    })).rejects.toThrow("save");
    expect(await readFile(target.path, "utf8")).toBe('remote = "arrived"\n');
    expect(await readFile(target.exclude!.path)).toEqual(before);
  });
});

test("symlink settings are refused without altering their target", async () => {
  await withRepository(async (primary, directory) => {
    const elsewhere = join(directory, "keep.toml");
    await writeFile(elsewhere, 'remote = "keep"\n');
    await symlink(elsewhere, join(primary, ".timber.toml"));
    await expect(inspectSetupTarget(false, primary, env(directory))).rejects.toThrow("symlink");
    expect(await readFile(elsewhere, "utf8")).toBe('remote = "keep"\n');
  });
});

test("an interrupt before publication restores exclusion; after publication retains saved settings", async () => {
  await withRepository(async (primary, directory) => {
    const target = await inspectSetupTarget(false, primary, env(directory));
    const controller = new AbortController();
    const before = await readFile(target.exclude!.path);
    controller.abort();
    await expect(saveSetupConfig(target, renderConfig({}), false, controller.signal)).rejects.toThrow("cancel");
    expect(await readFile(target.exclude!.path)).toEqual(before);
    const after = new AbortController();
    await saveSetupConfig(target, renderConfig({ remote: "saved" }), false, after.signal, {
      link: async (from, to) => { await link(from, to); after.abort(); },
    });
    expect(await readFile(target.path, "utf8")).toContain('remote = "saved"');
  });
});

test("EOF after save confirmation but before config publication cancels and rolls back exclusion", async () => {
  await withRepository(async (primary, directory) => {
    const target = await inspectSetupTarget(false, primary, env(directory));
    const original = await readFile(target.exclude!.path);
    const input = new PassThrough();
    const prompt = createSetupPrompt(input, new PassThrough());
    try {
      input.write("y\n");
      expect(await prompt.confirm("Save?", false)).toBe(true);
      await expect(saveSetupConfig(target, renderConfig({}), false, prompt.signal, {
        rename: async (from, to) => { await rename(from, to); input.end(); await Bun.sleep(20); },
      })).rejects.toThrow("cancel");
      expect(await readFile(target.exclude!.path)).toEqual(original);
      expect(await readdir(primary)).not.toContain(".timber.toml");
      expect(await git(primary, "status", "--porcelain=v1")).toBe("");
    } finally { prompt.close(); }
  });
});

test("failed save preserves concurrent exclusion edits and reports incomplete rollback", async () => {
  await withRepository(async (primary, directory) => {
    const target = await inspectSetupTarget(false, primary, env(directory));
    await expect(saveSetupConfig(target, renderConfig({}), false, undefined, {
      link: async () => { await writeFile(target.exclude!.path, "# concurrent edit\n"); throw new Error("write failed"); },
    })).rejects.toThrow("rollback was incomplete");
    expect(await readFile(target.exclude!.path, "utf8")).toBe("# concurrent edit\n");
    expect(await readdir(primary)).not.toContain(".timber.toml");
  });
});

test("a cooperating writer lock prevents a second setup without altering files", async () => {
  await withRepository(async (primary, directory) => {
    const target = await inspectSetupTarget(false, primary, env(directory));
    const before = await readFile(target.exclude!.path);
    await writeFile(join(primary, ".git/timber-setup.lock"), "another setup\n");
    await expect(saveSetupConfig(target, renderConfig({}), false)).rejects.toThrow("locked");
    expect(await readFile(join(primary, ".git/timber-setup.lock"), "utf8")).toBe("another setup\n");
    expect(await readFile(target.exclude!.path)).toEqual(before);
    expect(await readdir(primary)).not.toContain(".timber.toml");
  });
});

test("failed save preserves a concurrent exclusion permission edit during rollback", async () => {
  await withRepository(async (primary, directory) => {
    const target = await inspectSetupTarget(false, primary, env(directory));
    await expect(saveSetupConfig(target, renderConfig({}), false, undefined, {
      link: async () => { await chmod(target.exclude!.path, 0o640); throw new Error("write failed"); },
    })).rejects.toThrow("rollback was incomplete");
    expect((await lstat(target.exclude!.path)).mode & 0o777).toBe(0o640);
    expect(await readFile(target.exclude!.path, "utf8")).toContain("/.timber.toml");
    expect(await readdir(primary)).not.toContain(".timber.toml");
  });
});

test("a save-stage operation interrupted by Ctrl-C reports cancellation after safe rollback", async () => {
  await withRepository(async (primary, directory) => {
    const target = await inspectSetupTarget(false, primary, env(directory));
    const before = await readFile(target.exclude!.path);
    const controller = new AbortController();
    await expect(saveSetupConfig(target, renderConfig({}), false, controller.signal, {
      link: async () => { controller.abort(); throw new Error("interrupted operation"); },
    })).rejects.toThrow("cancel");
    expect(await readFile(target.exclude!.path)).toEqual(before);
    expect(await readdir(primary)).not.toContain(".timber.toml");
    expect(await git(primary, "status", "--porcelain=v1")).toBe("");
  });
});
