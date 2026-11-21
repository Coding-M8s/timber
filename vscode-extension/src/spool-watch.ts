// Keeps a window watching the spool even if /tmp cleanup deletes or replaces it. Free of the vscode module.
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { ensureSpool } from "../../src/editor-terminals/vscode-protocol";

export interface SpoolWatchOptions {
  spool: string;
  uid: number;
  /** Called on every spool change and after each (re)arm, to pick up requests written while unwatched. */
  onChange(): void;
  /** How often to confirm the watched directory is still the spool. Well under Timber's hello timeout. */
  checkMs?: number;
}

const identity = async (path: string) => {
  try { const stat = await lstat(path); return `${stat.dev}:${stat.ino}`; } catch { return null; }
};

export function watchSpool(options: SpoolWatchOptions): { check(): Promise<void>; dispose(): void } {
  let watcher: FSWatcher | undefined;
  let watched: string | null = null;
  let disposed = false;
  let queue = Promise.resolve();

  function close() { watcher?.close(); watcher = undefined; watched = null; }
  async function verify(): Promise<void> {
    if (disposed) return;
    if (watcher && await identity(options.spool) === watched) return;
    close();
    // Fail closed: a squatted or shared spool is never watched; the next check tries again.
    try { await ensureSpool(options.spool, options.uid); } catch { return; }
    const current = await identity(options.spool);
    if (disposed || current === null) return;
    try { watcher = watch(options.spool, () => { options.onChange(); }); } catch { return; }
    watcher.on("error", () => { close(); void check(); });
    watched = current;
    options.onChange();
  }
  /** Checks run one at a time so two re-arms never race. */
  function check(): Promise<void> {
    queue = queue.then(verify, verify);
    return queue;
  }
  const timer = setInterval(() => { void check(); }, options.checkMs ?? 5000);
  timer.unref?.();
  void check();
  return { check, dispose() { disposed = true; clearInterval(timer); close(); } };
}
