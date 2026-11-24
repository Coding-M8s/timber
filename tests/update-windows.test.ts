import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installWindowsRelease, realWindowsFileOps, removeStaleExecutables, windowsChecksumsAsset,
  windowsExecutableAsset, type WindowsFileOps, type WindowsInstallDeps,
} from "../src/update/windows";
import { isStandaloneMain } from "../src/platform/standalone";

const base = "https://fixture.test/releases";
const tag = "v0.3.0";
const newBuild = "new build bytes";
let root: string;
let installDir: string;
let target: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "timber-update-windows-"));
  installDir = join(root, "Timber");
  await mkdir(installDir);
  target = join(installDir, "timber.exe");
  await writeFile(target, "old build");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

interface Fixture { deps: WindowsInstallDeps; downloads: string[]; temps: string[] }

function fixture(options: { exe?: string; manifest?: string; failDownload?: boolean; reported?: string | null; files?: WindowsFileOps } = {}): Fixture {
  const exe = options.exe ?? newBuild;
  const name = windowsExecutableAsset(tag);
  const manifest = options.manifest ?? `${sha256("license")}  LICENSE\n${sha256(newBuild)}  ${name}\n`;
  const downloads: string[] = [];
  const temps: string[] = [];
  return {
    downloads, temps,
    deps: {
      makeTempDir: async () => { const dir = await mkdtemp(join(root, "dl-")); temps.push(dir); return dir; },
      removeDir: dir => rm(dir, { recursive: true, force: true }),
      download: async (url, destination) => {
        downloads.push(url);
        if (options.failDownload) throw new Error("404");
        await writeFile(destination, url.endsWith(windowsChecksumsAsset) ? manifest : exe);
      },
      reportVersion: async () => options.reported === undefined ? "0.3.0" : options.reported,
      ...(options.files === undefined ? {} : { files: options.files }),
      uniqueSuffix: () => "123",
    },
  };
}

async function expectUnchanged(run: Promise<void>, pattern: RegExp, f: Fixture): Promise<void> {
  await expect(run).rejects.toThrow(pattern);
  expect(await readFile(target, "utf8")).toBe("old build");
  expect((await readdir(installDir)).sort()).toEqual(["timber.exe"]);
  for (const dir of f.temps) expect(await readdir(dir).catch(() => null)).toBeNull();
}

describe("installWindowsRelease", () => {
  test("downloads the tag's checksums and executable, verifies them, and swaps the new build in", async () => {
    const f = fixture();
    await installWindowsRelease(f.deps, base, tag, target);
    expect(f.downloads).toEqual([
      `${base}/download/${tag}/SHA256SUMS-windows-x64`,
      `${base}/download/${tag}/timber-v0.3.0-windows-x64.exe`,
    ]);
    expect(await readFile(target, "utf8")).toBe(newBuild);
    // Nothing runs the old build here, so its moved-aside copy is removed at once.
    expect(await readdir(installDir)).toEqual(["timber.exe"]);
    for (const dir of f.temps) expect(await readdir(dir).catch(() => null)).toBeNull();
  });

  test("a failed download changes nothing", async () => {
    const f = fixture({ failDownload: true });
    await expectUnchanged(installWindowsRelease(f.deps, base, tag, target), /Could not download the Windows release for v0\.3\.0\. Nothing was changed/u, f);
  });

  test("a checksum mismatch changes nothing", async () => {
    const f = fixture({ exe: "tampered" });
    await expectUnchanged(installWindowsRelease(f.deps, base, tag, target), /Checksum verification failed/u, f);
  });

  test("a manifest without the executable, or only a near match, changes nothing", async () => {
    for (const manifest of ["", `${sha256(newBuild)}  timber-v0.3.0-windows-x64.exe.bak\n`, `${sha256(newBuild)} timber-v0.3.0-windows-x64.exe\n`]) {
      const f = fixture({ manifest });
      await expectUnchanged(installWindowsRelease(f.deps, base, tag, target), /does not list timber-v0\.3\.0-windows-x64\.exe/u, f);
    }
  });

  test("accepts a manifest with CRLF line endings", async () => {
    const f = fixture({ manifest: `${sha256(newBuild)}  ${windowsExecutableAsset(tag)}\r\n` });
    await installWindowsRelease(f.deps, base, tag, target);
    expect(await readFile(target, "utf8")).toBe(newBuild);
  });

  test("a download that does not report the tag's version changes nothing", async () => {
    for (const reported of [null, "0.2.9"]) {
      const f = fixture({ reported });
      await expectUnchanged(installWindowsRelease(f.deps, base, tag, target), /did not report version 0\.3\.0/u, f);
    }
  });

  test("an unwritable install directory changes nothing", async () => {
    const f = fixture({ files: { ...realWindowsFileOps, copyFile: async () => { throw new Error("EPERM"); } } });
    await expectUnchanged(installWindowsRelease(f.deps, base, tag, target), /Could not write to .*Nothing was changed/u, f);
  });

  test("failing to move the current executable aside changes nothing", async () => {
    const f = fixture({ files: { ...realWindowsFileOps, rename: async () => { throw new Error("EBUSY"); } } });
    await expectUnchanged(installWindowsRelease(f.deps, base, tag, target), /Could not move timber\.exe aside\. Nothing was changed/u, f);
  });

  test("failing to move the new build into place restores the original", async () => {
    let calls = 0;
    const files: WindowsFileOps = { ...realWindowsFileOps, rename: async (from, to) => {
      calls++;
      if (calls === 2) throw new Error("EBUSY");
      await realWindowsFileOps.rename(from, to);
    } };
    const f = fixture({ files });
    await expectUnchanged(installWindowsRelease(f.deps, base, tag, target), /The existing Timber was left in place/u, f);
  });

  test("names the moved-aside file when the original cannot be restored", async () => {
    let calls = 0;
    const files: WindowsFileOps = { ...realWindowsFileOps, rename: async (from, to) => {
      calls++;
      if (calls >= 2) throw new Error("EBUSY");
      await realWindowsFileOps.rename(from, to);
    } };
    const f = fixture({ files });
    await expect(installWindowsRelease(f.deps, base, tag, target)).rejects.toThrow(/Rename .*timber\.exe\.old back to timber\.exe/u);
    expect(await readFile(`${target}.old`, "utf8")).toBe("old build");
  });

  test("uses a fresh aside name when an earlier .old cannot be removed", async () => {
    await writeFile(`${target}.old`, "still running");
    const removed: string[] = [];
    const files: WindowsFileOps = { ...realWindowsFileOps, remove: async file => {
      removed.push(file);
      if (file.endsWith(".old") || file.endsWith(".old-123")) throw new Error("EPERM");
      await realWindowsFileOps.remove(file);
    } };
    const f = fixture({ files });
    await installWindowsRelease(f.deps, base, tag, target);
    expect(await readFile(target, "utf8")).toBe(newBuild);
    expect(await readFile(`${target}.old`, "utf8")).toBe("still running");
    expect(await readFile(`${target}.old-123`, "utf8")).toBe("old build");
  });
});

