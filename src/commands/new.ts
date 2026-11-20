import { handOffToApp } from "../app-handoff";
import { reportAgentResult } from "../agent";
import { FormattedError, failureWithRetry, retryNamingWorkflow, safeDisplay, shellQuoteForDisplay, workflowRetryFlag } from "../display";
import type { CommandContext, CommandHandlers, CommandServices, OpenOptions } from "../services";
import { decideNewBranchCollision, remoteSelector } from "../git/new-collision";
import { JiraLookupFailure } from "../jira/client";
import { finishWordAt, shortenAtWord } from "../branch-shorten";
import { validateNewBranchName } from "../git/branches";
import { generateTicketBranch, isJiraTicketKey } from "../jira/branch";
import type { JiraTicket } from "../types";
import { LinearLookupFailure } from "../linear/client";
import { GithubLookupFailure } from "../github/client";
import { resolveIssueInput } from "../issue-input";
import { resolveWorkflowAgent, selectWorkflow, workflowEditor } from "../workflow";
import { reportSkippedSetup } from "../hooks";
import { issueSelector, type IssueLink } from "../git/issue-link";

export type NewServices = Pick<CommandServices,
  "discoverRepository" | "loadConfig" | "resolveBase" | "resolveJiraTicket" | "findJiraSuggestions" |
  "resolveGithubRepository" | "resolveGithubTicket" | "resolveLinearTicket" | "inspectNewBranchCollision" |
  "createWorktree" | "writeBaseAssociation" | "writeIssueLink" | "runSetup" | "launchEditor" | "launchAgent" | "launchEditorTerminals"> & {
  /** The `open` handler; the only way `new` may materialize an existing remote branch. */
  openExisting?: CommandHandlers["open"];
};

const terminalControl = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const sentenceSeparators: ReadonlySet<string> = new Set(["-", "_", ".", "/"]);

interface GeneratedName {
  name: string;
  /** Present only when a configured limit shortened the generated name. */
  original?: string;
  /** The name with the word cut by the limit completed; longer than the limit. */
  finished?: string;
}

function normalizeBranchInput(branch: string, maximum?: number): GeneratedName {
  if (terminalControl.test(branch)) {
    throw new Error(`Invalid branch name: ${safeDisplay(branch)}`);
  }

  const normalized = branch.includes(" ")
    ? branch.replace(/^ +| +$/gu, "").toLowerCase().replace(/ +/gu, "-")
    : branch;
  if (branch.includes(" ") && maximum !== undefined) {
    const characters = Array.from(normalized);
    if (characters.length > maximum) {
      const name = shortenAtWord(characters, maximum, sentenceSeparators);
      const finished = finishWordAt(characters, maximum, sentenceSeparators);
      return { name, original: normalized, ...(finished !== undefined && finished !== name ? { finished } : {}) };
    }
  }
  if (normalized.length === 0) throw new Error("Invalid branch name: branch name must not be blank.");
  return { name: normalized };
}

/**
 * When a limit shortened a generated name, let an interactive user accept the
 * proposal or type a replacement. Returns null when the user cancels.
 */
async function confirmShortenedName(
  generated: GeneratedName,
  maximum: number,
  requiredPrefix: string | undefined,
  repository: Parameters<typeof validateNewBranchName>[0],
  context: CommandContext,
): Promise<string | null> {
  if (generated.original === undefined || context.choose === undefined || context.ask === undefined) {
    return generated.name;
  }
  const accept = "accept";
  const finish = "finish";
  const custom = "custom";
  const finished = generated.finished;
  const choice = await context.choose(
    `Generated branch name exceeds max_generated_branch_name_length (${maximum}).\n`
    + `Generated: ${safeDisplay(generated.original)}\nShortened: ${safeDisplay(generated.name)}`,
    [
      { value: accept, label: `Use ${safeDisplay(generated.name)}`, default: true },
      ...(finished === undefined ? [] : [{
        value: finish,
        label: `Finish the cut word: ${safeDisplay(finished)} (${Array.from(finished).length} characters, over the limit)`,
      }]),
      { value: custom, label: "Enter a different branch name" },
    ],
  );
  if (choice === null) return null;
  if (choice === finish && finished !== undefined) {
    const problem = await replacementProblem(finished, Infinity, requiredPrefix, repository);
    if (problem === undefined) return finished;
    context.io.stdout(`${problem}\n`);
  } else if (choice !== custom) return generated.name;
  while (true) {
    const answer = await context.ask(`Branch name (at most ${maximum} characters${requiredPrefix ? `, starting with ${requiredPrefix}` : ""}): `);
    if (answer === null) return null;
    const problem = await replacementProblem(answer, maximum, requiredPrefix, repository);
    if (problem === undefined) return answer;
    context.io.stdout(`${problem}\n`);
  }
}

