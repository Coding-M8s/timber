import fuzzysort from "fuzzysort";
import type { ChoiceOption } from "./selection";

/** Ranking only: callers own catalogs, terminal input, ambiguity and persistence. */
export function searchChoices<T extends ChoiceOption>(query: string, choices: readonly T[]): T[] {
  if (!query.trim()) return [...choices];
  const canonicalRank = (choice: T) => choice.value === query.trim() ? 0
    : choice.value.toLowerCase().startsWith(query.trim().toLowerCase()) ? 1 : 2;
  return [...fuzzysort.go(query.trim(), choices, {
    keys: ["value", "label", "description", choice => choice.keywords?.join(" ")],
    threshold: 0,
    limit: 0,
  })].sort((a, b) => canonicalRank(a.obj) - canonicalRank(b.obj) || b.score - a.score || choices.indexOf(a.obj) - choices.indexOf(b.obj)).map(result => result.obj);
}

export function resolveChoice<T extends ChoiceOption>(query: string, choices: readonly T[]):
  | { kind: "match"; choice: T }
  | { kind: "none" | "ambiguous"; choices: T[] } {
  const exact = choices.find(choice => choice.value === query);
  if (exact) return { kind: "match", choice: exact };
  const prefix = query.trim() ? choices.filter(choice => choice.value.toLowerCase().startsWith(query.trim().toLowerCase())) : [];
  const matches = prefix.length ? prefix : query.trim() ? searchChoices(query, choices) : [];
  return matches.length === 1
    ? { kind: "match", choice: matches[0]! }
    : { kind: matches.length ? "ambiguous" : "none", choices: matches };
}
