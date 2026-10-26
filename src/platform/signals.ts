import { constants } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export function childExitCode(code: number | null | undefined, signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT" || (process.platform === "win32" && code !== null && code !== undefined && (code >>> 0) === 0xc000013a)) return 130;
  if (signal === "SIGTERM") return 143;
  return signal ? 128 + (constants.signals[signal] ?? 1) : code ?? 1;
}

/** Only cancellation uses taskkill, and only for the child tree owned by this call. */
export async function cancelGitTree(pid: number | undefined, signal: NodeJS.Signals): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await execa(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"], { stdin: "ignore", reject: false, timeout: 5_000 });
  } else {
    try { process.kill(-pid, signal); } catch { /* The owned group may already have exited. */ }
  }
}
