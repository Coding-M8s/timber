import { retryForDisplay, safeDisplay, workflowRetryFlag } from "../display";
import type { CommandIO, EditorTerminalLaunch } from "../services";
import { createOrcaSession, OrcaSelectionFailure } from "./orca";
import { createVscodeSession } from "./vscode";
import { createTerminalRequest, RunnerStartupFailure } from "./request";
import type { SelfCommand, TerminalRequest } from "./request";
import type { TerminalTask } from "./protocol";
import type { EditorConfig, Worktree } from "../types";

interface Session {
  /** `argv` carries the bootstrap as literal arguments for editors that start a process without a shell. */
  create(title: string, bootstrap?: string, argv?: readonly string[]): Promise<string>;
  select(): Promise<void>;
}
const labels = { orca: "Orca", vscode: "VS Code" } as const;
interface Dependencies {
  self: SelfCommand;
  ready?: (editor: EditorConfig, worktree: Worktree) => Promise<Session>;
  request?: typeof createTerminalRequest;
}

function retryCommand(path: string, flags: string) {
  return retryForDisplay(path, `timber open ${flags} -- '${path.replaceAll("'", "'\\''")}'`, flags);
}

/** Agent lifetime belongs to the editor; await only setup and startup. */
export function createEditorTerminalLauncher(dependencies: Dependencies) {
  return async (launch: EditorTerminalLaunch, io: CommandIO): Promise<void> => {
    const { config, worktree, repository, agent } = launch;
    const integration = config.editor?.enabled === true ? config.editor.integration : undefined;
    if (integration === undefined) {
      throw new Error("Editor terminal launch requires an enabled Orca or VS Code integration.");
    }
    const label = labels[integration];
    const needsSetup = launch.setup && ((config.hooks?.postCreate.length ?? 0) + (launch.workflowScripts?.length ?? 0) > 0);
    // The workflow is not remembered, so every retry names it again.
    const retry = (path: string, flags: string) => retryCommand(path, flags + workflowRetryFlag(launch.workflowName));
    const retained = `Workspace retained at ${safeDisplay(worktree.path)}.`;
    const definitive = (flags: string) => `${retained} Retry with: ${retry(worktree.path, flags)}`;
    let session: Session;
    const ready = dependencies.ready ?? (integration === "vscode" ? createVscodeSession : createOrcaSession);
    try { session = await ready(config.editor!, worktree); }
    catch (error) {
      // Nothing has started, so one command repeats everything that was requested.
      throw new Error(`${error instanceof Error ? error.message : `${label} is not ready.`} ${definitive(
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
      let selectionError: OrcaSelectionFailure | undefined;
      try { handle = await session.create(`Timber ${task.kind}`, request.bootstrap, request.argv); }
      catch (error) {
        if (error instanceof OrcaSelectionFailure) {
          handle = error.handle;
          selectionError = error; // Terminal exists: observe its runner, never fence or recreate it.
        } else if (await request.fence()) {
          await request.cleanup(); // A fenced request can never run, even from a terminal the editor queued late.
          throw new Error(`${error instanceof Error ? error.message : `${label} terminal creation failed.`} ${definitive(flags)}`);
        } else creationError = error; // Runner already claimed it: observe, never replay.
      }
      if (handle) handles.set(request, handle);
      try { await request.waitStarted(10_000); }
      catch (error) {
        const settled = error instanceof RunnerStartupFailure || await request.fence();
        if (settled) await request.cleanup();
        const diagnostic = error instanceof Error ? error.message : "Editor runner startup failed.";
        throw new Error(`${diagnostic}${handle ? ` Terminal: ${handle}.` : ""} ${settled ? definitive(flags) : retained}`);
      }
      if (creationError) errors.push(`${label} terminal creation acknowledgement was uncertain; inspect the selected worktree terminals before retrying.`);
      if (selectionError) errors.push(`${selectionError.message} ${retained}`);
      if (task.kind === "agent" && !selectionError && !creationError) io.stdout(`Agent handed off to ${label}${handle ? ` terminal ${handle}` : ""}.\n`);
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
      } catch (error) { errors.push(error instanceof Error ? error.message : `Agent handoff failed; inspect ${label} before retrying.`); }
    }
    await finishSetup(); // Required even after an independent agent launch fails.
    if (!needsSetup && !agent) {
      try { await session.select(); }
      catch (error) { errors.push(`${error instanceof Error ? error.message : `Could not select the ${label} worktree.`} ${retained}`); }
    }
    if (errors.length) throw new Error(errors.join(" "));
  };
}
