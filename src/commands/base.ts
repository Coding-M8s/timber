import type { BaseAssociationRead } from "../git/base-metadata";
import { isOperationFailure } from "../git/rebase";
import { jsonDisplay, safeDisplay } from "../display";
import type { BaseOptions, CommandHandlers, CommandServices } from "../services";
import { selectRegisteredWorktree } from "./select-worktree";

/** Observed facts for the machine record; filled in as each one is verified. */
export interface BaseChangeReport {
  /** What was asked for. */
  action: "set" | "clear";
  /** "refused" until the change is saved; "failed" when Git, the network or metadata broke. */
  result: "set" | "cleared" | "refused" | "failed";
  /** Saved base before the command, in the `ls --json` shape; null until read. */
  previous: BaseAssociationRead | null;
  /** Saved base read back after the command; equals `previous` when nothing changed. */
  current: BaseAssociationRead | null;
}

/** Until a change is saved, a stop is a refusal that changed nothing. */
export function createBaseChangeReport(action: BaseChangeReport["action"]): BaseChangeReport {
  return { action, result: "refused", previous: null, current: null };
}

function describe(base: BaseAssociationRead): string {
  if (base.kind === "assigned") return safeDisplay(base.ref.replace(/^refs\/remotes\//u, ""));
  return base.kind === "unassigned" ? "none" : `invalid (${base.reason})`;
}

/** Write only Timber's saved base for a registered worktree; never touches refs, the index or files. */
export function createBaseHandler(
  services: Pick<CommandServices, "discoverRepository" | "loadConfig" | "resolveOpenTarget"
    | "readBaseAssociation" | "writeBaseAssociation" | "clearBaseAssociation" | "selectBaseRef">,
): NonNullable<CommandHandlers["base"]> {
  return async (input, options: BaseOptions, context) => {
    const report = createBaseChangeReport(options.clear === true ? "clear" : "set");
    context.machine?.baseChange(report);
    if (!input.trim()) throw new Error("Provide an existing branch or absolute worktree path whose base to change.");
    const repository = await services.discoverRepository(context.cwd);
    await context.machine?.repository(repository);
    const config = await services.loadConfig(repository);
    // Never interactive: ambiguous input gets exact-selection guidance, not a chooser.
    const { choose: _choose, ...withoutChooser } = context;
    const selected = await selectRegisteredWorktree(services, repository, config, input, withoutChooser,
      { command: "base", past: "changed", rerun: "timber base" },
      // Only the machine record snapshots status, for the worktree's verified identity.
      { inspectStatus: context.machine !== undefined });
    if (selected === null) throw new Error("No worktree was selected; the base was not changed.");
    await context.machine?.worktree(selected, false);
    const previous = await services.readBaseAssociation(repository, selected);
    report.previous = previous;
    report.current = previous;
    try {
      if (previous.kind === "invalid" && previous.reason !== "stale") {
        throw new Error("Saved base metadata is malformed or unreadable; inspect the worktree's private Git metadata before changing its base.");
      }
      let save: () => Promise<void>;
      if (options.clear === true) {
        save = () => services.clearBaseAssociation(repository, selected);
      } else {
        const wording = { flag: "--set", stopped: "The base was not changed." };
        const { ref } = await services.selectBaseRef(repository, config, options.set, selected.path, selected.branch, wording);
        save = () => services.writeBaseAssociation(repository, selected, ref);
      }
      try { await save(); }
      catch (error) { report.result = "failed"; throw error; }
    } catch (error) {
      if (isOperationFailure(error)) report.result = "failed";
      report.current = await services.readBaseAssociation(repository, selected);
      throw error;
    }
    report.current = await services.readBaseAssociation(repository, selected);
    report.result = options.clear === true ? "cleared" : "set";
    await context.machine?.refreshMetadata();
    context.io.stdout(options.clear === true
      ? `Cleared the saved base of ${jsonDisplay(selected.path)} (was ${describe(previous)}).\n`
      : `Saved base ${describe(report.current)} for ${jsonDisplay(selected.path)} (was ${describe(previous)}).\n`);
    return 0;
  };
}
