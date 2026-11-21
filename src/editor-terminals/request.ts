import { chmod, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processIdentity, readStatus, resultSchema, startedSchema, taskSchema } from "./protocol";
import type { TerminalTask, TaskResult } from "./protocol";

export interface SelfCommand { executable: string; entry?: string }
/** The request was fenced or the runner proved that the executable never started. */
export class RunnerStartupFailure extends Error {}
/** The editor may or may not have started the terminal. The launcher fences the runner request, which settles it. */
export class UncertainHandoff extends Error {}
export interface TerminalRequest {
  directory: string;
  bootstrap: string;
  /** The same invocation as literal argv, for editors that start a process without a shell. */
  argv: readonly string[];
  waitStarted(timeoutMs: number): Promise<void>;
  waitSetup(): Promise<TaskResult>;
  fence(): Promise<boolean>;
  cleanup(): Promise<void>;
}

/** Only generated ASCII paths occur in shell text. All user values stay in private JSON. */
export async function createTerminalRequest(task: TerminalTask, self: SelfCommand): Promise<TerminalRequest> {
  taskSchema.parse(task);
  const directory = await mkdtemp("/tmp/timber-launch-");
  try {
    await chmod(directory, 0o700);
    await symlink(self.executable, join(directory, "runtime"));
    if (self.entry) await symlink(self.entry, join(directory, "entry.ts"));
    await writeFile(join(directory, "request.json"), JSON.stringify(task), { flag: "wx", mode: 0o600 });
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const argv = [`${directory}/runtime`, ...self.entry ? ["--no-env-file", `${directory}/entry.ts`] : [], "__editor-task", directory];
  const bootstrap = argv.join(" ");
  const status = () => readStatus(directory, "started.json", startedSchema);
  const result = () => readStatus(directory, "result.json", resultSchema);
  const fence = async () => {
    try { await rename(join(directory, "request.json"), join(directory, "cancelled.json")); return true; }
    catch {
      // Idempotent fencing lets the caller dispose a request fenced by waitStarted.
      try { if (await Bun.file(join(directory, "cancelled.json")).exists()) return true; } catch {}
      return false; // Consumed, including completed tasks: caller must observe their outcome.
    }
  };
  return {
    directory, bootstrap, argv, fence,
    cleanup: () => rm(directory, { recursive: true, force: true }),
    async waitStarted(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      do {
        const outcome = await result();
        if (outcome?.kind === "startup-failed") throw new RunnerStartupFailure("The editor terminal command could not start.");
        const ack = await status();
        if (ack && (task.kind === "setup" || ack.kind === "spawned")) return;
        if (ack && (await processIdentity(ack.identity.pid))?.start !== ack.identity.start) {
          // The runner may publish its final status and exit between our first
          // status read and this liveness check. Prefer that definitive evidence.
          const finalOutcome = await result();
          if (finalOutcome?.kind === "startup-failed") throw new RunnerStartupFailure("The editor terminal command could not start.");
          if ((await status())?.kind === "spawned") return;
          throw new Error("Editor runner exited before handoff; inspect its terminal before retrying.");
        }
        await Bun.sleep(20);
      } while (Date.now() < deadline);
      if (await fence()) throw new RunnerStartupFailure("Editor runner did not start before the timeout; its pending request was cancelled.");
      throw new Error("Editor handoff is uncertain; inspect the existing editor terminal before retrying. No launch was replayed.");
    },
    async waitSetup() {
      for (;;) {
        const outcome = await result();
        if (outcome) return outcome;
        const ack = await status();
        if (!ack || (await processIdentity(ack.identity.pid))?.start !== ack.identity.start) {
          const final = await result();
          if (final) return final;
          throw new Error("Setup runner exited without completion; inspect the setup terminal. Workspace and files retained.");
        }
        await Bun.sleep(100);
      }
    },
  };
}
