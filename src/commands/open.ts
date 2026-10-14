import { commandConfig } from "../guidance";
import { resolveAgentCommand, reportAgentResult } from "../agent";
import type { CommandHandlers, CommandServices } from "../services";
import type { Branch, OpenTarget, RepositoryContext, Worktree } from "../types";

import { FormattedError, failureWithRetry, jsonDisplay, safeDisplay } from "../display";

function exactSelector(target: OpenTarget): string {
  if (target.kind === "worktree") return target.worktree.path;
  return target.branch.kind === "local"
    ? target.branch.name
    : `${target.branch.remote}/${target.branch.name}`;
}

function targetIdentity(target: OpenTarget): string {
  return target.kind === "worktree"
    ? `worktree:${target.worktree.path}`
    : `branch:${target.branch.ref}`;
}

function remotePrefix(repository: RepositoryContext, branchName: string): string | null {
  return [...repository.remotes]
    .sort((left, right) => right.name.length - left.name.length)
    .find(remote => branchName.startsWith(`${remote.name}/`))?.name ?? null;
}

function targetLabel(target: OpenTarget): string {
  if (target.kind === "worktree") return `Worktree ${safeDisplay(target.worktree.path)}`;
  if (target.branch.kind === "local") {
    return `Local branch ${safeDisplay(target.branch.name)} (Git ref: ${safeDisplay(target.branch.ref)})`;
  }
  return `Remote branch ${safeDisplay(`${target.branch.remote}/${target.branch.name}`)} (Git ref: ${safeDisplay(target.branch.ref)})`;
}

interface DecoratedTarget {
  target: OpenTarget;
  selector: string;
  identity: string;
  shadowedBy: string | null;
  selectable: boolean;
  selectorShared: boolean;
}

function decorateCandidates(candidates: readonly OpenTarget[], repository: RepositoryContext): DecoratedTarget[] {
  const identities = new Map<string, OpenTarget>();
  for (const candidate of candidates) identities.set(targetIdentity(candidate), candidate);
  const decorated = [...identities.values()].map(target => {
    const selector = exactSelector(target);
    const identity = targetIdentity(target);
    const shadowedBy = target.kind === "branch" && target.branch.kind === "local"
      ? remotePrefix(repository, target.branch.name)
      : null;
    const selectable = target.kind === "worktree"
      || (target.branch.kind === "local" ? shadowedBy === null
        : remotePrefix(repository, selector) === target.branch.remote);
    return { target, selector, identity, shadowedBy, selectable, selectorShared: false };
  });
  const selectorCounts = new Map<string, number>();
  for (const item of decorated) selectorCounts.set(item.selector, (selectorCounts.get(item.selector) ?? 0) + 1);
  for (const item of decorated) item.selectorShared = (selectorCounts.get(item.selector) ?? 0) > 1;
  return decorated.sort((left, right) => left.selector < right.selector ? -1
    : left.selector > right.selector ? 1
      : left.identity < right.identity ? -1
        : left.identity > right.identity ? 1 : 0);
}

function formatCandidate(item: DecoratedTarget): string[] {
  const { target, selector, shadowedBy, selectable, selectorShared } = item;
  if (shadowedBy !== null && target.kind === "branch" && target.branch.kind === "local") {
    return [
      `  ${targetLabel(target)} — shadowed by known remote prefix ${safeDisplay(shadowedBy)}; this name is parsed as a remote selector.`,
      "    To open this local branch, create a Git worktree for it, then run timber open -- '<absolute-worktree-path>'.",
    ];
  }
  if (!selectable) {
    return [
      `  ${targetLabel(target)}`,
      `    Exact selector ${safeDisplay(selector)} does not identify this target; create a Git worktree for this ref, then open its absolute path.`,
    ];
  }
  if (selectorShared) return [`  ${targetLabel(target)}`, `    Exact selector: ${safeDisplay(selector)}`];
  return [`  ${safeDisplay(selector)}`];
}

