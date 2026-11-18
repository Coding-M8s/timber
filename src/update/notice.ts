import { isFresh, readUpdateCache } from "./cache";
import { isNewerStable } from "./tag";

export interface NoticeDeps {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Running version without a leading v. */
  version: string;
  stderrIsTTY: boolean;
  /** A compiled executable, not a source run. */
  standalone: boolean;
  platform: NodeJS.Platform;
  cachePath: string;
  now(): number;
  /** True when update_check = false in the global config. Failures count as disabled. */
  configDisabled(): Promise<boolean>;
  /** Start the detached one-shot check. Must not wait for it. */
  spawnCheck(): void;
  stderr(text: string): void;
}

/** Commands and flags whose output must stay free of update traffic and notices. */
export function skipsUpdateCheck(argv: readonly string[]): boolean {
  const command = argv.find(argument => !argument.startsWith("-"));
  if (command === undefined) return false;
  if (command.startsWith("__") || command === "completion" || command === "update") return true;
  return argv.some(argument => argument === "--json" || argument === "--result-file" || argument.startsWith("--result-file="));
}

/**
 * After a command finishes: print a cached notice, and start a detached refresh
 * when the cache is missing or stale. Never waits on the network and never throws.
 */
export async function notifyUpdate(deps: NoticeDeps): Promise<void> {
  try {
    if (!deps.stderrIsTTY || !deps.standalone || deps.platform === "win32") return;
    if (deps.env.CI !== undefined && deps.env.CI !== "") return;
    if (deps.env.TIMBER_NO_UPDATE_CHECK === "1") return;
    if (skipsUpdateCheck(deps.argv)) return;
    if (await deps.configDisabled()) return;
    const cache = await readUpdateCache(deps.cachePath);
    if (cache?.tag !== undefined && isNewerStable(cache.tag, deps.version)) {
      deps.stderr(`Update available: timber ${deps.version} -> ${cache.tag.slice(1)}\nRun: timber update\n`);
    }
    if (cache === null || !isFresh(cache, deps.now())) deps.spawnCheck();
  } catch {
    // The notice is a convenience and must never change a command's outcome.
  }
}
