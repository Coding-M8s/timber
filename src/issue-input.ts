import { parseGithubInput } from "./github/input";
import { parseLinearInput } from "./linear/input";
import { isJiraTicketKey } from "./jira/branch";
import type { RepositoryConfig } from "./types";

type IssueOrigin = "explicit" | "default" | "legacy";
export type IssueInput = { kind: "literal" }
  | { kind: "github"; number: number; origin: IssueOrigin }
  | { kind: "linear" | "jira"; key: string; origin: IssueOrigin };

export function resolveIssueInput(input: string, config: Pick<RepositoryConfig, "defaultTracker" | "jira">): IssueInput {
  const github = parseGithubInput(input);
  if (github) return { kind: "github", ...github, origin: "explicit" };
  const linear = parseLinearInput(input);
  if (linear) return { kind: "linear", ...linear, origin: "explicit" };
  if (input.startsWith("jira:")) {
    const key = input.slice(5);
    if (!isJiraTicketKey(key)) throw new Error("Invalid Jira issue selector. Use jira:<KEY>, for example jira:ENG-123.");
    return { kind: "jira", key, origin: "explicit" };
  }
  if (config.defaultTracker === "github" && /^[1-9][0-9]*$/u.test(input) && Number.isSafeInteger(Number(input))) {
    return { kind: "github", number: Number(input), origin: "default" };
  }
  if (isJiraTicketKey(input)) {
    if (config.defaultTracker === "linear" || config.defaultTracker === "jira") {
      return { kind: config.defaultTracker, key: input, origin: "default" };
    }
    if (config.defaultTracker === undefined && config.jira) return { kind: "jira", key: input, origin: "legacy" };
  }
  return { kind: "literal" };
}