function ambiguousMessage(input: string, candidates: readonly DecoratedTarget[]): string {
  const shown = candidates.slice(0, 5);
  const lines = shown.flatMap(formatCandidate);
  const more = candidates.length > shown.length
    ? `\n  Showing the first ${shown.length} of ${candidates.length} matches. Rerun in an interactive terminal to see all matches, or provide an exact branch or absolute worktree path.`
    : "";
  return `Input ${jsonDisplay(input)} matches ${candidates.length} targets. Did you mean one of these exact branches or paths?\n${lines.join("\n")}${more}`;
}

function interactiveAmbiguityMessage(input: string, candidates: readonly DecoratedTarget[]): string {
  const manual = candidates.some(candidate => !candidate.selectable)
    ? " Candidates marked for manual worktree/path selection cannot be opened by a unique exact selector."
    : "";
  return `Input ${jsonDisplay(input)} matches ${candidates.length} targets. Did you mean one of these branches or paths?${manual}`;
}

function branchRequest(branch: Branch) {
  return branch.kind === "local"
    ? { kind: "local" as const, branch }
    : { kind: "remote" as const, branch };
}

/** Resolve an existing target, create only a selected branch, then optionally start its editor. */
export function createOpenHandler(
  services: Pick<CommandServices,
    "discoverRepository" | "loadCommandConfig" | "resolveOpenTarget" | "createWorktree" |
    "runSetup" | "launchEditor" | "launchAgent">,
): CommandHandlers["open"] {
  return async (input, options, context) => {
    if (!input.trim()) throw new Error("Provide an existing branch or worktree path to open.");

    const repository = await services.discoverRepository(context.cwd);
    const config = commandConfig(await services.loadCommandConfig(repository), context);
    const agentCommand = resolveAgentCommand(config, options.agent, context.interactive === true);
    const resolution = await services.resolveOpenTarget(repository, input, config, { discoverRemote: true });

    if (resolution.kind === "not-found") {
      throw new Error(`No existing branch or worktree matches ${jsonDisplay(input)}. Check the exact branch or absolute worktree path.`);
    }
    let selected: OpenTarget;
    if (resolution.kind === "ambiguous") {
      const candidates = decorateCandidates(resolution.candidates, repository);
      if (!context.choose) {
        throw new FormattedError(ambiguousMessage(input, candidates));
      }
      const choiceValues = new Map(candidates.map(item => [item.identity, item]));
      const selection = await context.choose(
        interactiveAmbiguityMessage(input, candidates),
        candidates.map(item => ({
          value: item.identity,
          label: `${targetLabel(item.target)}${item.selectable ? "" : " — manual worktree/path selection required"}`,
        })),
      );
      if (selection === null) {
        context.io.stdout("Cancelled.\n");
        return;
      }
      const chosen = choiceValues.get(selection);
      if (!chosen) throw new Error("Invalid selection; choose one of the displayed targets.");
      if (!chosen.selectable) throw new FormattedError(formatCandidate(chosen).join("\n"));

      const verified = await services.resolveOpenTarget(repository, chosen.selector, config, { discoverRemote: true });
      if (verified.kind !== "found" || targetIdentity(verified.value) !== chosen.identity) {
        throw new Error("Selected target is no longer uniquely available; rerun timber open with an exact selector.");
      }
      selected = verified.value;
    } else {
      selected = resolution.value;
    }
    const created = selected.kind === "branch";
    let worktree: Worktree;
    if (selected.kind === "branch") {
      worktree = await services.createWorktree(repository, branchRequest(selected.branch), config);
    } else {
      worktree = selected.worktree;
    }

    if ((created || options.setup) && config.hooks?.postCreate.length) {
      await services.runSetup(repository, worktree, config, context.io);
    }

    const editor = await services.launchEditor(worktree, config, options.editor === false);
    if (editor.kind === "failed") {
      context.io.stderr(`error: ${failureWithRetry(editor.message, editor.retryCommand, worktree.path)}\n`);
    }

    context.io.stdout(`${created ? "Created" : "Opened existing"} worktree at ${safeDisplay(worktree.path)}\n`);
    if (editor.kind === "failed" || agentCommand === null) return;
    return reportAgentResult(await services.launchAgent(worktree, agentCommand), worktree, context.io);
  };
}
