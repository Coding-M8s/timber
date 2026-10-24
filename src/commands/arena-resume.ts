import type { CommandContext } from "../services";
import type { ArenaResumeServices } from "../arena/services";
import type { ArenaAttemptRecord, ArenaResumeOptions } from "../arena/types";
import { FormattedError, safeDisplay } from "../display";
import { SetupFailure } from "../hooks";
import { workflowEditor } from "../workflow";
import { buildArenaAgentCommand, validateArenaName } from "../arena/participants";
import { recoverArenaParticipant } from "../arena/recovery";
import { arenaResumeRetry } from "../arena/display";
import { arenaEffortEnvironment } from "../arena/effort";


function selectorError(attempts: readonly ArenaAttemptRecord[]): FormattedError {
  const labels = attempts.map(a => a.label).sort();
  return new FormattedError(`Select an exact attempt with --attempt <label> (${labels.length} attempts; showing ${Math.min(5, labels.length)}):\n${labels.slice(0, 5).map(label => `  ${label}`).join("\n")}\nOr rerun in an interactive terminal to choose an existing attempt.`);
}

function incompleteSetup(attempt: ArenaAttemptRecord): boolean {
  return attempt.stage === "created" || attempt.stage === "setup-running" ||
    (attempt.stage === "failed" && attempt.failedStage === "setup");
}

