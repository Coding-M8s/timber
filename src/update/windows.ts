import { createHash } from "node:crypto";
import { copyFile, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Windows cannot overwrite or delete a running executable, but it can rename one. */
export const windowsChecksumsAsset = "SHA256SUMS-windows-x64";
export const windowsExecutableAsset = (tag: string): string => `timber-${tag}-windows-x64.exe`;

export interface WindowsFileOps {
  copyFile(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(file: string): Promise<void>;
}

export const realWindowsFileOps: WindowsFileOps = {
  copyFile: (from, to) => copyFile(from, to),
  rename: (from, to) => rename(from, to),
  remove: file => rm(file, { force: true }),
};

export interface WindowsInstallDeps {
  makeTempDir(): Promise<string>;
  removeDir(directory: string): Promise<void>;
  /** Fetch one https URL into a file; rejects on any failure. */
  download(url: string, destination: string): Promise<void>;
  /** What the executable prints for --version, or null. */
  reportVersion(executable: string): Promise<string | null>;
  files?: WindowsFileOps;
  /** Suffix for a fallback `.old` name when an earlier one is still in use. */
  uniqueSuffix?: () => string;
}

/** Downloads, verifies and swaps in the Windows executable for `tag`. Any failure leaves `executablePath` unchanged. */
export async function installWindowsRelease(deps: WindowsInstallDeps, base: string, tag: string, executablePath: string): Promise<void> {
  const files = deps.files ?? realWindowsFileOps;
  const directory = await deps.makeTempDir();
  try {
    const name = windowsExecutableAsset(tag);
    const sums = join(directory, windowsChecksumsAsset);
    const downloaded = join(directory, name);
    try {
      await deps.download(`${base}/download/${tag}/${windowsChecksumsAsset}`, sums);
      await deps.download(`${base}/download/${tag}/${name}`, downloaded);
    } catch {
      throw new Error(`Could not download the Windows release for ${tag}. Nothing was changed.`);
    }
    const expected = expectedDigest(await readFile(sums, "utf8"), name);
    if (expected === null) throw new Error(`The ${tag} checksum file does not list ${name}. Nothing was changed.`);
    const actual = createHash("sha256").update(await readFile(downloaded)).digest("hex");
    if (actual !== expected) throw new Error("Checksum verification failed. Nothing was changed.");
    if (await deps.reportVersion(downloaded) !== tag.slice(1)) {
      throw new Error(`The downloaded executable did not report version ${tag.slice(1)}. Nothing was changed.`);
    }
    await swapExecutable(files, downloaded, executablePath, deps.uniqueSuffix ?? (() => String(Date.now())));
  } finally {
    await deps.removeDir(directory).catch(() => {});
  }
}

function expectedDigest(manifest: string, name: string): string | null {
  for (const line of manifest.split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (match?.[2] === name) return match[1]!;
  }
  return null;
}

/**
 * Stage beside the target so the final rename stays on one volume, move the running
 * executable aside, then move the staged copy into place. Restores the original on failure.
 */
async function swapExecutable(files: WindowsFileOps, source: string, target: string, uniqueSuffix: () => string): Promise<void> {
  const staged = `${target}.new`;
  try { await files.copyFile(source, staged); }
  catch {
    await files.remove(staged).catch(() => {});
    throw new Error(`Could not write to ${dirname(target)}. Nothing was changed.`);
  }
  // An earlier update's `.old` may still be running; then pick a fresh name instead.
  let aside = `${target}.old`;
  try { await files.remove(aside); } catch { aside = `${target}.old-${uniqueSuffix()}`; }
  try { await files.rename(target, aside); }
  catch {
    await files.remove(staged).catch(() => {});
    throw new Error(`Could not move ${basename(target)} aside. Nothing was changed.`);
  }
  try { await files.rename(staged, target); }
  catch {
    const restored = await files.rename(aside, target).then(() => true, () => false);
    await files.remove(staged).catch(() => {});
    throw new Error(restored
      ? `Could not move the new ${basename(target)} into place. The existing Timber was left in place.`
      : `Could not move the new ${basename(target)} into place or restore the old one. Rename ${aside} back to ${basename(target)}.`);
  }
  // Succeeds only when nothing still runs it; otherwise a later update removes it.
  await files.remove(aside).catch(() => {});
}

/** Best effort: remove `.old` executables earlier updates left behind. Never throws. */
export async function removeStaleExecutables(executablePath: string): Promise<void> {
  const prefix = `${basename(executablePath)}.old`.toLowerCase();
  try {
    for (const entry of await readdir(dirname(executablePath))) {
      const lower = entry.toLowerCase();
      if (lower.startsWith(prefix) && /^(?:-\d+)?$/u.test(lower.slice(prefix.length))) {
        await rm(join(dirname(executablePath), entry), { force: true }).catch(() => {});
      }
    }
  } catch { /* A missing or unreadable directory leaves nothing to clean. */ }
}