describe("removeStaleExecutables", () => {
  test("removes only .old leftovers next to the executable", async () => {
    for (const name of ["timber.exe.old", "TIMBER.EXE.OLD-1700000000000", "timber.exe.old-x", "timber.exe.oldest", "notes.txt"]) {
      await writeFile(join(installDir, name), "x");
    }
    await removeStaleExecutables(target);
    expect((await readdir(installDir)).sort()).toEqual(["notes.txt", "timber.exe", "timber.exe.old-x", "timber.exe.oldest"]);
  });

  test("never throws for a missing directory", async () => {
    await removeStaleExecutables(join(root, "missing", "timber.exe"));
  });
});

describe("isStandaloneMain", () => {
  test("recognizes compiled entries on POSIX and Windows, not source runs", () => {
    expect(isStandaloneMain("/$bunfs/root/timber")).toBe(true);
    expect(isStandaloneMain("B:/~BUN/root/timber.exe")).toBe(true);
    expect(isStandaloneMain("B:\\~BUN\\root\\timber.exe")).toBe(true);
    expect(isStandaloneMain("C:\\Users\\me\\timber\\src\\index.ts")).toBe(false);
    expect(isStandaloneMain("/home/me/timber/src/index.ts")).toBe(false);
  });
});

// Windows refuses to overwrite a running executable; the swap must still work.
describe.skipIf(process.platform !== "win32")("Windows swap with the executable running", () => {
  test("replaces a running timber.exe and leaves the running copy aside until it exits", async () => {
    const system = process.env.SystemRoot ?? "C:\\Windows";
    await copyFile(join(system, "System32", "ping.exe"), target);
    const running = spawn(target, ["-n", "30", "127.0.0.1"], { stdio: "ignore" });
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      await expect(writeFile(target, "overwrite")).rejects.toThrow();
      const f = fixture({ manifest: `${sha256(newBuild)}  ${windowsExecutableAsset(tag)}\n` });
      await installWindowsRelease(f.deps, base, tag, target);
      expect(await readFile(target, "utf8")).toBe(newBuild);
      expect((await readdir(installDir)).sort()).toEqual(["timber.exe", "timber.exe.old"]);
    } finally {
      running.kill();
      await new Promise(resolve => running.once("exit", resolve));
    }
    // Windows can hold an exited program's image briefly, so retry the best-effort cleanup.
    for (let attempt = 0; attempt < 20; attempt++) {
      await removeStaleExecutables(target);
      if ((await readdir(installDir)).length === 1) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(await readdir(installDir)).toEqual(["timber.exe"]);
  });
});
