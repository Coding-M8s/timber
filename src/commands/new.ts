import { resolveAgentCommand, reportAgentResult } from "../agent";
import { retryForDisplay, safeDiagnostic, safeDisplay } from "../display";
import type { CommandHandlers, CommandServices } from "../services";
import { JiraLookupFailure } from "../jira/client";
import { isJiraTicketKey, jiraBranchName } from "../jira/branch";
import type { JiraTicket } from "../types";

type NewServices = Pick<CommandServices,
  "discoverRepository" | "loadConfig" | "resolveBase" | "resolveJiraTicket" | "findJiraSuggestions" |
  "createWorktree" | "runSetup" | "launchEditor" | "launchAgent">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Command failed unexpectedly";
}

async function safely<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(safeDiagnostic(errorMessage(error)));
  }
}

/** Create a new workspace, then optionally start its configured editor. */
export function createNewHandler(services: NewServices): CommandHandlers["new"] {
  return async (branch, options, context) => {
    const repository = await safely(() => services.discoverRepository(context.cwd));
    const config = await safely(() => services.loadConfig(repository));
    const agentCommand = resolveAgentCommand(config, options.agent, context.interactive === true);
    const base = await safely(() => services.resolveBase(repository, config, options.base));
    let ticket: JiraTicket | undefined;
    if (config.jira && isJiraTicketKey(branch)) {
      try {
        ticket = await services.resolveJiraTicket(config.jira, branch);
      } catch (error) {
        if (!(error instanceof JiraLookupFailure) || error.reason === undefined) {
          throw new Error(safeDiagnostic(errorMessage(error)));
        }

        let suggestions: readonly JiraTicket[];
        try {
          suggestions = await services.findJiraSuggestions(config.jira, branch);
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

        const selected = await safely(() => context.choose!(`${error.message}\nDid you mean one of these?`, choices));
        if (selected === null) {
          context.io.stdout("Cancelled.\n");
          return;
        }
        const chosen = suggestions.find(suggestion => suggestion.key === selected);
        if (chosen === undefined) throw new Error("Jira chooser returned an unknown suggestion; no workspace was created.");

        // The search result can be stale; the selected exact issue is authoritative.
        ticket = await safely(() => services.resolveJiraTicket(config.jira, chosen.key));
      }
    }
    const selectedBranch = ticket ? jiraBranchName(ticket.key, ticket.title) : branch;
    const worktree = await safely(() => services.createWorktree(repository, { kind: "new", branch: selectedBranch, base }, config));
    context.io.stdout(`Created ${safeDisplay(selectedBranch)} at ${safeDisplay(worktree.path)}\n`);
    if (ticket) context.io.stdout(`Jira: ${ticket.url}\n`);

    if (config.hooks?.postCreate.length) {
      await safely(() => services.runSetup(repository, worktree, config, context.io));
    }

    const editor = await safely(() => services.launchEditor(worktree, config, options.editor === false));
    if (editor.kind === "failed") {
      const retryCommand = retryForDisplay(worktree.path, editor.retryCommand);
      const originalMessage = editor.message.includes(editor.retryCommand)
        ? editor.message.replace(editor.retryCommand, () => retryCommand)
        : editor.message;
      throw new Error(safeDiagnostic(originalMessage));
    }
    if (agentCommand === null) return;
    return reportAgentResult(await safely(() => services.launchAgent(worktree, agentCommand)), worktree, context.io);
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
  return new Error(
    `${originalFailure}\nNo interactive chooser is available. ${count} unfinished Jira prefix matches for ${requestedKey} (showing ${shown}):\n${visible}\n` +
    "Run `timber new <candidate-key>` explicitly, or rerun in an interactive terminal to choose one.",
  );
}
