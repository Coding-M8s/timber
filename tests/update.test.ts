import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { placeholderHandlers, runCli } from "../src/cli";
import { updateCheckCachePath } from "../src/config-paths";
import { checkInterval, readUpdateCache, writeUpdateCache } from "../src/update/cache";
import { refreshUpdateCache, resolveLatestTag, type FetchLike } from "../src/update/latest";
import { notifyUpdate, skipsUpdateCheck, type NoticeDeps } from "../src/update/notice";
import { compareVersions, isNewerStable, isReleaseTag } from "../src/update/tag";
import { createUpdateCheckHandler, createUpdateHandler, type UpdateDeps } from "../src/commands/update";
import { realUpdateDeps, spawnCheck } from "../src/update/runtime";

const posix = process.platform !== "win32";
const day = checkInterval;
let root: string;
let cachePath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "timber-update-test-"));
  cachePath = join(root, "cache/timber/update-check.json");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("tags", () => {
  test("grammar, ordering and stable-only notices", () => {
    expect(isReleaseTag("v0.1.4")).toBe(true);
    expect(isReleaseTag("v0.1.4-rc.1")).toBe(true);
    for (const bad of ["0.1.4", "v01.1.4", "v1.2", "v1.2.3-beta", "v1.2.3 ", "v1.2.3-rc.01", ""]) expect(isReleaseTag(bad)).toBe(false);
    expect(compareVersions("v0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0-rc.2", "v1.0.0")).toBeLessThan(0);
    expect(compareVersions("v1.0.0-rc.2", "v1.0.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("junk", "1.0.0")).toBeNull();
    expect(isNewerStable("v0.1.4", "0.1.2")).toBe(true);
    expect(isNewerStable("v0.1.2", "0.1.2")).toBe(false);
    expect(isNewerStable("v0.1.1", "0.1.2")).toBe(false);
    expect(isNewerStable("v9.0.0-rc.1", "0.1.2")).toBe(false);
  });
});

describe("cache", () => {
  test("cache path honors XDG_CACHE_HOME only when absolute", () => {
    expect(updateCheckCachePath({ XDG_CACHE_HOME: "/x/cache", HOME: "/h" })).toBe("/x/cache/timber/update-check.json");
    expect(updateCheckCachePath({ XDG_CACHE_HOME: "relative", HOME: "/h" })).toBe("/h/.cache/timber/update-check.json");
    expect(updateCheckCachePath({ HOME: "/h" })).toBe("/h/.cache/timber/update-check.json");
  });

  test("atomic private write round trips and leaves no temp file", async () => {
    expect(await writeUpdateCache(cachePath, { tag: "v0.1.4", checkedAt: 5 })).toBe(true);
    expect(await readUpdateCache(cachePath)).toEqual({ tag: "v0.1.4", checkedAt: 5 });
    if (posix) {
      expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(cachePath))).mode & 0o777).toBe(0o700);
    }
    expect((await Array.fromAsync(new Bun.Glob("*").scan(dirname(cachePath)))).sort()).toEqual(["update-check.json"]);
  });

  test("corrupt, wrong-shape and missing files read as missing; rc tags are dropped", async () => {
    await mkdir(dirname(cachePath), { recursive: true });
    expect(await readUpdateCache(cachePath)).toBeNull();
    for (const text of ["{not json", "[]", "null", '{"checkedAt":"yesterday"}', ""]) {
      await writeFile(cachePath, text);
      expect(await readUpdateCache(cachePath)).toBeNull();
    }
    await writeFile(cachePath, JSON.stringify({ tag: "v9.0.0-rc.1", checkedAt: 7 }));
    expect(await readUpdateCache(cachePath)).toEqual({ checkedAt: 7 });
  });

  test("an unwritable location reports failure without throwing", async () => {
    await writeFile(join(root, "blocker"), "x");
    expect(await writeUpdateCache(join(root, "blocker/timber/update-check.json"), { checkedAt: 1 })).toBe(false);
  });
});

function redirect(location: string | null, status = 302) {
  const requests: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetchDouble: FetchLike = async (url, init) => {
    requests.push({ url, init });
    return { status, headers: { get: name => name.toLowerCase() === "location" ? location : null } };
  };
  return { requests, fetchDouble };
}

