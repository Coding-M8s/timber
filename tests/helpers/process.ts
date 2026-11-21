const code = (error: unknown): unknown => typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

/**
 * Whether no process with this pid exists. Only ESRCH counts as gone: EPERM means the process
 * exists but belongs to someone else. Rejects pid 0 and negative pids, which name process groups.
 */
function gone(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Not a single process id: ${pid}`);
  try { process.kill(pid, 0); return false; }
  catch (error) { if (code(error) === "ESRCH") return true; throw error; }
}

/**
 * Wait, up to a bound, for a process to exit. Sleeps between checks so the event loop can reap
 * children of this process. Returns true once the process is gone, false if it outlives the bound.
 */
export async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!gone(pid)) {
    if (performance.now() >= deadline) return gone(pid);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return true;
}
