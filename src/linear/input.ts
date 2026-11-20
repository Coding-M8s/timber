import { normalizeTicketKey } from "../jira/branch";

/** Parse a `linear:<KEY>` selector; the key may be typed in any case. */
export function parseLinearInput(input: string): { key: string } | null {
  if (!input.startsWith("linear:")) return null;
  const key = normalizeTicketKey(input.slice(7));
  if (key === null) {
    throw new Error("Invalid Linear issue selector. Use linear:<KEY>, for example linear:ENG-123.");
  }
  return { key };
}
