import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { runSetupTask, SetupFailure, taskEnvironment } from "../hooks";
import { assertPrivate, processIdentity, publish, taskSchema } from "./protocol";

/** Keep an editor terminal open after the task, with the environment the terminal started with. */
async function holdTerminal(cwd: string, env: NodeJS.ProcessEnv, code: number): Promise<number> {
  const shell = env.SHELL !== undefined && isAbsolute(env.SHELL) ? env.SHELL : "/bin/sh";
  process.stdout.write(`\nTimber task ${code === 0 ? "finished" : `exited with code ${code}`}. This terminal stays open; type exit to close it.\n`);
  // The shell owns Ctrl-C now; the runner must survive it so the terminal stays open.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    const child = spawn(shell, [], { cwd, env, shell: false, stdio: "inherit" });
    await new Promise<void>(resolve => { child.once("error", () => resolve()); child.once("close", () => resolve()); });
  } catch {
    // The task outcome is already published; a missing shell only closes the terminal sooner.
  } finally { process.removeListener("SIGINT", ignore); }
  return code;
}

/** Private internal dispatch: no config, Git discovery, installation hints or shell evaluation. */
export async function runEditorTask(directory: string): Promise<number> {
  const inherited = { ...process.env };
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
        return task.hold ? await holdTerminal(task.cwd, inherited, 0) : 0;
      } catch (error) {
        if (!(error instanceof SetupFailure)) throw error;
        process.stderr.write(`Setup ${error.phase} post_create step ${error.step} failed (${error.reason}). Workspace retained.\n`);
        await publish(directory, "result.json", { kind: "setup-failed", step: error.step, phase: error.phase, reason: error.reason });
        return task.hold ? await holdTerminal(task.cwd, inherited, 1) : 1;
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
    let code: number;
    try {
      await publish(directory, "started.json", { kind: "spawned", identity });
      code = await finished;
    } finally {
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", interrupt);
    }
    return task.hold ? await holdTerminal(task.cwd, inherited, code) : code;
  } catch {
    if (claimed && !agentSpawned) await publish(directory, "result.json", { kind: "startup-failed" }).catch(() => {});
    process.stderr.write("Could not use private editor runner data; inspect the editor terminal and retained workspace.\n");
    return 1;
  }
}
