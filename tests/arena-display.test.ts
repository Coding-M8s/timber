import { expect, test } from "bun:test";
import { arenaRunBlock, arenaReviewText } from "../src/arena/display";
import { terminalStyle as arenaStyle } from "../src/terminal-style";
import type { ArenaPlan, PlannedAttempt } from "../src/arena/types";

const attempt: PlannedAttempt = {
  id: "run-id", label: "codex-1", preset: "codex", tool: "codex", model: "gpt-6-luna",
  effort: "low", configSource: "builtin", configFingerprint: null, command: null,
  branch: "arena/demo/codex-1", path: "/worktrees/demo-codex-1",
};

test("Arena color follows terminal, NO_COLOR, dumb terminal, and explicit force controls", () => {
  expect(arenaStyle(true, {}).heading("Arena demo")).toContain("\u001b[");
  for (const [tty, env] of [
    [false, {}], [true, { NO_COLOR: "1", FORCE_COLOR: "1" }],
    [true, { FORCE_COLOR: "0" }], [true, { TERM: "dumb" }],
  ] as const) expect(arenaStyle(tty, env).heading("Arena demo")).toBe("Arena demo");
  expect(arenaStyle(false, { FORCE_COLOR: "1" }).heading("Arena demo")).toContain("\u001b[");
});

test("Arena run details escape external terminal controls and distinguish requested effort from defaults", () => {
  const text = arenaRunBlock({ ...attempt, model: "model\u001b[2J", path: "/tree\nforged" }, 1, 2, arenaStyle(false, {}));
  expect(text).not.toContain("\u001b");
  expect(text).toContain("model\\u001b[2J");
  expect(text).toContain("/tree\\nforged");
  expect(text).toContain("low (requested)");
  const defaults = arenaRunBlock({ ...attempt, model: null, effort: null }, 2, 2, arenaStyle(false, {}));
  expect(defaults).toContain("tool default");
  expect(defaults).toContain("tool/model default");
});

test("Arena review keeps full source commit and destinations without exposing executable arguments", () => {
  const plan: ArenaPlan = {
    name: "demo", base: { ref: "refs/heads/trunk", commit: "a".repeat(40), source: "explicit" },
    attempts: [attempt, { ...attempt, id: "other", label: "codex-2", path: "/worktrees/other", command: { command: "PRIVATE_COMMAND", args: ["PRIVATE_ARGUMENT"] } }],
  };
  const text = arenaReviewText(plan);
  for (const value of [plan.base.ref, plan.base.commit, attempt.path, "/worktrees/other", "Run 1/2", "Run 2/2"])
    expect(text).toContain(value);
  expect(text).not.toContain("PRIVATE_COMMAND");
  expect(text).not.toContain("PRIVATE_ARGUMENT");
  expect(text).not.toContain("\u001b");
});