describe("latest release lookup", () => {
  test("sends one plain GET with nothing identifying and reads the redirect tag", async () => {
    const { requests, fetchDouble } = redirect("https://github.com/Coding-M8s/timber/releases/tag/v0.1.4");
    expect(await resolveLatestTag({}, fetchDouble)).toBe("v0.1.4");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://github.com/Coding-M8s/timber/releases/latest");
    expect(requests[0]!.init.method).toBe("GET");
    expect(requests[0]!.init.redirect).toBe("manual");
    expect(requests[0]!.init.headers).toEqual({ "User-Agent": "timber" });
    expect(requests[0]!.url).not.toContain("?");
  });

  test("honors TIMBER_RELEASES_URL and refuses non-https without a request", async () => {
    const ok = redirect("/fixture/releases/tag/v2.0.0");
    expect(await resolveLatestTag({ TIMBER_RELEASES_URL: "https://fixture.test/fixture/releases/" }, ok.fetchDouble)).toBe("v2.0.0");
    expect(ok.requests[0]!.url).toBe("https://fixture.test/fixture/releases/latest");
    const insecure = redirect("/x/tag/v2.0.0");
    expect(await resolveLatestTag({ TIMBER_RELEASES_URL: "http://fixture.test/r" }, insecure.fetchDouble)).toBeNull();
    expect(insecure.requests).toHaveLength(0);
  });

  test("bad redirects, non-redirects and thrown errors are null", async () => {
    expect(await resolveLatestTag({}, redirect("https://x/releases/tag/nightly").fetchDouble)).toBeNull();
    expect(await resolveLatestTag({}, redirect(null).fetchDouble)).toBeNull();
    expect(await resolveLatestTag({}, redirect("https://x/tag/v1.0.0", 200).fetchDouble)).toBeNull();
    expect(await resolveLatestTag({}, async () => { throw new Error("offline"); })).toBeNull();
  });

  test("a failed refresh records the time and keeps the cached tag; success replaces it", async () => {
    await writeUpdateCache(cachePath, { tag: "v0.1.3", checkedAt: 1 });
    const failing: FetchLike = async () => { throw new Error("offline"); };
    expect(await refreshUpdateCache({ env: {}, cachePath, now: () => 99, fetch: failing })).toBeNull();
    expect(await readUpdateCache(cachePath)).toEqual({ tag: "v0.1.3", checkedAt: 99 });
    const rc = redirect("https://x/releases/tag/v0.2.0-rc.1");
    expect(await refreshUpdateCache({ env: {}, cachePath, now: () => 100, fetch: rc.fetchDouble })).toBeNull();
    expect(await readUpdateCache(cachePath)).toEqual({ tag: "v0.1.3", checkedAt: 100 });
    const good = redirect("https://x/releases/tag/v0.1.4");
    expect(await refreshUpdateCache({ env: {}, cachePath, now: () => 200, fetch: good.fetchDouble })).toBe("v0.1.4");
    expect(await readUpdateCache(cachePath)).toEqual({ tag: "v0.1.4", checkedAt: 200 });
  });

  test("a failed first check still records the time", async () => {
    await refreshUpdateCache({ env: {}, cachePath, now: () => 5, fetch: async () => { throw new Error("offline"); } });
    expect(await readUpdateCache(cachePath)).toEqual({ checkedAt: 5 });
  });

  test("the hidden check handler is silent and exits 0 even when the check throws", async () => {
    expect(await createUpdateCheckHandler({ refresh: async () => { throw new Error("boom"); } })({ cwd: "/", io: { stdout() {}, stderr() {} } })).toBe(0);
  });
});

function notice(overrides: Partial<NoticeDeps> = {}) {
  const state = { stderr: "", spawns: 0 };
  const deps: NoticeDeps = {
    argv: ["ls"], env: {}, version: "0.1.2", stderrIsTTY: true, standalone: true, platform: "linux", cachePath,
    now: () => 1_000_000_000, configDisabled: async () => false,
    spawnCheck: () => { state.spawns++; }, stderr: text => { state.stderr += text; }, ...overrides,
  };
  return { state, run: () => notifyUpdate(deps) };
}

