import { handOffToApp } from "../app-handoff";
import { reportAgentResult, resolveAgentCommand } from "../agent";
import type { CommandHandlers, CommandServices } from "../services";
import type { Branch, OpenTarget, RepositoryContext, Worktree } from "../types";

import { FormattedError, failureWithRetry, jsonDisplay, retryNamingWorkflow, safeDisplay, workflowRetryFlag } from "../display";
import { resolveWorkflowAgent, selectWorkflow, workflowEditor } from "../workflow";
import { reportSkippedSetup } from "../hooks";
import { issueSelector, type IssueLink } from "../git/issue-link";
import { linkedMessage, parseIssueOption, resolveIssueOption, type IssueOptionServices } from "./issue-option";

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
      `  ${targetLabel(target)} - shadowed by known remote prefix ${safeDisplay(shadowedBy)}; this name is parsed as a remote selector.`,
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
    "discoverRepository" | "loadConfig" | "resolveOpenTarget" | "createWorktree" |
    "runSetup" | "launchEditor" | "launchAgent" | "launchEditorTerminals">
    & Partial<IssueOptionServices & Pick<CommandServices, "writeIssueLink">>,
): CommandHandlers["open"] {
  const issueServices = (): IssueOptionServices & Pick<CommandServices, "writeIssueLink"> => {
    const { resolveGithubRepository, resolveGithubTicket, resolveLinearTicket, resolveJiraTicket, readIssueLink, writeIssueLink } = services;
    if (!resolveGithubRepository || !resolveGithubTicket || !resolveLinearTicket || !resolveJiraTicket || !readIssueLink || !writeIssueLink) {
      throw new Error("Issue linking is unavailable in this build; nothing was changed.");
    }
    return { resolveGithubRepository, resolveGithubTicket, resolveLinearTicket, resolveJiraTicket, readIssueLink, writeIssueLink };
  };
  return async (input, options, context) => {
    if (!input.trim()) throw new Error("Provide an existing branch or worktree path to open.");

    const repository = await services.discoverRepository(context.cwd);
    await context.machine?.repository(repository);
    const config = await services.loadConfig(repository);
    if (options.replaceIssue === true && options.issue === undefined) {
      throw new Error("--replace-issue requires --issue <selector>.");
    }
    const requestedIssue = options.issue === undefined ? null : parseIssueOption(options.issue, config);
    const issues = requestedIssue === null ? null : issueServices();
    if (options.workflow !== undefined) {
      const requested = selectWorkflow(config, options.workflow);
      const selectedEditor = workflowEditor(config, requested, options.editor);
      const canHostAgent = context.interactive === true
        || (selectedEditor?.enabled === true && selectedEditor.integration === "orca");
      resolveWorkflowAgent(config, requested, options.agent, canHostAgent, true);
    } else if (options.agent === true && config.workflows === undefined) {
      const selectedEditor = workflowEditor(config, null, options.editor);
      const canHostAgent = context.interactive === true
        || (selectedEditor?.enabled === true && selectedEditor.integration === "orca");
      resolveAgentCommand(config, true, canHostAgent);
    }
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
          label: `${targetLabel(item.target)}${item.selectable ? "" : " - manual worktree/path selection required"}`,
        })),
      );
      if (selection === null) {
        context.machine?.cancelled();
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
    if (selected.kind === "worktree") await context.machine?.worktree(selected.worktree, false);
    // A workflow applies only to the invocation that names it; nothing is remembered.
    const workflowName = options.workflow ?? null;
    const workflow = selectWorkflow(config, workflowName);
    const selectedEditor = workflowEditor(config, workflow, options.editor);
    const editorConfig = selectedEditor === config.editor ? config : { ...config, editor: selectedEditor };
    const agentChoice = !created && selectedEditor?.enabled && options.agent !== true ? false : options.agent;
    const canHostAgent = context.interactive === true
      || (selectedEditor?.enabled === true && selectedEditor.integration === "orca");
    const agentCommand = resolveWorkflowAgent(config, workflow, agentChoice, canHostAgent, created);
    // Refuse a conflicting link and finish the tracker lookup before creating anything.
    const link: IssueLink | null = requestedIssue === null ? null
      : await resolveIssueOption(issues!, repository, config, requestedIssue,
        selected.kind === "worktree" ? selected.worktree : null, options.replaceIssue === true);
    let worktree: Worktree;
    if (selected.kind === "branch") {
      worktree = await services.createWorktree(repository, branchRequest(selected.branch), config);
      await context.machine?.worktree(worktree, true);
    } else {
      worktree = selected.worktree;
    }
    if (link !== null) {
      try {
        await issues!.writeIssueLink(repository, worktree, link, { replace: options.replaceIssue === true });
      } catch (error) {
        if (!created) throw error;
        throw new FormattedError(`${error instanceof Error ? error.message : "Could not save the issue link."}\nCreated worktree retained at ${safeDisplay(worktree.path)}. Setup and launch have not run.`);
      } finally {
        await context.machine?.refreshMetadata();
      }
      context.io.stdout(linkedMessage(link));
    } else if (requestedIssue !== null) {
      context.io.stdout(`Already linked to ${issueSelector(requestedIssue)}; nothing was changed.\n`);
    }

    // --no-setup wins over creation; --setup reruns setup on a worktree that already existed.
    const runsSetup = options.setup === true || (created && options.setup !== false);
    const hasSetup = Boolean(config.hooks?.postCreate.length || workflow?.postCreate.length);
    if (editorConfig.editor?.enabled && editorConfig.editor.integration === "orca") {
      context.io.stdout(`${created ? "Created" : "Opened existing"} worktree at ${safeDisplay(worktree.path)}\n`);
      if (!services.launchEditorTerminals) throw new Error("Orca terminal integration is unavailable; workspace retained.");
      reportSkippedSetup(created && hasSetup, options.setup === false, worktree.path, workflowName, context);
      await services.launchEditorTerminals({ repository, worktree, config: editorConfig, agent: agentCommand,
        setup: runsSetup,
        ...(workflowName === null ? {} : { workflowName }),
        ...(workflow === null ? {} : { workflowScripts: workflow.postCreate }) }, context.io);
      return;
    }

    if (runsSetup && hasSetup) {
      await services.runSetup(repository, worktree, config, context.io,
        workflowName ?? undefined, workflow?.postCreate);
    }
    reportSkippedSetup(created && hasSetup, options.setup === false, worktree.path, workflowName, context);

    const editor = await services.launchEditor(worktree, editorConfig, options.editor === false);
    if (editor.kind === "failed") {
      const failure = retryNamingWorkflow(editor, workflowName);
      context.io.stderr(`error: ${failureWithRetry(failure.message, failure.retryCommand, worktree.path, `--editor${workflowRetryFlag(workflowName)}`)}\n`);
    }

    context.io.stdout(`${created ? "Created" : "Opened existing"} worktree at ${safeDisplay(worktree.path)}\n`);
    if (editor.kind === "failed") return;
    // Only a worktree this run created moves to the Timber app; opening an existing one stays here.
    if (created && context.appHandoff) return handOffToApp(context.appHandoff, "open", repository, worktree, agentCommand !== null, context.io);
    if (agentCommand === null) return;
    return reportAgentResult(await services.launchAgent(worktree, agentCommand), worktree, context.io, workflowName);
  };
}
