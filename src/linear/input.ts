import { isJiraTicketKey } from "../jira/branch";

export function parseLinearInput(input: string): { key: string } | null {
  if (!input.startsWith("linear:")) return null;
  const key = input.slice(7);
  if (!isJiraTicketKey(key)) {
    throw new Error("Invalid Linear issue selector. Use linear:<KEY>, for example linear:ENG-123.");
  }
  return { key };
}
