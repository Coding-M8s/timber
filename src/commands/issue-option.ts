import { safeDisplay } from "../display";
import { IssueLinkConflict, issueSelector, sameIssue, type IssueLink, type LinkedTracker } from "../git/issue-link";
import { resolveIssueInput } from "../issue-input";
import type { CommandServices } from "../services";
import type { RepositoryConfig, RepositoryContext, Worktree } from "../types";

export type IssueOptionServices = Pick<CommandServices,
  "resolveGithubRepository" | "resolveGithubTicket" | "resolveLinearTicket" | "resolveJiraTicket" | "readIssueLink">;

export interface RequestedIssue { tracker: LinkedTracker; key: string; number?: number }

/** Parse `--issue` without contacting a tracker. */
export function parseIssueOption(selector: string, config: RepositoryConfig): RequestedIssue {
  const input = resolveIssueInput(selector, config);
  if (input.kind === "literal") {
    throw new Error(`Invalid issue selector ${JSON.stringify(selector)}. Use github:<number>, jira:<KEY>, or linear:<KEY>.`);
  }
  return input.kind === "github"
    ? { tracker: "github", key: String(input.number), number: input.number }
    : { tracker: input.kind, key: input.key };
}

/**
 * Check the existing link offline first, so a conflict is refused before any
 * tracker lookup. Returns null when the worktree already has this link.
 */
export async function resolveIssueOption(
  services: IssueOptionServices, repository: RepositoryContext, config: RepositoryConfig,
  requested: RequestedIssue, existing: Worktree | null, replace: boolean,
): Promise<IssueLink | null> {
  if (existing !== null) {
    if (existing.isPrimary) throw new Error("The primary worktree cannot be linked to an issue; nothing was changed.");
    const current = await services.readIssueLink(repository, existing);
    if (current.kind === "invalid" && current.reason !== "stale") {
      throw new Error(`Issue link metadata for ${safeDisplay(existing.path)} is ${current.reason}; nothing was changed. Inspect the worktree's private Git metadata before linking an issue.`);
    }
    if (current.kind === "linked") {
      if (sameIssue(current, requested)) return null;
      if (!replace) throw new IssueLinkConflict({ tracker: current.tracker, key: current.key, url: current.url });
    }
  }
  // Attaching records existing work, so closed or completed issues are accepted.
  let ticket: { key: string; url: string };
  if (requested.tracker === "github") {
    const github = await services.resolveGithubRepository(repository, config);
    ticket = await services.resolveGithubTicket(github, requested.number!, true);
  } else if (requested.tracker === "linear") {
    ticket = await services.resolveLinearTicket(requested.key, true);
  } else {
    if (!config.jira) throw new Error("Jira site settings are missing or disabled. Configure Jira with timber setup before linking Jira issues.");
    ticket = await services.resolveJiraTicket(config.jira, requested.key, true);
  }
  return { tracker: requested.tracker, key: requested.tracker === "github" ? requested.key : ticket.key, url: ticket.url };
}

export function linkedMessage(link: IssueLink): string {
  return `Linked ${issueSelector(link)}: ${link.url}\n`;
}
