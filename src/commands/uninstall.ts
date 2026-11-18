import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { globalConfigPath, installationMarkerPath, updateCheckCachePath } from "../config-paths";
import { safeDiagnostic, safeDisplay as display } from "../display";
import { findExecutable } from "../platform/executable";
import { gitLocation } from "../platform/git-location";
import type { CommandHandlers } from "../services";

export interface UninstallDependencies {
  /** The running executable; process.execPath in production. */
  executablePath: string;
  /** True only for a compiled standalone release build, never a Bun source run. */
  standalone: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Current user id; absent on platforms without POSIX ownership. */
  uid?: number | undefined;
  /** True when the path or an existing ancestor is inside a Git worktree or Git directory. */
  insideGit?: (path: string) => Promise<boolean>;
}

const repositoryLine = "Repositories, worktrees, branches, .timber.toml and <git common dir>/timber/ are never touched; remove per-repository data by hand if wanted.";
const completionReminder = "If you added Timber completion lines to .bashrc, .zshrc or fish config, remove them yourself; Timber does not edit shell startup files.";

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

/** Same Git probe as the credential stores: never a place Timber may delete from. */
export async function pathInsideGit(path: string): Promise<boolean> {
  const location = await gitLocation(path);
  if (location === "unverified") throw new Error("Git could not verify that the location is outside Git.");
  return location === "inside";
}

interface Plan {
  files: string[];
  directories: string[];
  keptSettings: string[];
  unknown: string[];
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (code(error) === "ENOENT") return false; throw error; }
}

async function entries(directory: string): Promise<string[]> {
  try { return await readdir(directory); }
  catch (error) { if (code(error) === "ENOENT") return []; throw error; }
}

async function guard(path: string, kind: "file" | "directory", dependencies: Required<Pick<UninstallDependencies, "insideGit">> & UninstallDependencies): Promise<void> {
  const info = await lstat(path);
  const shown = display(path);
  if (info.isSymbolicLink()) throw new Error(`Refusing to uninstall: ${shown} is a symlink. Nothing was removed. Remove it by hand if you intended to.`);
  if (kind === "file" ? !info.isFile() : !info.isDirectory()) throw new Error(`Refusing to uninstall: ${shown} is not a regular ${kind}. Nothing was removed.`);
  if (dependencies.uid !== undefined && info.uid !== dependencies.uid) throw new Error(`Refusing to uninstall: ${shown} is not owned by the current user. Nothing was removed.`);
  if (await dependencies.insideGit(path)) throw new Error(`Refusing to uninstall: ${shown} is inside a Git directory. Nothing was removed.`);
}

async function buildPlan(removeSettings: boolean, dependencies: Required<Pick<UninstallDependencies, "insideGit" | "env">> & UninstallDependencies): Promise<Plan> {
  const plan: Plan = { files: [dependencies.executablePath], directories: [], keptSettings: [], unknown: [] };
  const configFile = globalConfigPath(dependencies.env);
  const configDirectory = dirname(configFile);
  const credentialsDirectory = join(configDirectory, "credentials");
  const credentialFiles = ["jira.json", "linear.json"].map(name => join(credentialsDirectory, name));
  const marker = installationMarkerPath(dependencies.env);
  const stateDirectory = dirname(marker);
  const updateCache = updateCheckCachePath(dependencies.env);
  const cacheDirectory = dirname(updateCache);
  const settings = [configFile, ...credentialFiles, marker, updateCache];
  if (!removeSettings) {
    for (const path of settings) if (await exists(path)) plan.keptSettings.push(path);
    return plan;
  }
  for (const path of settings) if (await exists(path)) plan.files.push(path);
  const known = new Set([...settings, credentialsDirectory]);
  for (const directory of [configDirectory, credentialsDirectory, stateDirectory, cacheDirectory]) {
    if (!await exists(directory)) continue;
    plan.directories.push(directory);
    for (const name of await entries(directory)) {
      const path = join(directory, name);
      if (!known.has(path)) plan.unknown.push(path);
    }
  }
  return plan;
}

/** Remove the running standalone executable and, on request, machine settings. */
export function createUninstallHandler(dependencies: UninstallDependencies): NonNullable<CommandHandlers["uninstall"]> {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const insideGit = dependencies.insideGit ?? pathInsideGit;
  const resolved = { ...dependencies, env, insideGit };
  return async (options, context) => {
    const out = context.io.stdout;
    if (platform === "win32") {
      throw new Error("timber uninstall is not supported on Windows: a running .exe cannot delete itself. Follow the manual removal steps in docs/windows.md and docs/guide.md#remove-timber.");
    }
    if (!dependencies.standalone || /^bunx?$/iu.test(basename(dependencies.executablePath))) {
      throw new Error("timber uninstall only removes a standalone release build. This looks like a Bun source or bun link run, so nothing was removed. See CONTRIBUTING.md to remove a development checkout.");
    }
    const removeSettings = options.removeSettings === true;
    // Validate every target before anything is shown as removable or removed.
    const plan = await buildPlan(removeSettings, resolved);
    for (const file of plan.files) await guard(file, "file", resolved);
    for (const directory of plan.directories) await guard(directory, "directory", resolved);

    out("Timber will remove:\n");
    for (const path of plan.files) out(`  ${display(path)}\n`);
    for (const path of plan.directories) out(`  ${display(path)} (only if empty afterwards)\n`);
    out("Timber will keep:\n");
    for (const path of plan.keptSettings) out(`  ${display(path)} (rerun with --remove-settings to remove)\n`);
    for (const path of plan.unknown) out(`  ${display(path)} (not a Timber file; left in place)\n`);
    out(`  ${repositoryLine}\n`);

    if (options.yes !== true) {
      if (!context.choose) {
        throw new Error("timber uninstall needs confirmation. Run it in an interactive terminal, or pass --yes. Nothing was removed.");
      }
      const choice = await context.choose("Remove the items listed above?", [
        { value: "cancel", label: "No, keep everything (default)", default: true },
        { value: "remove", label: "Yes, uninstall" },
      ]);
      if (choice !== "remove") { out("Cancelled. Nothing was removed.\n"); return 0; }
    }

    for (const file of plan.files) await unlink(file);
    // Deepest first; rmdir refuses a non-empty directory, so unknown files survive.
    for (const directory of [...plan.directories].reverse()) {
      try { await rmdir(directory); } catch (error) {
        if (code(error) !== "ENOTEMPTY" && code(error) !== "EEXIST" && code(error) !== "ENOENT") throw error;
      }
    }
    out(`Removed ${display(dependencies.executablePath)}.\n`);
    if (removeSettings) out("Removed machine settings, saved Jira and Linear credentials, the setup hint marker and the update check cache.\n");
    const remaining = await findExecutable("timber", env);
    if (remaining !== null) {
      context.io.stderr(`warning: another timber is still on PATH at ${safeDiagnostic(remaining)}. Remove it separately.\n`);
    }
    out(`${repositoryLine}\n${completionReminder}\n`);
    return 0;
  };
}