async function replacementProblem(
  name: string,
  maximum: number,
  requiredPrefix: string | undefined,
  repository: Parameters<typeof validateNewBranchName>[0],
): Promise<string | undefined> {
  if (name.trim().length === 0) return "Branch name must not be blank.";
  if (terminalControl.test(name)) return "Branch name must not contain control characters.";
  if (Array.from(name).length > maximum) return `Branch name must be at most ${maximum} characters.`;
  if (requiredPrefix !== undefined && !name.startsWith(requiredPrefix)) {
    return `Branch name must start with ${requiredPrefix}.`;
  }
  try {
    await validateNewBranchName(repository, name);
  } catch {
    return `Invalid branch name: ${safeDisplay(name)}`;
  }
  return undefined;
}

export function createNewHandler(services: NewServices): CommandHandlers["new"] {
  return async (branch, options, context) => {
    resolveIssueInput(branch, {});
    const branchInput = normalizeBranchInput(branch).name;
    const repository = await services.discoverRepository(context.cwd);
    await context.machine?.repository(repository);
    const config = await services.loadConfig(repository);
    const input = resolveIssueInput(branch, config);
    if (options.remote !== undefined && input.kind !== "github") {
      throw new Error("The --remote option requires a GitHub issue selector or a number with GitHub selected as the default tracker.");
    }
    if (options.allowClosed !== undefined && input.kind === "literal") {
      throw new Error("The -c option requires an issue selector or an input matching the default tracker.");
    }
    const workflow = selectWorkflow(config, options.workflow ?? null);
    const selectedEditor = workflowEditor(config, workflow, options.editor);
    const editorConfig = selectedEditor === config.editor ? config : { ...config, editor: selectedEditor };
    const canHostAgent = context.interactive === true
      || (selectedEditor?.enabled === true && selectedEditor.integration === "orca");
    const agentCommand = resolveWorkflowAgent(config, workflow, options.agent, canHostAgent, true);
    const base = await services.resolveBase(repository, config, options.base);
    const jiraConfig = config.jira;
    let ticket: { key: string; title: string; url: string } | undefined;
    try {
      if (input.kind === "github") {
        const issueRepository = await services.resolveGithubRepository(repository, config, options.remote);
        ticket = await services.resolveGithubTicket(issueRepository, input.number, options.allowClosed === true);
      } else if (input.kind === "linear") {
        ticket = await services.resolveLinearTicket(input.key, options.allowClosed === true);
      } else if (input.kind === "jira") {
        if (!jiraConfig) throw new Error("Jira site settings are missing or disabled. Configure Jira with timber setup before looking up tickets.");
        try {
          ticket = await services.resolveJiraTicket(jiraConfig, input.key, options.allowClosed === true);
        } catch (error) {
          if (input.origin !== "legacy" || options.allowClosed === true) throw error;
          if (!(error instanceof JiraLookupFailure) || error.reason === undefined) throw error;

          let suggestions: readonly JiraTicket[];
          try {
            suggestions = await services.findJiraSuggestions(jiraConfig, branch);
          } catch {
            throw new Error(`${error.message} Jira suggestions could not be loaded; no workspace was created.`);
          }
          if (suggestions.length === 0) throw error;
          validateSuggestions(branch, suggestions);

          const choices = suggestions.map(suggestion => ({
            value: suggestion.key,
            label: `${suggestion.key} - ${safeTitle(suggestion.title)}`,
          }));
          if (context.choose === undefined) throw noChooserFailure(error.message, branch, suggestions);

          const selected = await context.choose(`${error.message}\nDid you mean one of these?`, choices);
          if (selected === null) {
            context.machine?.cancelled();
            context.io.stdout("Cancelled.\n");
            return;
          }
          const chosen = suggestions.find(suggestion => suggestion.key === selected);
          if (chosen === undefined) throw new Error("Jira chooser returned an unknown suggestion; no workspace was created.");

          // The search result can be stale; the selected exact issue is authoritative.
          ticket = await services.resolveJiraTicket(jiraConfig, chosen.key);
        }
      }
    } catch (error) {
      const missing = (input.kind === "github" && error instanceof GithubLookupFailure)
        || (input.kind === "linear" && error instanceof LinearLookupFailure)
        || (input.kind === "jira" && error instanceof JiraLookupFailure);
      if (input.kind === "literal" || input.origin !== "default" || !missing || error.reason !== "not-found") throw error;
      const provider = { github: "GitHub", linear: "Linear", jira: "Jira" }[input.kind];
      context.io.stdout(`${provider} ticket ${safeDisplay(branch)} was not found. Creating literal branch ${safeDisplay(branchInput)}.\n`);
    }
    const maximum = config.maxGeneratedBranchNameLength;
    const generated: GeneratedName = ticket
      ? generateTicketBranch(ticket.key, ticket.title, maximum)
      : normalizeBranchInput(branch, maximum);
    const selectedName = maximum === undefined ? generated.name
      : await confirmShortenedName(generated, maximum, ticket ? `${ticket.key}-` : undefined, repository, context);
    if (selectedName === null) {
      context.machine?.cancelled();
      context.io.stdout("Cancelled.\n");
      return;
    }
    const selectedBranch = selectedName;
    const decision = decideNewBranchCollision(
      await services.inspectNewBranchCollision(repository, selectedBranch, config),
      { explicitBase: options.base, interactive: context.choose !== undefined },
    );
    if (decision.kind === "refuse") throw new FormattedError(decision.message);
    if (decision.kind === "offer-open") {
      const cancel = "\u0000cancel";
      const chosen = await context.choose!(decision.prompt, [
        ...decision.matches.map(match => ({
          value: match.remote,
          label: `Open existing branch${decision.matches.length > 1 ? ` ${match.selector} (${match.commit.slice(0, 12)})` : ""}`,
        })),
        { value: cancel, label: "Cancel", default: true },
      ]);
      if (chosen === null || chosen === cancel) {
        context.machine?.cancelled();
        context.io.stdout("Cancelled.\n");
        return;
      }
      const match = decision.matches.find(candidate => candidate.remote === chosen);
      if (match === undefined) throw new Error("Chooser returned an unknown remote; no worktree was created.");
      // Re-inspect: the remote can change while the prompt is open. Never fall back to creation.
      const again = await services.inspectNewBranchCollision(repository, selectedBranch, config);
      const current = again.remotes.find(remote => remote.remote === match.remote);
      if (again.local !== null || current === undefined || current.live.kind !== "present" || current.live.commit !== match.commit) {
        throw new FormattedError(`${match.selector} changed or disappeared after selection. No worktree was created. Rerun timber new or timber open.`);
      }
      // Carry the resolved ticket so the opened worktree keeps its issue link. open looks
      // GitHub issues up in the default issue repository, so a GitHub ticket chosen with
      // --remote is not passed on and the user is told how to link it.
      const issue = ticket === undefined || input.kind === "literal" ? undefined
        : issueSelector({ tracker: input.kind, key: input.kind === "github" ? String(input.number) : ticket.key });
      const skipIssue = issue !== undefined && input.kind === "github" && options.remote !== undefined;
      const openOptions: OpenOptions = {
        ...(issue === undefined || skipIssue ? {} : { issue }),
        ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
        ...(options.editor === undefined ? {} : { editor: options.editor }),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        ...(options.setup === false ? { setup: false } : {}),
      };
      if (services.openExisting === undefined) throw new Error("Opening an existing branch is unavailable in this build; no worktree was created.");
      const status = await services.openExisting(remoteSelector(match.remote, selectedBranch), openOptions, context);
      if (skipIssue) {
        context.io.stdout(`Issue ${issue} was not linked: timber open links GitHub issues from the default issue repository, not the one --remote selected.\n`);
      }
      // A failed handoff, like a failed agent, sets the exit status.
      return status;
    }
    const worktree = await services.createWorktree(repository, { kind: "new", branch: selectedBranch, base }, config);
    await context.machine?.worktree(worktree, true);
    try {
      await services.writeBaseAssociation(repository, worktree, base.ref);
    } catch {
      throw new FormattedError(`Could not save the base association; created worktree retained at ${safeDisplay(worktree.path)}. Setup and launch have not run. Inspect its private Git metadata and permissions, then retry with:\ntimber rebase --base ${shellQuoteForDisplay(base.ref)} -- ${shellQuoteForDisplay(worktree.path)}`);
    }
    if (ticket && input.kind !== "literal") {
      const link: IssueLink = { tracker: input.kind, key: input.kind === "github" ? String(input.number) : ticket.key, url: ticket.url };
      try {
        await services.writeIssueLink(repository, worktree, link);
      } catch {
        await context.machine?.refreshMetadata();
        throw new FormattedError(`Could not save the issue link; created worktree retained at ${safeDisplay(worktree.path)}. Setup and launch have not run. Inspect its private Git metadata and permissions, then retry with:\ntimber open --issue ${shellQuoteForDisplay(issueSelector(link))} --no-editor --no-agent -- ${shellQuoteForDisplay(worktree.path)}`);
      }
    }
    await context.machine?.refreshMetadata();
    context.io.stdout(`Created ${safeDisplay(selectedBranch)} at ${safeDisplay(worktree.path)}\n`);
    if (ticket) {
      const provider = input.kind === "github" ? "GitHub" : input.kind === "linear" ? "Linear" : "Jira";
      context.io.stdout(`${provider}: ${ticket.url}\n${safeDisplay(ticket.key)} - ${safeDisplay(ticket.title)}\n`);
    }

    const hasSetup = Boolean(config.hooks?.postCreate.length || workflow?.postCreate.length);
    if (editorConfig.editor?.enabled && editorConfig.editor.integration === "orca") {
      if (!services.launchEditorTerminals) throw new Error("Orca terminal integration is unavailable; workspace retained.");
      reportSkippedSetup(hasSetup, options.setup === false, worktree.path, options.workflow, context);
      await services.launchEditorTerminals({ repository, worktree, config: editorConfig, agent: agentCommand, setup: options.setup !== false,
        ...(options.workflow === undefined ? {} : { workflowName: options.workflow }),
        ...(workflow === null ? {} : { workflowScripts: workflow.postCreate }) }, context.io);
      return;
    }

    if (hasSetup && options.setup !== false) {
      await services.runSetup(repository, worktree, config, context.io,
        options.workflow, workflow?.postCreate);
    }
    reportSkippedSetup(hasSetup, options.setup === false, worktree.path, options.workflow, context);

    const editor = await services.launchEditor(worktree, editorConfig, options.editor === false);
    if (editor.kind === "failed") {
      const failure = retryNamingWorkflow(editor, options.workflow);
      throw new Error(failureWithRetry(failure.message, failure.retryCommand, worktree.path, `--editor${workflowRetryFlag(options.workflow)}`));
    }
    // In the Timber app, the app opens the new worktree's session: the agent, or a shell.
    if (context.appHandoff) return handOffToApp(context.appHandoff, "new", repository, worktree, agentCommand !== null, context.io);
    if (agentCommand === null) return;
    return reportAgentResult(await services.launchAgent(worktree, agentCommand), worktree, context.io, options.workflow);
  };
}

function validateSuggestions(requestedKey: string, suggestions: readonly JiraTicket[]): void {
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    if (!isJiraTicketKey(suggestion.key) || suggestion.key === requestedKey
      || !suggestion.key.startsWith(requestedKey) || suggestion.title.trim().length === 0
      || seen.has(suggestion.key)) {
      throw new Error("Jira suggestions could not be used safely; no workspace was created.");
    }
    seen.add(suggestion.key);
  }
}

function safeTitle(title: string): string {
  return title.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, character => {
    return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
  });
}

function noChooserFailure(
  originalFailure: string,
  requestedKey: string,
  suggestions: readonly JiraTicket[],
): Error {
  const visible = suggestions.slice(0, 5)
    .map(suggestion => `  ${suggestion.key} - ${safeTitle(suggestion.title)}`)
    .join("\n");
  const count = suggestions.length;
  const shown = Math.min(count, 5);
  return new FormattedError(
    `${originalFailure}\nNo interactive chooser is available. ${count} unfinished Jira prefix matches for ${requestedKey} (showing ${shown}):\n${visible}\n` +
    "Run `timber new <candidate-key>` explicitly, or rerun in an interactive terminal to choose one.",
  );
}