describe("notice", () => {
  test("a newer cached stable tag prints exactly two lines to stderr", async () => {
    await writeUpdateCache(cachePath, { tag: "v0.1.4", checkedAt: 1_000_000_000 - 1000 });
    const { state, run } = notice();
    await run();
    expect(state.stderr).toBe("Update available: timber 0.1.2 -> 0.1.4\nRun: timber update\n");
    expect(state.spawns).toBe(0);
  });

  test("a fresh cache spawns nothing, including when no update exists", async () => {
    await writeUpdateCache(cachePath, { tag: "v0.1.2", checkedAt: 1_000_000_000 - day + 1 });
    const { state, run } = notice();
    await run();
    expect(state).toEqual({ stderr: "", spawns: 0 });
  });

  test("a stale or missing cache spawns once and the parent does not wait for it", async () => {
    for (const seed of [null, { tag: "v0.1.2", checkedAt: 1_000_000_000 - day - 1 }]) {
      await rm(cachePath, { force: true });
      if (seed) await writeUpdateCache(cachePath, seed);
      let finish!: () => void;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      let spawned = 0;
      const { run } = notice({ spawnCheck: () => { spawned++; void pending; } });
      await run();
      expect(spawned).toBe(1);
      finish();
    }
  });

  test("starting a check records the attempt first, so a second command starts no second check", async () => {
    await writeUpdateCache(cachePath, { tag: "v0.1.3", checkedAt: 1_000_000_000 - day - 1 });
    const first = notice();
    await first.run();
    expect(first.state.spawns).toBe(1);
    expect(await readUpdateCache(cachePath)).toEqual({ tag: "v0.1.3", checkedAt: 1_000_000_000 });
    const second = notice({ now: () => 1_000_000_000 + 5 });
    await second.run();
    expect(second.state.spawns).toBe(0);
  });

  test("an unwritable cache starts no check", async () => {
    await writeFile(join(root, "blocker"), "x");
    const { state, run } = notice({ cachePath: join(root, "blocker/timber/update-check.json") });
    await run();
    expect(state).toEqual({ stderr: "", spawns: 0 });
  });

  test("the detached check runs from the temp directory and is not waited on", () => {
    const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    let unrefs = 0;
    const fakeSpawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return { on() { return this; }, unref() { unrefs++; } };
    }) as unknown as Parameters<typeof spawnCheck>[0];
    spawnCheck(fakeSpawn);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(process.execPath);
    expect(calls[0]!.args).toEqual(["__update-check"]);
    expect(calls[0]!.options).toMatchObject({ cwd: tmpdir(), detached: true, stdio: "ignore" });
    expect(unrefs).toBe(1);
  });

  test("a failed check recorded now suppresses another spawn until the interval passes", async () => {
    await refreshUpdateCache({ env: {}, cachePath, now: () => 1_000_000_000, fetch: async () => { throw new Error("offline"); } });
    const soon = notice({ now: () => 1_000_000_000 + day - 1 });
    await soon.run();
    expect(soon.state.spawns).toBe(0);
    const later = notice({ now: () => 1_000_000_000 + day + 1 });
    await later.run();
    expect(later.state.spawns).toBe(1);
  });

  test("a corrupt cache is treated as missing: no error, no notice, one spawn", async () => {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, "{{{");
    const { state, run } = notice();
    await run();
    expect(state).toEqual({ stderr: "", spawns: 1 });
  });

  test("release candidates, older and equal tags never notify", async () => {
    for (const tag of ["v9.9.9-rc.1", "v0.1.2", "v0.1.1"]) {
      await writeUpdateCache(cachePath, { tag, checkedAt: 1_000_000_000 });
      const { state, run } = notice();
      await run();
      expect(state.stderr).toBe("");
    }
  });

  test("a throwing dependency never escapes", async () => {
    const { run } = notice({ configDisabled: async () => { throw new Error("boom"); } });
    await run();
  });

  const skips: Array<[string, Partial<NoticeDeps>]> = [
    ["stderr is not a terminal", { stderrIsTTY: false }],
    ["CI is set", { env: { CI: "true" } }],
    ["source run", { standalone: false }],
    ["Windows", { platform: "win32" }],
    ["TIMBER_NO_UPDATE_CHECK=1", { env: { TIMBER_NO_UPDATE_CHECK: "1" } }],
    ["update_check = false", { configDisabled: async () => true }],
    ["hidden command", { argv: ["__ide-done", "x"] }],
    ["--json", { argv: ["ls", "--json"] }],
    ["--result-file", { argv: ["new", "x", "--result-file", "/tmp/r"] }],
    ["--result-file=", { argv: ["open", "x", "--result-file=/tmp/r"] }],
    ["app-config", { argv: ["__app-config", "read"] }],
    ["completion", { argv: ["completion", "bash"] }],
    ["update command", { argv: ["update"] }],
  ];
  for (const [name, override] of skips) {
    test(`skips both notice and check: ${name}`, async () => {
      await writeUpdateCache(cachePath, { tag: "v9.0.0", checkedAt: 1 });
      const { state, run } = notice(override);
      await run();
      expect(state).toEqual({ stderr: "", spawns: 0 });
      await rm(cachePath, { force: true });
      await run();
      expect(state).toEqual({ stderr: "", spawns: 0 });
    });
  }

  test("TIMBER_NO_UPDATE_CHECK only disables on the value 1", async () => {
    const { state, run } = notice({ env: { TIMBER_NO_UPDATE_CHECK: "0" } });
    await run();
    expect(state.spawns).toBe(1);
  });

  test("argv classification", () => {
    expect(skipsUpdateCheck(["ls"])).toBe(false);
    expect(skipsUpdateCheck(["--help"])).toBe(true);
    expect(skipsUpdateCheck(["--version"])).toBe(true);
    expect(skipsUpdateCheck(["-V"])).toBe(true);
    expect(skipsUpdateCheck([])).toBe(true);
    expect(skipsUpdateCheck(["open", "--help"])).toBe(false);
    expect(skipsUpdateCheck(["__update-check"])).toBe(true);
    expect(skipsUpdateCheck(["uninstall", "--yes"])).toBe(true);
    expect(skipsUpdateCheck(["__complete", "--bash", "x"])).toBe(true);
  });
});

