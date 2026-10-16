import { reportAgentResult } from "../agent";
import { FormattedError, failureWithRetry, safeDisplay } from "../display";
import type { CommandHandlers, CommandServices } from "../services";
import { JiraLookupFailure } from "../jira/client";
import { isJiraTicketKey, jiraBranchName } from "../jira/branch";
import type { JiraTicket } from "../types";
import { resolveWorkflowAgent, selectWorkflow, workflowEditor } from "../workflow";

type NewServices = Pick<CommandServices,
  "discoverRepository" | "loadConfig" | "resolveBase" | "resolveJiraTicket" | "findJiraSuggestions" |
  "createWorktree" | "writeWorkflowAssociation" | "runSetup" | "launchEditor" | "launchAgent" | "launchEditorTerminals">;

const terminalControl = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function normalizeBranchInput(branch: string): string {
  if (terminalControl.test(branch)) {
    throw new Error(`Invalid branch name: ${safeDisplay(branch)}`);
  }

  const normalized = branch.includes(" ")
    ? branch.replace(/^ +| +$/gu, "").toLowerCase().replace(/ +/gu, "-")
    : branch;
  if (normalized.length === 0) throw new Error("Invalid branch name: branch name must not be blank.");
  return normalized;
}

/** Create a new workspace, then optionally start its configured editor. */
export function createNewHandler(services: NewServices): CommandHandlers["new"] {
  return async (branch, options, context) => {
    const branchInput = normalizeBranchInput(branch);
    const repository = await services.discoverRepository(context.cwd);
    const config = await services.loadConfig(repository);
    const workflow = selectWorkflow(config, options.workflow ?? null);
    const selectedEditor = workflowEditor(config, workflow, options.editor);
    const editorConfig = selectedEditor === config.editor ? config : { ...config, editor: selectedEditor };
    const agentCommand = resolveWorkflowAgent(config, workflow, options.agent, context.interactive === true, true);
    const base = await services.resolveBase(repository, config, options.base);
    const jiraConfig = config.jira;
    let ticket: JiraTicket | undefined;
    if (jiraConfig && isJiraTicketKey(branch)) {
      try {
        ticket = await services.resolveJiraTicket(jiraConfig, branch);
      } catch (error) {
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
          label: `${suggestion.key} — ${safeTitle(suggestion.title)}`,
        }));
        if (context.choose === undefined) throw noChooserFailure(error.message, branch, suggestions);

        const selected = await context.choose(`${error.message}\nDid you mean one of these?`, choices);
        if (selected === null) {
          context.io.stdout("Cancelled.\n");
          return;
        }
        const chosen = suggestions.find(suggestion => suggestion.key === selected);
        if (chosen === undefined) throw new Error("Jira chooser returned an unknown suggestion; no workspace was created.");

        // The search result can be stale; the selected exact issue is authoritative.
        ticket = await services.resolveJiraTicket(jiraConfig, chosen.key);
      }
    }
    const selectedBranch = ticket ? jiraBranchName(ticket.key, ticket.title) : branchInput;
    const worktree = await services.createWorktree(repository, { kind: "new", branch: selectedBranch, base }, config);
    if (options.workflow) await services.writeWorkflowAssociation(repository, worktree, options.workflow);
    context.io.stdout(`Created ${safeDisplay(selectedBranch)} at ${safeDisplay(worktree.path)}\n`);
    if (ticket) context.io.stdout(`Jira: ${ticket.url}\n`);

    if (editorConfig.editor?.enabled && editorConfig.editor.integration === "orca") {
      if (!services.launchEditorTerminals) throw new Error("Orca terminal integration is unavailable; workspace retained.");
      await services.launchEditorTerminals({ repository, worktree, config: editorConfig, agent: agentCommand, setup: true,
        ...(options.workflow === undefined ? {} : { workflowName: options.workflow }),
        ...(workflow === null ? {} : { workflowScripts: workflow.postCreate }) }, context.io);
      return;
    }

    if (config.hooks?.postCreate.length || workflow?.postCreate.length) {
      await services.runSetup(repository, worktree, config, context.io,
        options.workflow, workflow?.postCreate);
    }

    const editor = await services.launchEditor(worktree, editorConfig, options.editor === false);
    if (editor.kind === "failed") {
      throw new Error(failureWithRetry(editor.message, editor.retryCommand, worktree.path, "--editor"));
    }
    if (agentCommand === null) return;
    return reportAgentResult(await services.launchAgent(worktree, agentCommand), worktree, context.io);
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
    .map(suggestion => `  ${suggestion.key} — ${safeTitle(suggestion.title)}`)
    .join("\n");
  const count = suggestions.length;
  const shown = Math.min(count, 5);
  return new FormattedError(
    `${originalFailure}\nNo interactive chooser is available. ${count} unfinished Jira prefix matches for ${requestedKey} (showing ${shown}):\n${visible}\n` +
    "Run `timber new <candidate-key>` explicitly, or rerun in an interactive terminal to choose one.",
  );
}
