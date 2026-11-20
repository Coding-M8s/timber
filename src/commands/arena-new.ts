import { arenaIdentity } from "../arena/source";
import { arenaRunBlock, arenaStartText, arenaResumeRetry } from "../arena/display";
import { terminalStyle as arenaStyle } from "../terminal-style";
import type { CommandContext } from "../services";
import { FormattedError, retryForDisplay, safeDisplay } from "../display";
import { workflowEditor } from "../workflow";
import type { ArenaServices } from "../arena/services";
import type {
  ArenaAttemptRecord,
  ArenaNewOptions,
  ArenaPlan,
  ArenaDraft,
} from "../arena/types";
import { arenaAgentLaunch } from "../arena/launch";
import { arenaNewReport, type ArenaNewReport } from "../arena/report";

function recovery(path: string, setup = false): string {
  const options = `${setup ? "--setup " : ""}--no-editor --no-agent`;
  return retryForDisplay(
    path,
    `timber open ${options} -- '${path.replaceAll("'", "'\\''")}'`,
    options,
  );
}
/** Prepare every attempt before owning the terminal for its sequential initial launches. */
export function createArenaNewHandler(services: ArenaServices) {
  return async (
    name: string,
    options: ArenaNewOptions,
    context: CommandContext,
  ): Promise<number> => {
    const out = arenaStyle(process.stdout.isTTY === true);
    const err = arenaStyle(process.stderr.isTTY === true);
    const identity = arenaIdentity(name, options.name);
    const repository = await services.discoverRepository(context.cwd);
    await context.machine?.repository(repository);
    const config = await services.loadConfig(repository);
    const editor = workflowEditor(config, null, options.editor);
    const input = await services.collectInput(options, config, context);
    if (input === null) {
      context.machine?.cancelled();
      context.io.stdout("Cancelled.\n");
      return 0;
    }
    let draft: ArenaDraft;
    try {
      const automatic =
        options.agent !== false &&
        input.participants.some((p) => p.command !== null);
      if (automatic && !context.interactive)
        throw new Error(
          "Automatic arena agents require an interactive terminal with CI disabled. Use --no-agent.",
        );
      if (automatic) {
        for (const participant of input.participants) {
          if (
            participant.command &&
            !(await services.checkExecutable(participant.command.command))
          )
            throw new Error(
              `Arena agent executable is unavailable for ${participant.label}. Fix the preset/PATH or use --no-agent.`,
            );
        }
      }
      const resolved = await services.resolveSource(repository, config, {
        ...(options.base === undefined ? {} : { base: options.base }),
        ...(identity.ticket === undefined ? {} : { ticket: identity.ticket }),
      });
      let source;
      if (resolved.kind === "not-found")
        throw new Error("No starting branch found; use --base <branch>.");
      if (resolved.kind === "ambiguous") {
        if (!context.interactive)
          throw new FormattedError(
            `Multiple arena starting branches (${resolved.candidates.length}; showing ${Math.min(5, resolved.candidates.length)}):\n${resolved.candidates
              .slice(0, 5)
              .map((c) => "  " + c.selector)
              .join(
                "\n",
              )}\nUse --base <exact-local-or-remote-ref> to select committed progress.`,
          );
        const selected = await (input.chooseSource
          ? input.chooseSource(resolved.candidates)
          : services.chooseSource(resolved.candidates));
        if (selected === null) {
          context.machine?.cancelled();
          context.io.stdout("Cancelled.\n");
          return 0;
        }
        source = resolved.candidates.find(
          (candidate) => candidate.selector === selected,
        );
        if (!source)
          throw new Error(
            "Arena source chooser returned an unknown selector; no workspace was created.",
          );
      } else source = resolved.value;
      draft = {
        ...(await services.planDraft(
          repository,
          config,
          identity.name,
          input.participants,
          source,
        )),
        ...(identity.ticket === undefined ? {} : { ticket: identity.ticket }),
      };
      if (
        context.interactive &&
        !(await services.confirmPlan(draft, input.review))
      ) {
        context.machine?.cancelled();
        context.io.stdout("Cancelled.\n");
        return 0;
      }
    } finally {
      input.close?.();
    }
    const base = await services.finalizeSource(
      repository,
      config,
      draft.source,
    );
    const plan: ArenaPlan = {
      name: draft.name,
      attempts: draft.attempts,
      base,
      source: {
        kind: draft.source.kind,
        selector: draft.source.selector,
        provenance: draft.source.provenance,
        ticketBranchMissing: draft.source.ticketBranchMissing,
        ...(draft.source.kind === "remote"
          ? { remote: draft.source.branch.remote }
          : {}),
      },
      ...(identity.ticket === undefined ? {} : { ticket: identity.ticket }),
    };
    name = identity.name;
    const session = await services.reserveArena(repository, plan, input.task);
    context.io.stdout(arenaStartText(plan, session.taskPath, out));
    let active: ArenaAttemptRecord | undefined;
    let stage: NonNullable<ArenaAttemptRecord["failedStage"]> = "creation";
    let exitCode = 0;
    let failure: ArenaNewReport["failure"] = null;
    try {
      context.io.stdout(out.heading("Preparing workspaces") + "\n");
      let created = 0;
      for (const attempt of plan.attempts) {
        active = session.manifest.attempts.find((a) => a.id === attempt.id)!;
        const worktree = await services.createWorktree(
          repository,
          {
            kind: "new",
            branch: attempt.branch,
            base,
            expectedPath: attempt.path,
          },
          config,
        );
        await session.bind(attempt.id, worktree);
        context.io.stdout(
          `  ${out.success(`[${++created}/${plan.attempts.length}] Created ${attempt.label}`)}\n    ${safeDisplay(worktree.path)}\n`,
        );
      }
      stage = "setup";
      context.io.stdout("\n" + out.heading(config.hooks?.postCreate.length ? "Running setup" : "Checking workspaces") + "\n");
      let ready = 0;
      for (const attempt of session.manifest.attempts) {
        active = attempt;
        if (config.hooks?.postCreate.length) {
          attempt.stage = "setup-running";
          await session.save();
          const worktree = await services.validateArenaAttempt(
            repository,
            session.manifest,
            attempt,
          );
          await services.runSetup(repository, worktree, config, context.io);
        } else {
          await services.validateArenaAttempt(
            repository,
            session.manifest,
            attempt,
          );
        }
        attempt.stage = "ready";
        await session.save();
        context.io.stdout(`  ${out.success(`[${++ready}/${plan.attempts.length}] Ready ${attempt.label}`)}\n`);
      }
      let run = 0;
      for (const participant of plan.attempts) {
        active = session.manifest.attempts.find(
          (a) => a.id === participant.id,
        )!;
        context.io.stdout("\n" + arenaRunBlock(participant, ++run, plan.attempts.length, out) + "\n");
        stage = "editor";
        active.stage = "launch-running";
        await session.save();
        const worktree = await services.validateArenaAttempt(
          repository,
          session.manifest,
          active,
        );
        const result = await services.launchEditor(
          worktree,
          { ...config, editor },
          options.editor === false,
        );
        if (result.kind === "failed") throw new Error("editor startup");
        active.stage = "ready";
        await session.save();
        const agent =
          options.agent === false
            ? null
            : arenaAgentLaunch(participant, {
                arena: name, attempt: active.label, taskPath: session.taskPath,
                repositoryRoot: repository.primaryWorktreeRoot, worktreePath: worktree.path, branch: active.branch,
              });
        if (agent === null) {
          context.io.stdout("  Ready for manual use; no agent launched.\n");
          continue;
        }
        stage = "agent";
        await session.verifyTask();
        active.stage = "launch-running";
        await session.save();
        const agentWorktree = await services.validateArenaAttempt(
          repository,
          session.manifest,
          active,
        );
        context.io.stdout(
          "\n  Starting agent in this terminal. Exit it normally to continue.\n\n",
        );
        const launched = await services.launchAgent(agentWorktree, agent.command, agent.environment);
        if (launched.kind === "failed" || launched.kind === "skipped")
          throw new Error("agent startup");
        active.stage = "exited";
        active.exitCode = launched.exitCode;
        active.signal = launched.signal;
        await session.save();
        context.io.stdout(`\n${launched.exitCode === 0 ? out.success(`${active.label} exited (status 0).`) : out.warning(`${active.label} exited (status ${launched.exitCode}).`)}\n`);
        if (launched.exitCode !== 0) {
          exitCode = launched.exitCode;
          context.io.stderr(
            `\n${err.error(`error: Arena attempt ${active.label} ${launched.signal ? `interrupted by ${launched.signal}` : `exited with status ${exitCode}`}`)}\nAll workspaces retained. Later attempts were not launched.\n\nReopen with:\n  ${recovery(active.path)}\nResume assigned agent with:\n  ${arenaResumeRetry(name, active.label, false, options)}\n`,
          );
          break;
        }
      }
      if (exitCode === 0)
        context.io.stdout(
          `\n${out.success(`Arena ${name} prepared; ${plan.attempts.length} workspaces retained.`)}\nManual attempts and --no-agent attempts are ready to use with the private task snapshot.\n`,
        );
    } catch {
      exitCode = 1;
      failure = { stage, attempt: active?.label ?? null };
      if (active) {
        active.stage = "failed";
        active.failedStage = stage;
        try {
          await session.save();
        } catch {
          /* The earlier persisted intent remains the recovery record. */
        }
      }
      context.io.stderr([
        "", err.error(`error: Arena ${stage} failed${active ? ` for ${active.label}` : ""}`),
        "All completed workspaces, refs, and setup files retained.",
        "Inspect timber ls and private arena metadata before retrying.",
        ...(active ? [
          "", "Planned location:", `  ${safeDisplay(active.path)}`,
          ...(stage === "creation"
            ? ["Inspect any partial Git creation; no automatic rollback occurred."]
            : [stage === "setup" ? "Deliberately rerun all setup steps, then resume with:" : "Resume assigned agent with:", `  ${arenaResumeRetry(name, active.label, stage === "setup", options)}`, "Add --no-agent --no-editor to revisit without launching tools."]),
        ] : []),
        "", "Resume reuses the recorded configuration and private task snapshot; missing identities and uncertain locks require inspection.", "",
      ].join("\n"));
    } finally {
      try {
        await session.close();
      } catch {
        exitCode = 1;
        context.io.stderr(
          err.error("error: Arena invocation lock could not be released; workspaces retained.") + "\nInspect private arena metadata before recovery.\n",
        );
      }
      context.machine?.arenaNew(arenaNewReport(session.manifest, failure));
    }
    return exitCode;
  };
}