describe("cli surface", () => {
  test("update is public help and __update-check stays hidden", async () => {
    let out = "";
    await runCli(["--help"], { handlers: placeholderHandlers, context: { cwd: "/", io: { stdout: t => { out += t; }, stderr() {} } } });
    expect(out).toContain("update");
    expect(out).not.toContain("__update-check");
  });

  test("update --version reaches the handler with the tag, not the program version flag", async () => {
    const seen: unknown[] = [];
    const io = { stdout() {}, stderr() {} };
    const handlers = { ...placeholderHandlers, update: async (options: object) => { seen.push(options); return 0; } };
    expect(await runCli(["update", "--version", "v0.1.0"], { handlers, context: { cwd: "/", io } })).toBe(0);
    expect(await runCli(["update", "--check"], { handlers, context: { cwd: "/", io } })).toBe(0);
    expect(seen).toEqual([{ version: "v0.1.0" }, { check: true }]);
  });
});

// Command behavior, with the network and process seams replaced.
interface Harness { deps: UpdateDeps; out: string; err: string; downloads: string[]; installs: Array<{ file: string; env: NodeJS.ProcessEnv }>; refreshes: number; installDir: string; executable: string }

async function harness(overrides: Partial<UpdateDeps> & { latest?: string | null; installer?: string } = {}): Promise<Harness> {
  const installDir = join(root, "bin");
  await mkdir(installDir, { recursive: true });
  const executable = join(installDir, "timber");
  await writeFile(executable, "#!/bin/sh\necho 0.1.2\n", { mode: 0o755 });
  const state = { out: "", err: "", downloads: [] as string[], installs: [] as Array<{ file: string; env: NodeJS.ProcessEnv }>, refreshes: 0 };
  const { latest = "v0.1.4", installer = "#!/bin/sh\nexit 0\n", ...rest } = overrides;
  const deps: UpdateDeps = {
    env: { PATH: process.env.PATH ?? "" }, version: "0.1.2", platform: "linux", standalone: true, executablePath: executable,
    refresh: async () => { state.refreshes++; return latest; },
    releasesBase: () => "https://fixture.test/releases", isWritable: async () => true, hasCommand: async () => true,
    makeTempDir: () => mkdtemp(join(root, "dl-")), removeDir: directory => rm(directory, { recursive: true, force: true }),
    download: async (url, destination) => { state.downloads.push(url); await writeFile(destination, installer); },
    runInstaller: async (file, env) => {
      state.installs.push({ file, env });
      const result = await execa("sh", [file], { env, extendEnv: false, reject: false });
      state.out += result.stdout; state.err += result.stderr;
      return result.exitCode ?? 1;
    },
    reportVersion: async () => "0.1.4", ...rest,
  };
  const result = { deps, downloads: state.downloads, installs: state.installs, installDir, executable } as Harness;
  Object.defineProperties(result, { out: { get: () => state.out }, err: { get: () => state.err }, refreshes: { get: () => state.refreshes } });
  (result as unknown as { io: unknown }).io = { stdout: (t: string) => { state.out += t; }, stderr: (t: string) => { state.err += t; } };
  return result;
}

