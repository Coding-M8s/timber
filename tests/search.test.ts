import { expect, test } from "bun:test";
import { searchChoices, resolveChoice } from "../src/search";
const choices = [
  { value: "codex", label: "Codex CLI" },
  { value: "claude", label: "Claude Code" },
  { value: "cursor", label: "Cursor CLI" },
  { value: "manual", label: "Manual worktrees" },
];
test("shared matching keeps exact values, ranks abbreviations and preserves empty-query order", () => {
  expect(searchChoices("", choices)).toEqual(choices);
  expect(resolveChoice("cur", choices)).toEqual({ kind: "match", choice: choices[2]! });
  expect(resolveChoice("cod", choices)).toEqual({ kind: "match", choice: choices[0]! });
  expect(resolveChoice("codex", choices)).toEqual({ kind: "match", choice: choices[0]! });
  expect(resolveChoice("c", choices).kind).toBe("ambiguous");
  expect(resolveChoice("zzzz", choices)).toEqual({ kind: "none", choices: [] });
  const models = [{ value: "native-a", label: "Sonnet High", keywords: ["review"] }, { value: "native-b", label: "Sonnet Medium" }];
  expect(resolveChoice("rev", models)).toEqual({ kind: "match", choice: models[0]! });
  expect(searchChoices("sonnet", models)).toHaveLength(2);
});

test("picker ranking puts canonical exact IDs and prefixes ahead of matching display labels", () => {
  const models = [{ value: "other-model", label: "sonnet" }, { value: "sonnet", label: "Sonnet CLI alias" }, { value: "sonnet-high", label: "Native high" }];
  expect(searchChoices("sonnet", models).map(model => model.value)).toEqual(["sonnet", "sonnet-high", "other-model"]);
});
