import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runSetupTask, SetupFailure, taskEnvironment } from "../hooks";
import { assertPrivate, processIdentity, publish, taskSchema } from "./protocol";

/** Private internal dispatch: no config, Git discovery, installation hints or shell evaluation. */
export async function runEditorTask(directory: string): Promise<number> {
  let claimed = false;
  let agentSpawned = false;
  try {
    if (!/^\/tmp\/timber-launch-[a-zA-Z0-9]+$/.test(directory)) throw new Error("Invalid private editor request path.");
    await assertPrivate(directory, true);
    await assertPrivate(join(directory, "request.json"));
    // A timeout races the same rename: exactly one of claim and fence succeeds.
    await rename(join(directory, "request.json"), join(directory, "claimed.json"));
    claimed = true;
    const task = taskSchema.parse(JSON.parse(await readFile(join(directory, "claimed.json"), "utf8")));
    await writeFile(join(directory, "claimed.json"), "", { mode: 0o600 });
    process.chdir(task.cwd);
    const identity = await processIdentity();
    if (!identity) throw new Error("Cannot identify editor runner.");
    await publish(directory, "started.json", { kind: "starting", identity });
    for (const [key, value] of Object.entries(taskEnvironment(task))) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (task.kind === "setup") {
      try {
        await runSetupTask(task, { stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); } });
        await publish(directory, "result.json", { kind: "setup-complete" });
        return 0;
      } catch (error) {
        if (!(error instanceof SetupFailure)) throw error;
        process.stderr.write(`Setup ${error.phase} post_create step ${error.step} failed (${error.reason}). Workspace retained.\n`);
        await publish(directory, "result.json", { kind: "setup-failed", step: error.step, phase: error.phase, reason: error.reason });
        return 1;
      }
    }
    const child = spawn(task.command, task.args, { cwd: task.cwd, shell: false, stdio: "inherit" });
    const finished = new Promise<number>(resolve => {
      child.once("error", () => resolve(1));
      child.once("close", (code, signal) => resolve(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : code ?? 1));
    });
    try { await once(child, "spawn"); }
    catch { await publish(directory, "result.json", { kind: "startup-failed" }); return 1; }
    agentSpawned = true;
    // Terminal Ctrl-C already reaches the child. Forward only process-directed termination.
    const terminate = () => { child.kill("SIGTERM"); };
    const interrupt = () => { if (!process.stdin.isTTY) child.kill("SIGINT"); };
    process.on("SIGTERM", terminate);
    process.on("SIGINT", interrupt);
    try {
      await publish(directory, "started.json", { kind: "spawned", identity });
      return await finished;
    } finally {
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", interrupt);
    }
  } catch {
    if (claimed && !agentSpawned) await publish(directory, "result.json", { kind: "startup-failed" }).catch(() => {});
    process.stderr.write("Could not use private editor runner data; inspect the editor terminal and retained workspace.\n");
    return 1;
  }
}
