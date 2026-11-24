import { basename, dirname, join, win32 } from "node:path";
import type { CommandHandlers } from "../services";
import { compareVersions, isReleaseTag } from "../update/tag";

export interface UpdateDeps {
  env: NodeJS.ProcessEnv;
  /** Running version without a leading v. */
  version: string;
  platform: NodeJS.Platform;
  /** A compiled executable, not a source run. */
  standalone: boolean;
  executablePath: string;
  /** Fresh check that refreshes the cache; the stable tag found, or null on failure. */
  refresh(): Promise<string | null>;
  /** Releases base URL (https only), or null when TIMBER_RELEASES_URL is unusable. */
  releasesBase(): string | null;
  isWritable(directory: string): Promise<boolean>;
  hasCommand(name: string): Promise<boolean>;
  makeTempDir(): Promise<string>;
  removeDir(directory: string): Promise<void>;
  /** Fetch one https URL into a file; rejects on any failure. */
  download(url: string, destination: string): Promise<void>;
  /** Run `sh <file>` with exactly this environment, its output streaming to the terminal; the exit code. */
  runInstaller(file: string, env: NodeJS.ProcessEnv): Promise<number>;
  /** What the executable prints for --version, or null. */
  reportVersion(executable: string): Promise<string | null>;
  /** Windows: download, verify and swap in the release for `tag`; rejects with a diagnostic and changes nothing on failure. */
  installWindows(base: string, tag: string): Promise<void>;
}

export interface UpdateOptions { check?: boolean; version?: string }

/** Hidden `__update-check`: one silent refresh of the cache. */
export function createUpdateCheckHandler(deps: Pick<UpdateDeps, "refresh">): NonNullable<CommandHandlers["updateCheck"]> {
  return async () => {
    try { await deps.refresh(); } catch { /* All failures are silent. */ }
    return 0;
  };
}

export function createUpdateHandler(deps: UpdateDeps): NonNullable<CommandHandlers["update"]> {
  return async (options, context) => {
    const { io } = context;
    const current = deps.version;
    if (options.version !== undefined && !isReleaseTag(options.version)) {
      throw new Error("--version must be a release tag such as v0.1.0.");
    }
    if (options.check === true && options.version !== undefined) {
      throw new Error("--check and --version cannot be combined.");
    }

    if (options.check === true) {
      const latest = await deps.refresh();
      if (latest === null) throw new Error("Could not check for updates. Try again later.");
      io.stdout(isNewer(latest, current) ? `Update available: timber ${current} -> ${latest.slice(1)}\nRun: timber update\n`
        : `Timber ${current} is up to date.\n`);
      return 0;
    }

    // Refusals come before any network use and change nothing.
    if (!deps.standalone) {
      throw new Error("timber update only works on the standalone executable, not a source run. Update your checkout instead.");
    }
    const windows = deps.platform === "win32";
    const paths = windows ? win32 : { basename, dirname };
    const installDir = paths.dirname(deps.executablePath);
    const name = paths.basename(deps.executablePath);
    if (windows ? name.toLowerCase() !== "timber.exe" : name !== "timber") {
      throw new Error(`The running executable is not named ${windows ? "timber.exe" : "timber"} (${name}); the update would not replace it. Nothing was changed.`);
    }
    // Windows permission checks are unreliable here; the swap itself fails safely instead.
    if (!windows && !await deps.isWritable(installDir)) {
      throw new Error(`The install directory ${installDir} is not writable. Nothing was changed.`);
    }
    for (const command of windows ? ["curl"] : ["curl", "sh"]) {
      if (!await deps.hasCommand(command)) throw new Error(`${command} is required to update Timber. Nothing was changed.`);
    }
    const base = deps.releasesBase();
    if (base === null) throw new Error("TIMBER_RELEASES_URL must start with https://");

    let tag = options.version;
    if (tag === undefined) {
      const latest = await deps.refresh();
      if (latest === null) throw new Error("Could not find the latest release. Nothing was changed.");
      tag = latest;
    }
    const comparison = compareVersions(tag, current);
    if (options.version !== undefined && comparison === 0) {
      io.stdout(`Timber ${current} is already installed.\n`);
      return 0;
    }
    if (options.version === undefined && comparison !== null && comparison <= 0) {
      io.stdout(`Timber ${current} is already the latest version.\n`);
      return 0;
    }

    if (windows) {
      io.stdout(`Updating Timber ${current} -> ${tag.slice(1)}\n`);
      await deps.installWindows(base, tag);
      const reported = await deps.reportVersion(deps.executablePath);
      io.stdout(`Timber is now version ${reported ?? "unknown"}.\n`);
      return 0;
    }

    const directory = await deps.makeTempDir();
    try {
      const file = join(directory, "install.sh");
      try { await deps.download(`${base}/download/${tag}/install.sh`, file); }
      catch { throw new Error(`Could not download install.sh for ${tag}. Nothing was changed.`); }
      io.stdout(`Updating Timber ${current} -> ${tag.slice(1)}\n`);
      const code = await deps.runInstaller(file, { ...deps.env, TIMBER_INSTALL_DIR: installDir, TIMBER_VERSION: tag });
      if (code !== 0) throw new Error(`The installer failed (exit ${code}). The existing Timber was left in place.`);
    } finally {
      await deps.removeDir(directory).catch(() => {});
    }
    const reported = await deps.reportVersion(deps.executablePath);
    io.stdout(`Timber is now version ${reported ?? "unknown"}.\n`);
    return 0;
  };
}

function isNewer(tag: string, current: string): boolean {
  return (compareVersions(tag, current) ?? 0) > 0;
}