async function update(h: Harness, options: { check?: boolean; version?: string } = {}): Promise<number> {
  return createUpdateHandler(h.deps)(options, { cwd: "/", io: (h as unknown as { io: { stdout(t: string): void; stderr(t: string): void } }).io });
}
async function expectRefusal(h: Harness, pattern: RegExp, options: { check?: boolean; version?: string } = {}) {
  const before = await readFile(h.executable);
  await expect(update(h, options)).rejects.toThrow(pattern);
  expect(h.downloads).toEqual([]);
  expect(h.installs).toEqual([]);
  expect(h.refreshes).toBe(0);
  expect(Buffer.compare(before, await readFile(h.executable))).toBe(0);
}

describe.skipIf(!posix)("timber update", () => {
  test("downloads install.sh from the selected release and runs it with the install dir and tag", async () => {
    const h = await harness({ installer: '#!/bin/sh\nprintf "%s|%s" "$TIMBER_INSTALL_DIR" "$TIMBER_VERSION" > "$TIMBER_INSTALL_DIR/proof"\n' });
    expect(await update(h)).toBe(0);
    expect(h.downloads).toEqual(["https://fixture.test/releases/download/v0.1.4/install.sh"]);
    expect(h.installs).toHaveLength(1);
    expect(h.installs[0]!.env.TIMBER_INSTALL_DIR).toBe(h.installDir);
    expect(h.installs[0]!.env.TIMBER_VERSION).toBe("v0.1.4");
    expect(await readFile(join(h.installDir, "proof"), "utf8")).toBe(`${h.installDir}|v0.1.4`);
    expect(h.out).toContain("Timber is now version 0.1.4.");
    expect((await stat(dirname(h.installs[0]!.file)).catch(() => null))).toBeNull();
  });

  test("--version installs that exact tag without a latest lookup", async () => {
    const h = await harness();
    expect(await update(h, { version: "v0.1.3" })).toBe(0);
    expect(h.refreshes).toBe(0);
    expect(h.downloads).toEqual(["https://fixture.test/releases/download/v0.1.3/install.sh"]);
    expect(h.installs[0]!.env.TIMBER_VERSION).toBe("v0.1.3");
  });

  test("--check and --version together are rejected before anything runs", async () => {
    await expectRefusal(await harness(), /cannot be combined/u, { check: true, version: "v0.1.3" });
  });

  test("the real installer runner passes the exact environment and returns the exit code", async () => {
    const dir = await mkdtemp(join(root, "runner-"));
    const file = join(dir, "install.sh");
    await writeFile(file, '#!/bin/sh\n[ "$TIMBER_VERSION" = v0.1.4 ] && [ -z "${HOME:-}" ] || exit 9\nexit 3\n');
    expect(await realUpdateDeps().runInstaller(file, { PATH: process.env.PATH ?? "", TIMBER_VERSION: "v0.1.4" })).toBe(3);
  });

  test("--version rejects tags outside the installer grammar before anything runs", async () => {
    const h = await harness();
    for (const bad of ["0.1.3", "v1.2", "latest", "v1.0.0; rm -rf /", "../v1.0.0"]) await expectRefusal(h, /release tag/u, { version: bad });
  });

  test("already latest says so and downloads nothing", async () => {
    const h = await harness({ latest: "v0.1.2" });
    expect(await update(h)).toBe(0);
    expect(h.out).toBe("Timber 0.1.2 is already the latest version.\n");
    expect(h.downloads).toEqual([]);
    const same = await harness();
    expect(await update(same, { version: "v0.1.2" })).toBe(0);
    expect(same.out).toBe("Timber 0.1.2 is already installed.\n");
    expect(same.downloads).toEqual([]);
  });

  test("--check reports availability or up to date, refreshes the cache, and installs nothing", async () => {
    const newer = await harness();
    const before = await readFile(newer.executable);
    expect(await update(newer, { check: true })).toBe(0);
    expect(newer.out).toBe("Update available: timber 0.1.2 -> 0.1.4\nRun: timber update\n");
    expect(newer.refreshes).toBe(1);
    expect(newer.downloads).toEqual([]);
    expect(newer.installs).toEqual([]);
    expect(Buffer.compare(before, await readFile(newer.executable))).toBe(0);
    const same = await harness({ latest: "v0.1.2" });
    expect(await update(same, { check: true })).toBe(0);
    expect(same.out).toBe("Timber 0.1.2 is up to date.\n");
    const offline = await harness({ latest: null });
    await expect(update(offline, { check: true })).rejects.toThrow(/Could not check/u);
  });

  test("--check refreshes the real cache file", async () => {
    const h = await harness();
    h.deps.refresh = () => refreshUpdateCache({ env: {}, cachePath, now: () => 42, fetch: redirect("https://x/releases/tag/v0.1.9").fetchDouble });
    await update(h, { check: true });
    expect(await readUpdateCache(cachePath)).toEqual({ tag: "v0.1.9", checkedAt: 42 });
  });

  test("a failing installer (download or checksum failure) leaves the executable byte-identical", async () => {
    for (const installer of ['#!/bin/sh\necho "timber install: checksum verification failed. Nothing was installed." >&2\nexit 1\n']) {
      const h = await harness({ installer });
      const before = await readFile(h.executable);
      await expect(update(h)).rejects.toThrow(/installer failed \(exit 1\).*left in place/u);
      expect(h.err).toContain("checksum verification failed");
      expect(Buffer.compare(before, await readFile(h.executable))).toBe(0);
    }
  });

  test("the real install.sh failing on an unreachable release leaves the executable intact", async () => {
    const script = await readFile(new URL("../install.sh", import.meta.url), "utf8");
    const h = await harness({ installer: script });
    h.deps.env = { ...h.deps.env, TIMBER_RELEASES_URL: "http://insecure.invalid/releases" };
    const before = await readFile(h.executable);
    await expect(update(h)).rejects.toThrow(/installer failed/u);
    expect(h.err).toContain("TIMBER_RELEASES_URL must start with https://");
    expect(Buffer.compare(before, await readFile(h.executable))).toBe(0);
  });

  test("a failed install.sh download changes nothing", async () => {
    const h = await harness({ download: async () => { throw new Error("404"); } });
    const before = await readFile(h.executable);
    await expect(update(h)).rejects.toThrow(/Could not download install.sh/u);
    expect(h.installs).toEqual([]);
    expect(Buffer.compare(before, await readFile(h.executable))).toBe(0);
  });

  test("a failed latest lookup changes nothing", async () => {
    const h = await harness({ latest: null });
    await expect(update(h)).rejects.toThrow(/latest release/u);
    expect(h.downloads).toEqual([]);
  });

  test("refuses from source, on Windows, with an unwritable directory, or without curl or sh", async () => {
    await expectRefusal(await harness({ standalone: false }), /standalone executable/u);
    await expectRefusal(await harness({ platform: "win32" }), /docs\/windows\.md/u);
    await expectRefusal(await harness({ isWritable: async () => false }), /not writable/u);
    await expectRefusal(await harness({ hasCommand: async name => name !== "curl" }), /curl is required/u);
    await expectRefusal(await harness({ hasCommand: async name => name !== "sh" }), /sh is required/u);
    await expectRefusal(await harness({ releasesBase: () => null }), /https/u);
  });

  test("refuses when the running executable is not named timber", async () => {
    const h = await harness();
    h.deps.executablePath = join(h.installDir, "timber-dev");
    await expectRefusal(h, /not named timber/u);
  });

  test("a real read-only directory is refused by the default writability check", async () => {
    if (process.getuid?.() === 0) return;
    const h = await harness();
    await chmod(h.installDir, 0o555);
    try { expect(await realUpdateDeps().isWritable(h.installDir)).toBe(false); }
    finally { await chmod(h.installDir, 0o755); }
  });
});