/** Continue only an existing, reciprocal identity; never materialize or reset work. */
export function createArenaResumeHandler(services: ArenaResumeServices) {
  return async (name: string, options: ArenaResumeOptions, context: CommandContext): Promise<number> => {
    validateArenaName(name);
    const repository = await services.discoverRepository(context.cwd);
    const { manifest } = await services.readArena(repository, name);
    let selected: ArenaAttemptRecord | undefined;
    if (options.attempt !== undefined) {
      selected = manifest.attempts.find(a => a.label === options.attempt);
      if (!selected) throw selectorError(manifest.attempts);
    } else {
      if (!context.interactive || !context.choose) throw selectorError(manifest.attempts);
      const id = await context.choose(`Choose an existing attempt in arena ${name}`, manifest.attempts.map(a => ({
        value: a.id, label: `${a.label} (${a.tool}; ${a.stage}) | ${safeDisplay(a.branch)} | ${safeDisplay(a.path)}`,
      })));
      if (id === null) { context.io.stdout("Cancelled.\n"); return 0; }
      selected = manifest.attempts.find(a => a.id === id);
      if (!selected) throw new Error("Invalid arena attempt selection; choose one of the displayed attempts.");
    }
    if (selected.stage !== "failed" && selected.failedStage !== undefined)
      throw new Error(`Arena attempt ${selected.label} has inconsistent lifecycle metadata; inspect and explicitly repair the record before recovery.`);
    if (selected.stage === "launch-running" ||
      (selected.stage === "failed" && selected.failedStage === undefined))
      throw new Error(`Arena attempt ${selected.label} has an uncertain interrupted stage; inspect processes and private metadata before explicit repair. Nothing was relaunched.`);
    if (selected.stage === "planned" || selected.failedStage === "creation" || selected.worktreeGitDir === null)
      throw new Error(`Arena attempt ${selected.label} was not completely created and bound; inspect Git worktrees and private metadata. Nothing was recreated.`);
    const launch = options.agent !== false && selected.tool !== "manual";
    if (launch && incompleteSetup(selected) && !options.setup)
      throw new Error(`Arena attempt ${selected.label} has incomplete setup. Deliberately rerun every hook with ${arenaResumeRetry(name, selected.label, true, options)}, or revisit with --no-agent.`);
    if (launch && !context.interactive)
      throw new Error("Arena agents require an interactive stdin/stdout terminal with CI disabled. Use --attempt <label> --no-agent for unattended revisit/setup.");
    const config = await services.loadConfig(repository);
    const editor = workflowEditor(config, null, options.editor);
    const participant = launch ? recoverArenaParticipant(manifest, selected.id, config) : null;
    if (participant?.command && !(await services.checkExecutable(participant.command.command)))
      throw new Error(`Arena agent executable is unavailable for ${selected.label}. Restore its recorded executable/PATH, or revisit with --no-agent.`);
    await services.validateArenaAttempt(repository, manifest, selected);
    const session = await services.openArenaForResume(repository, name, manifest);
    const active = session.manifest.attempts.find(a => a.id === selected.id)!;
    let stage: "setup" | "editor" | "agent" = "editor";
    let exitCode = 0, metadataHealthy = true, checkingBoundary = false;
    const save = async () => {
      metadataHealthy = false;
      await session.save();
      metadataHealthy = true;
    };
    const clearOutcome = () => { delete active.failedStage; delete active.exitCode; delete active.signal; };
    const boundary = async () => {
      checkingBoundary = true;
      const tree = await services.validateArenaAttempt(repository, session.manifest, active);
      await session.verifyTask();
      checkingBoundary = false;
      return tree;
    };
    // Editor-only revisits must not turn incomplete setup into ready or erase prior outcomes.
    const recordOutcome = launch || options.setup === true;
    try {
      context.io.stdout(`Reopening arena ${name}, attempt ${active.label}\n  ${safeDisplay(active.path)}\nWorkspace continuation; no automatic agent conversation restoration.\n`);
      if (options.setup) {
        stage = "setup";
        clearOutcome(); active.stage = "setup-running"; await save();
        await services.runSetup(repository, await boundary(), config, context.io);
        active.stage = "ready"; await save();
      }
      stage = "editor";
      if (launch) { clearOutcome(); active.stage = "launch-running"; await save(); }
      const opened = await services.launchEditor(await boundary(), { ...config, editor }, options.editor === false);
      if (opened.kind === "failed") throw new Error("editor startup");
      await boundary();
      if (launch) { active.stage = "ready"; await save(); }
      if (!participant) {
        context.io.stdout("Workspace retained; no agent launched.\n");
      } else {
        stage = "agent";
        const command = buildArenaAgentCommand(participant, session.taskPath);
        active.stage = "launch-running"; await save();
        const tree = await boundary();
        context.io.stdout("Starting assigned agent in this terminal; requested effort is not proof of effective runtime effort.\n");
        const result = await services.launchAgent(tree, command, {
          ...arenaEffortEnvironment(participant), TIMBER_TASK_FILE: session.taskPath,
          TIMBER_ARENA: name, TIMBER_ATTEMPT: active.label, TIMBER_REPO: repository.primaryWorktreeRoot,
          TIMBER_WORKTREE: tree.path, TIMBER_BRANCH: active.branch,
          TIMBER_WORKFLOW: undefined, TIMBER_TASK_ID: undefined,
        });
        if (result.kind !== "exited") throw new Error("agent startup");
        active.stage = "exited"; active.exitCode = result.exitCode; active.signal = result.signal;
        await save(); exitCode = result.exitCode;
        context.io.stdout(`Attempt ${active.label} exited with status ${exitCode}${result.signal ? ` (${result.signal})` : ""}. Workspace retained.\n`);
        if (exitCode !== 0) context.io.stderr(`error: Arena attempt ${active.label} ${result.signal ? `interrupted by ${result.signal}` : `exited with status ${exitCode}`}. Retry: ${arenaResumeRetry(name, active.label, false, options)}\n`);
      }
    } catch (error) {
      exitCode = 1;
      const detail = !metadataHealthy ? "metadata update failed; inspect private records before retrying"
        : checkingBoundary ? "Git identity, task integrity, or lock validation failed; inspect retained worktree/task/metadata"
        : error instanceof SetupFailure ? `post_create step ${error.step} failed (${safeDisplay(error.reason)})`
        : `${stage} startup/execution failed; fix prerequisites or executable/PATH`;
      let failureSaveFailed = false;
      if (recordOutcome && metadataHealthy) {
        active.stage = "failed"; active.failedStage = stage;
        try { await save(); } catch { failureSaveFailed = true; }
      }
      const persistenceDetail = failureSaveFailed ? "\nAdditionally, metadata update failed while recording the outcome; inspect the last persisted intent before retrying." : "";
      context.io.stderr(`error: Arena ${stage} failed for ${active.label}: ${detail}.${persistenceDetail}\nWorkspace and completed side effects retained at ${safeDisplay(active.path)}.\nRetry after inspection: ${arenaResumeRetry(name, active.label, stage === "setup", options)}\n`);
    } finally {
      try { await session.close(); }
      catch {
        exitCode = 1;
        context.io.stderr(`error: Arena invocation lock could not be released for ${active.label}; inspect private metadata before recovery. Workspace retained.\n`);
      }
    }
    return exitCode;
  };
}
