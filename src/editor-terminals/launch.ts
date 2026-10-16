import { retryForDisplay, safeDisplay } from "../display";
import type { CommandIO, EditorTerminalLaunch } from "../services";
import { createOrcaSession } from "./orca";
import { createTerminalRequest, RunnerStartupFailure } from "./request";
import type { SelfCommand, TerminalRequest } from "./request";
import type { TerminalTask } from "./protocol";
import type { EditorConfig, Worktree } from "../types";

type Session = Pick<Awaited<ReturnType<typeof createOrcaSession>>, "create" | "select">;
interface Dependencies {
  self: SelfCommand;
  ready?: (editor: EditorConfig, worktree: Worktree) => Promise<Session>;
  request?: typeof createTerminalRequest;
}

function retry(path: string, flags: string) {
  return retryForDisplay(path, `timber open ${flags} -- '${path.replaceAll("'", "'\\''")}'`, flags);
}

/** One built-in integration, not a provider registry. Agent lifetime belongs to Orca. */
export function createEditorTerminalLauncher(dependencies: Dependencies) {
  return async (launch: EditorTerminalLaunch, io: CommandIO): Promise<void> => {
    const { config, worktree, repository, agent } = launch;
    if (config.editor?.enabled !== true || config.editor.integration !== "orca") {
      throw new Error("Editor terminal launch requires an enabled Orca integration.");
    }
    const needsSetup = launch.setup && ((config.hooks?.postCreate.length ?? 0) + (launch.workflowScripts?.length ?? 0) > 0);
    const retained = `Workspace retained at ${safeDisplay(worktree.path)}.`;
    const definitive = (flags: string) => `${retained} Retry with: ${retry(worktree.path, flags)}`;
    let session: Session;
    try { session = await (dependencies.ready ?? createOrcaSession)(config.editor, worktree); }
    catch (error) {
      // Nothing has started, so one command repeats everything that was requested.
      throw new Error(`${error instanceof Error ? error.message : "Orca is not ready."} ${definitive(
        `--editor${needsSetup ? " --setup" : ""}${agent ? " --agent" : needsSetup ? " --no-agent" : ""}`)}`);
    }
    const context = { cwd: worktree.path, repositoryRoot: repository.primaryWorktreeRoot, branch: worktree.branch,
      ...(launch.workflowName === undefined ? {} : { workflow: launch.workflowName }) };
    const errors: string[] = [];
    const handles = new WeakMap<TerminalRequest, string>();
    async function start(task: TerminalTask): Promise<TerminalRequest> {
      // A setup step that never started also blocks the agent, so its retry restarts both.
      const flags = task.kind === "setup" ? `--editor --setup ${agent ? "--agent" : "--no-agent"}` : "--editor --agent";
      const request = await (dependencies.request ?? createTerminalRequest)(task, dependencies.self);
      let handle: string | undefined;
      let creationError: unknown;
      try { handle = await session.create(`Timber ${task.kind}`, request.bootstrap); }
      catch (error) {
        if (await request.fence()) {
          await request.cleanup(); // A fenced request can never run, even from a terminal Orca queued late.
          throw new Error(`${error instanceof Error ? error.message : "Orca terminal creation failed."} ${definitive(flags)}`);
        }
        creationError = error; // Runner already claimed it: observe, never replay.
      }
      if (handle) handles.set(request, handle);
      try { await request.waitStarted(10_000); }
      catch (error) {
        const settled = error instanceof RunnerStartupFailure || await request.fence();
        if (settled) await request.cleanup();
        const diagnostic = error instanceof Error ? error.message : "Editor runner startup failed.";
        throw new Error(`${diagnostic}${handle ? ` Terminal: ${handle}.` : ""} ${settled ? definitive(flags) : retained}`);
      }
      if (creationError) errors.push("Orca terminal creation acknowledgement was uncertain; inspect the selected worktree terminals before retrying.");
      if (task.kind === "agent") io.stdout(`Agent handed off to Orca${handle ? ` terminal ${handle}` : ""}.\n`);
      return request;
    }
    let setup: TerminalRequest | undefined;
    if (needsSetup) setup = await start({ ...context, kind: "setup", hooks: [...config.hooks?.postCreate ?? []],
      workflowHooks: [...launch.workflowScripts ?? []] });
    let setupSucceeded = true;
    async function finishSetup() {
      if (!setup) return;
      let observed = false;
      try {
        const result = await setup.waitSetup();
        observed = true;
        if (result.kind !== "setup-complete") {
          setupSucceeded = false;
          errors.push(result.kind === "setup-failed"
            ? `Setup ${result.phase} post_create step ${result.step} failed (${result.reason}).`
            : "Setup runner could not start.");
        }
        await setup.cleanup();
      } catch (error) {
        setupSucceeded = false;
        errors.push(error instanceof Error ? error.message : "Setup completion could not be observed.");
        errors.push(`Setup outcome is uncertain. Inspect ${handles.get(setup) ?? "the setup terminal"} and its processes before retrying; scripts may still be running.`);
      }
      setup = undefined;
      if (!setupSucceeded) errors.push(observed
        ? `${retained} Retry all setup with: ${retry(worktree.path, "--editor --setup --no-agent")}` : retained);
    }
    if (agent?.waitForSetup) await finishSetup();
    if (agent && setupSucceeded && errors.length === 0) {
      try {
        const request = await start({ ...context, kind: "agent", command: agent.command, args: [...agent.args] });
        await request.cleanup();
      } catch (error) { errors.push(error instanceof Error ? error.message : "Agent handoff failed; inspect Orca before retrying."); }
    }
    await finishSetup(); // Required even after an independent agent launch fails.
    if (!needsSetup && !agent) await session.select();
    if (errors.length) throw new Error(errors.join(" "));
  };
}
