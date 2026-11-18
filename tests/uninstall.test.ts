import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUninstallHandler, type UninstallDependencies } from "../src/commands/uninstall";
import type { CommandContext } from "../src/services";
import { git } from "./helpers/git";

interface Home {
  root: string; bin: string; exe: string; env: NodeJS.ProcessEnv;
  config: string; credentials: string; linear: string; marker: string; cache: string;
}

async function withHome(run: (home: Home) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "timber uninstall ")));
  try {
    const bin = join(root, "bin");
    const exe = join(bin, "timber");
    const configHome = join(root, "xdg-config");
    const stateHome = join(root, "xdg-state");
    const cacheHome = join(root, "xdg-cache");
    await mkdir(bin);
    await mkdir(join(configHome, "timber/credentials"), { recursive: true, mode: 0o700 });
    await mkdir(join(stateHome, "timber"), { recursive: true });
    await mkdir(join(cacheHome, "timber"), { recursive: true });
    await writeFile(exe, "#!/bin/sh\n", { mode: 0o755 });
    const config = join(configHome, "timber/config.toml");
    const credentials = join(configHome, "timber/credentials/jira.json");
    const linear = join(configHome, "timber/credentials/linear.json");
    const marker = join(stateHome, "timber/setup-hint-shown");
    const cache = join(cacheHome, "timber/update-check.json");
    await writeFile(config, "x = 1\n");
    await writeFile(credentials, "{\"token\":\"super-secret-token\"}\n", { mode: 0o600 });
    await writeFile(linear, "{\"version\":1,\"token\":\"linear-secret-key\"}\n", { mode: 0o600 });
    await writeFile(marker, "1\n");
    await writeFile(cache, "{\"checkedAt\":0}\n");
    await run({ root, bin, exe, config, credentials, linear, marker, cache,
      env: { HOME: root, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, XDG_CACHE_HOME: cacheHome, PATH: join(root, "empty") } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function present(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

type Choice = "remove" | "cancel";
function harness(home: Home, overrides: Partial<UninstallDependencies> = {}, choice?: Choice) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const context: CommandContext = {
    cwd: home.root,
    io: { stdout: text => { out.push(text); }, stderr: text => { err.push(text); } },
    ...(choice === undefined ? {} : { choose: async (message: string) => { prompts.push(message); return choice; } }),
  };
  const handler = createUninstallHandler({ executablePath: home.exe, standalone: true, env: home.env, platform: "linux",
    uid: process.getuid!(), ...overrides });
  return { out, err, prompts, run: (options: { yes?: boolean; removeSettings?: boolean }) => handler(options, context) };
}

test("confirming removes only the executable and keeps settings", async () => {
  await withHome(async home => {
    const h = harness(home, {}, "remove");
    expect(await h.run({})).toBe(0);
    expect(await present(home.exe)).toBe(false);
    for (const path of [home.config, home.credentials, home.linear, home.marker, home.cache]) expect(await present(path)).toBe(true);
    const text = h.out.join("");
    expect(text).toContain("will remove");
    expect(text).toContain(home.exe);
    expect(text).toContain("will keep");
    expect(text).toContain(home.credentials);
    expect(text).toContain(home.linear);
    expect(text).not.toContain("not a Timber file");
    expect(text).toContain("never touched");
    expect(text).toContain(".bashrc");
    expect(text).not.toContain("super-secret-token");
    expect(h.prompts.length).toBe(1);
  });
});

test("declining removes nothing", async () => {
  await withHome(async home => {
    const h = harness(home, {}, "cancel");
    expect(await h.run({ removeSettings: true })).toBe(0);
    expect(h.out.join("")).toContain("Cancelled");
    for (const path of [home.exe, home.config, home.credentials, home.marker]) expect(await present(path)).toBe(true);
  });
});

test("noninteractive without --yes refuses and removes nothing", async () => {
  await withHome(async home => {
    const h = harness(home);
    await expect(h.run({ removeSettings: true })).rejects.toThrow(/--yes/u);
    for (const path of [home.exe, home.config, home.credentials, home.marker]) expect(await present(path)).toBe(true);
  });
});

test("--yes removes without prompting", async () => {
  await withHome(async home => {
    const h = harness(home, {}, "cancel");
    expect(await h.run({ yes: true })).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(await present(home.exe)).toBe(false);
    expect(await present(home.config)).toBe(true);
  });
});

test("--remove-settings removes known files and empty directories but keeps unknown files", async () => {
  await withHome(async home => {
    const unknown = join(home.config, "..", "notes.txt");
    await writeFile(unknown, "mine\n");
    const h = harness(home);
    expect(await h.run({ yes: true, removeSettings: true })).toBe(0);
    for (const path of [home.exe, home.config, home.credentials, home.linear, home.marker, home.cache]) expect(await present(path)).toBe(false);
    expect(await present(join(home.credentials, ".."))).toBe(false);
    expect(await present(join(home.cache, ".."))).toBe(false);
    expect(await readFile(unknown, "utf8")).toBe("mine\n");
    expect(await present(join(home.config, ".."))).toBe(true);
    expect(await present(join(home.marker, ".."))).toBe(false);
    expect(h.out.join("")).toContain(unknown);
    expect(h.out.join("")).not.toContain(home.linear + " (not a Timber file");
    expect(h.out.join("")).not.toContain("super-secret-token");
    expect(h.out.join("")).not.toContain("linear-secret-key");
  });
});

test("a symlinked target is refused and nothing is removed", async () => {
  await withHome(async home => {
    const real = join(home.root, "real-config.toml");
    await writeFile(real, "keep\n");
    await rm(home.config);
    await symlink(real, home.config);
    await expect(harness(home).run({ yes: true, removeSettings: true })).rejects.toThrow(/symlink/u);
    expect(await present(home.exe)).toBe(true);
    expect(await present(home.credentials)).toBe(true);
    expect(await readFile(real, "utf8")).toBe("keep\n");
  });
});

test("a symlinked executable is refused", async () => {
  await withHome(async home => {
    const link = join(home.bin, "timber-link");
    await symlink(home.exe, link);
    await expect(harness(home, { executablePath: link }).run({ yes: true })).rejects.toThrow(/symlink/u);
    expect(await present(home.exe)).toBe(true);
  });
});

test("a target owned by another user is refused", async () => {
  await withHome(async home => {
    await expect(harness(home, { uid: process.getuid!() + 1 }).run({ yes: true })).rejects.toThrow(/not owned/u);
    expect(await present(home.exe)).toBe(true);
  });
});

test("a Bun source run is refused", async () => {
  await withHome(async home => {
    await expect(harness(home, { standalone: false }).run({ yes: true })).rejects.toThrow(/CONTRIBUTING\.md/u);
    await expect(harness(home, { executablePath: join(home.bin, "bun") }).run({ yes: true })).rejects.toThrow(/CONTRIBUTING\.md/u);
    expect(await present(home.exe)).toBe(true);
  });
});

test("Windows is refused with a pointer to the manual steps", async () => {
  await withHome(async home => {
    await expect(harness(home, { platform: "win32" }).run({ yes: true })).rejects.toThrow(/docs\/windows\.md/u);
    expect(await present(home.exe)).toBe(true);
  });
});

test("targets inside a real Git repository are refused and the repository is untouched", async () => {
  await withHome(async home => {
    const repo = join(home.root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "trunk");
    await writeFile(join(repo, ".timber.toml"), "base_branch = \"trunk\"\n");
    const common = join(repo, ".git/timber");
    await mkdir(join(common, "backups"), { recursive: true });
    await writeFile(join(common, "backups/data"), "backup bytes\n");
    await writeFile(join(common, "timber-setup.lock"), "lock\n");
    const before = await snapshot(repo);
    // Executable inside the worktree.
    const inside = join(repo, "timber");
    await writeFile(inside, "#!/bin/sh\n", { mode: 0o755 });
    await expect(harness(home, { executablePath: inside }).run({ yes: true })).rejects.toThrow(/inside a Git directory/u);
    // Settings inside the Git directory.
    const env = { ...home.env, XDG_CONFIG_HOME: join(common, "cfg") };
    await mkdir(join(common, "cfg/timber"), { recursive: true });
    await writeFile(join(common, "cfg/timber/config.toml"), "x\n");
    const trapped = await snapshot(repo);
    await expect(harness(home, { env }).run({ yes: true, removeSettings: true })).rejects.toThrow(/inside a Git directory/u);
    expect(await snapshot(repo)).toEqual(trapped);
    expect(await present(home.exe)).toBe(true);
    await rm(join(common, "cfg"), { recursive: true });
    await rm(inside);
    expect(await snapshot(repo)).toEqual(before);
  });
});

test("a successful uninstall leaves repository files byte-identical", async () => {
  await withHome(async home => {
    const repo = join(home.root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "trunk");
    await writeFile(join(repo, ".timber.toml"), "base_branch = \"trunk\"\n");
    await mkdir(join(repo, ".git/timber/backups"), { recursive: true });
    await writeFile(join(repo, ".git/timber/backups/data"), "backup bytes\n");
    const before = await snapshot(repo);
    const refs = await git(repo, "for-each-ref");
    const h = harness(home, { }, "remove");
    expect(await h.run({ removeSettings: true })).toBe(0);
    expect(await snapshot(repo)).toEqual(before);
    expect(await git(repo, "for-each-ref")).toBe(refs);
  });
});

test("warns when another timber remains on PATH", async () => {
  await withHome(async home => {
    const other = join(home.root, "other");
    await mkdir(other);
    await writeFile(join(other, "timber"), "#!/bin/sh\n");
    await chmod(join(other, "timber"), 0o755);
    const h = harness(home, { env: { ...home.env, PATH: other } });
    expect(await h.run({ yes: true })).toBe(0);
    expect(h.err.join("")).toContain(join(other, "timber"));
  });
});

async function snapshot(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (prefix === "" && entry.name === ".git") {
      // Content of Timber metadata only; Git's own bookkeeping is out of scope.
      Object.assign(result, await snapshot(join(directory, ".git/timber"), ".git/timber/").catch(() => ({})));
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(path, prefix + entry.name + "/"));
    else result[prefix + entry.name] = await readFile(path, "utf8");
  }
  return result;
}
