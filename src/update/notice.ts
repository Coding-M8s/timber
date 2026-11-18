import { isFresh, readUpdateCache, writeUpdateCache } from "./cache";
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
  // No subcommand: bare --version or --help, whose output scripts and the installer read.
  if (command === undefined) return true;
  if (command.startsWith("__") || command === "completion" || command === "update" || command === "uninstall") return true;
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
    if (cache !== null && isFresh(cache, deps.now())) return;
    // Record the attempt before starting the child, so commands run while it is still
    // working see a fresh cache and start no second check. An unwritable cache starts
    // nothing, because the child could not record its result either.
    const claimed = await writeUpdateCache(deps.cachePath, { checkedAt: deps.now(), ...(cache?.tag === undefined ? {} : { tag: cache.tag }) });
    if (claimed) deps.spawnCheck();
  } catch {
    // The notice is a convenience and must never change a command's outcome.
  }
}
