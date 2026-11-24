import { spawn } from "node:child_process";
import { access, constants, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { version } from "../../package.json";
import { globalConfigPath, updateCheckCachePath } from "../config-paths";
import { readConfigScope } from "../config";
import { findExecutable } from "../platform/executable";
import { isStandaloneMain } from "../platform/standalone";
import type { CommandHandlers, CommandIO } from "../services";
import { createUpdateCheckHandler, createUpdateHandler, type UpdateDeps } from "../commands/update";
import { installWindowsRelease, removeStaleExecutables } from "./windows";
import { notifyUpdate } from "./notice";
import { refreshUpdateCache, releasesBase } from "./latest";

export const isStandalone = (): boolean => isStandaloneMain();

/**
 * Hidden one-shot child: detached and unref'd, so the parent never waits. It runs from the
 * temp directory so it never holds a worktree open or depends on one that `done` removed.
 */
export function spawnCheck(start: typeof spawn = spawn): void {
  const child = start(process.execPath, ["__update-check"], { cwd: tmpdir(), detached: true, stdio: "ignore", env: process.env });
  child.on("error", () => {});
  child.unref();
}

async function configDisabled(env: NodeJS.ProcessEnv): Promise<boolean> {
  try { return (await readConfigScope(globalConfigPath(env))).values.update_check === false; }
  catch { return true; }
}

export async function notifyAfterCommand(argv: readonly string[], io: CommandIO): Promise<void> {
  await notifyUpdate({
    argv, env: process.env, version, stderrIsTTY: process.stderr.isTTY === true, standalone: isStandalone(),
    platform: process.platform, cachePath: updateCheckCachePath(process.env), now: Date.now,
    configDisabled: () => configDisabled(process.env), spawnCheck: () => { spawnCheck(); }, stderr: text => { io.stderr(text); },
  });
}

async function download(url: string, destination: string): Promise<void> {
  await execa("curl", ["--proto", "=https", "--proto-redir", "=https", "--tlsv1.2",
    "--fail", "--silent", "--show-error", "--location", "--output", destination, url]);
}

async function reportVersion(executable: string): Promise<string | null> {
  try { return (await execa(executable, ["--version"], { reject: false, stdin: "ignore" })).stdout.trim() || null; }
  catch { return null; }
}

export function realUpdateDeps(env: NodeJS.ProcessEnv = process.env): UpdateDeps {
  const makeTempDir = () => mkdtemp(join(tmpdir(), "timber-update."));
  const removeDir = (directory: string) => rm(directory, { recursive: true, force: true });
  return {
    env, version, platform: process.platform, standalone: isStandalone(), executablePath: process.execPath,
    refresh: () => refreshUpdateCache({ env, cachePath: updateCheckCachePath(env), now: Date.now }),
    releasesBase: () => releasesBase(env),
    isWritable: async directory => { try { await access(directory, constants.W_OK); return true; } catch { return false; } },
    hasCommand: async name => (await findExecutable(name, env)) !== null,
    makeTempDir, removeDir, download, reportVersion,
    installWindows: async (base, tag) => {
      await removeStaleExecutables(process.execPath);
      await installWindowsRelease({ makeTempDir, removeDir, download, reportVersion }, base, tag, process.execPath);
    },
    // Argument array and explicit environment; nothing is interpolated into a shell string.
    // Output streams to the terminal so download progress and PATH warnings appear as they happen.
    runInstaller: async (file, installerEnv) => {
      const result = await execa("sh", [file], { env: installerEnv, extendEnv: false, reject: false, stdio: ["ignore", "inherit", "inherit"] });
      return result.exitCode ?? 1;
    },
  };
}

export const updateHandlers: Pick<CommandHandlers, "update" | "updateCheck"> = {
  update: createUpdateHandler(realUpdateDeps()),
  updateCheck: createUpdateCheckHandler(realUpdateDeps()),
};
