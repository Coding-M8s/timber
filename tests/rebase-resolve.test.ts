import { expect, test } from "bun:test";
import { parseConfigSource, resolveConfig } from "../src/config";
import { buildResolveTask, resolveAgentCommand } from "../src/git/rebase-resolve-task";

const resolved = (local: string, global = "") => resolveConfig({
  local: { path: "/repo/.timber.toml", source: local, values: parseConfigSource(local, "/repo/.timber.toml") },
  global: { path: "/home/config.toml", source: global, values: parseConfigSource(global, "/home/config.toml") },
}, "/repo");

test("resolve keys live on the top-level agent and replace with the whole table", () => {
  const config = resolved("", '[agent]\ncommand = "claude"\nresolve_handoff = "claude"\nresolve_instructions = " Be careful. "\n');
  expect(config.agent).toEqual({ command: "claude", args: [], enabled: false, resolveHandoff: "claude", resolveInstructions: "Be careful." });
  // A repository [agent] without the keys drops the machine handoff instead of reusing another tool's grammar.
  expect(resolved('[agent]\ncommand = "codex"\n', '[agent]\ncommand = "claude"\nresolve_handoff = "claude"\n').agent)
    .toEqual({ command: "codex", args: [], enabled: false });
});

test("invalid resolve settings are rejected, including on workflow agents", () => {
  for (const source of [
    '[agent]\ncommand = "claude"\nresolve_handoff = "auto"\n',
    '[agent]\ncommand = "claude"\nresolve_instructions = "  "\n',
    `[agent]\ncommand = "claude"\nresolve_instructions = "${"x".repeat(4001)}"\n`,
    '[workflows.fix.agent]\ncommand = "claude"\nresolve_handoff = "claude"\n',
  ]) expect(() => parseConfigSource(source, "/repo/.timber.toml")).toThrow();
});

test("native handoffs pass only a task-file pointer after the configured arguments; wrappers run unchanged", () => {
  const agent = { command: "claude", args: ["--model", "x"] };
  const native = resolveAgentCommand(agent, "claude", "/git dir/task.txt");
  expect(native.command).toBe("claude");
  expect(native.args.slice(0, 3)).toEqual(["--model", "x", "--"]);
  expect(native.args).toHaveLength(4);
  expect(native.args[3]).toContain('"/git dir/task.txt"');
  expect(resolveAgentCommand(agent, "wrapper", "/git dir/task.txt")).toEqual({ command: "claude", args: ["--model", "x"] });
});

test("the task lists facts and rules, then configured and command-line instructions in order", () => {
  const task = buildResolveTask({
    worktree: "/w", branch: "feature", originalTip: "a".repeat(40), onto: "b".repeat(40), head: "c".repeat(40),
    replaying: null, conflicts: ["odd \n name", "b.txt"],
  }, { config: "CONFIG", note: "NOTE" });
  expect(task).toContain('"odd \\n name"');
  expect(task).toContain("GIT_EDITOR=true git rebase --continue");
  expect(task).toContain("only after the user approves");
  expect(task).toContain("git rebase --abort");
  expect(task.indexOf("CONFIG")).toBeLessThan(task.indexOf("NOTE"));
  expect(buildResolveTask({ worktree: "/w", branch: "f", originalTip: "a", onto: "b", head: "c", replaying: null, conflicts: [] }))
    .not.toContain("Additional instructions");
});
