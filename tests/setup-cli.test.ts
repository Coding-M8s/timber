import { expect, test } from "bun:test";
import { createSetupHandler } from "../src/commands/setup";
import { placeholderHandlers, runCli } from "../src/cli";
import { parseConfigSource } from "../src/config";
import type { JiraSetupSession } from "../src/setup/jira";
import type { SetupPrompt, SetupTarget } from "../src/setup/types";
import { SetupVisibilityError } from "../src/setup/types";
import { repositoryFixture } from "./helpers/services";

const file = { path: "/repo/.timber.toml", source: null, values: {} };
const target: SetupTarget = { scope: "repository", path: file.path, file,
  scopes: { local: file, global: { path: "/home/config.toml", source: null, values: {} } },
  repository: repositoryFixture(), branches: ["main"], tracked: false, exclude: null };

async function setup(options: { interactive?: boolean; tracked?: boolean; existing?: boolean; save?: boolean; cancel?: boolean; global?: boolean } = {}) {
  let stdout = ""; let stderr = ""; let writes = 0; let prompted = false;
  const destination = { ...target, tracked: options.tracked ?? false,
    file: { ...file, source: options.existing ? 'remote = "upstream"' : null,
      values: options.existing ? { remote: "upstream" } : {} } };
  const prompt: SetupPrompt = {
    select: async (message, _choices, defaultValue) => options.cancel ? null : message.includes("Tracked") ? "cancel"
      : message.includes("Review settings") ? options.save ? "save" : "cancel" : defaultValue,
    text: async () => { throw new Error("unexpected text"); },
    confirm: async () => false, close() {},
  };
  const handler = createSetupHandler({
    inspectTarget: async (global, cwd) => { expect(cwd).toBe("/repo"); expect(global).toBe(options.global ?? false); return destination; },
    prompt: () => { prompted = true; return prompt; }, checkExecutable: async () => true,
    save: async (_target, source, approved) => { writes++; expect(source).toContain("# Timber"); expect(approved).toBe(false); },
  });
  const code = await runCli(["setup", ...(options.global ? ["--global"] : [])], {
    handlers: { ...placeholderHandlers, setup: handler }, context: { cwd: "/repo", interactive: options.interactive ?? true,
      io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } } },
  });
  return { code, stdout, stderr, writes, prompted };
}

test("setup summary precedes saving and names repository destination", async () => {
  const result = await setup({ save: true });
  expect(result.code).toBe(0);
  expect(result.writes).toBe(1);
  expect(result.stdout.indexOf("Summary")).toBeLessThan(result.stdout.indexOf("Saved"));
  expect(result.stdout).toContain("/repo/.timber.toml");
});

test("setup review counts workflows without displaying their executable arguments", async () => {
  const existing = parseConfigSource('[workflows.review.agent]\ncommand = "wrapper"\nargs = ["PRIVATE_PROMPT"]\n', "existing.toml");
  const destination: SetupTarget = { ...target,
    file: { path: file.path, source: "configured", values: existing },
    scopes: { ...target.scopes, local: { path: file.path, source: "configured", values: existing } } };
  let output = "";
  const handler = createSetupHandler({ inspectTarget: async () => destination,
    prompt: () => ({ select: async (message) => message.includes("Review settings") ? "cancel" : "keep",
      text: async () => null, confirm: async () => false, close() {} }),
    checkExecutable: async () => true, save: async () => {} });
  await handler({ global: false }, { cwd: "/repo", interactive: true,
    io: { stdout: text => { output += text; }, stderr: () => {} } });
  expect(output).toContain("Workflows: 1");
  expect(output).not.toContain("PRIVATE_PROMPT");
});

test("declining replacement and cancelling questionnaire never writes settings", async () => {
  for (const options of [{ existing: true }, { cancel: true }, { tracked: true }]) {
    const result = await setup(options);
    expect(result.code).toBe(0);
    expect(result.writes).toBe(0);
    expect(result.stdout).toContain("Cancelled");
  }
});

test("noninteractive setup fails before asking or saving", async () => {
  const result = await setup({ interactive: false });
  expect(result.code).toBe(1);
  expect(result.prompted).toBe(false);
  expect(result.writes).toBe(0);
  expect(result.stderr).toContain("interactive terminal");
});

test("setup --global dispatches scope and help without prompting", async () => {
  expect((await setup({ global: true })).code).toBe(0);
  let stdout = "";
  const code = await runCli(["setup", "--help"], { context: { cwd: "/outside",
    io: { stdout: text => { stdout += text; }, stderr: () => {} } } });
  expect(code).toBe(0);
  expect(stdout).toContain("--global");
});

test("review can edit every section without restarting or losing other draft answers", async () => {
  const selections = ["keep", "keep", "keep", "editor", "code", "agent", "codex", "jira", "configure",
    "hooks", "custom", "finish", "base_branch", "custom", "remote", "custom", "worktree_dir", "custom", "save"];
  const texts = ["https://example.atlassian.net", "bun install", "trunk", "upstream", "../review-workspaces"];
  const questions: string[] = [];
  let saved: unknown; let closed = false;
  const prompt: SetupPrompt = {
    select: async (message, choices) => {
      questions.push(message);
      const answer = selections.shift();
      if (answer === undefined || !choices.some(choice => choice.value === answer)) throw new Error(`Unexpected question: ${message}`);
      return answer;
    },
    confirm: async () => false,
    text: async () => { const answer = texts.shift(); if (answer === undefined) throw new Error("Unexpected text question"); return answer; },
    close() { closed = true; },
  };
  const handler = createSetupHandler({ inspectTarget: async () => structuredClone(target), prompt: () => prompt,
    checkExecutable: async () => true, save: async (_target, source) => { saved = parseConfigSource(source, "test.toml"); } });
  await handler({ global: false }, { cwd: "/repo", interactive: true, io: { stdout() {}, stderr() {} } });
  expect(saved).toEqual({ editor: { command: "code", args: ["--new-window"], enabled: false },
    agent: { command: "codex", args: [], enabled: false }, jira: { site_url: "https://example.atlassian.net" },
    hooks: { post_create: ["bun install"] }, base_branch: "trunk", remote: "upstream", worktree_dir: "../review-workspaces" });
  expect(questions.filter(question => question.includes("Which editor"))).toHaveLength(2);
  expect(questions.filter(question => question.includes("Use an AI"))).toHaveLength(2);
  expect(selections).toEqual([]);
  expect(texts).toEqual([]);
  expect(target.file.values).toEqual({});
  expect(closed).toBe(true);
});

test("review uses current draft choices to reset a newly configured override", async () => {
  const selections = ["code", "keep", "keep", "editor", "inherit", "save"];
  let saved: unknown;
  const prompt: SetupPrompt = {
    select: async (message, choices) => {
      const answer = selections.shift();
      if (answer === undefined || !choices.some(choice => choice.value === answer)) throw new Error(`Unexpected question: ${message}`);
      return answer;
    },
    confirm: async () => false, text: async () => { throw new Error("Unexpected text question"); }, close() {},
  };
  const handler = createSetupHandler({ inspectTarget: async () => structuredClone(target), prompt: () => prompt,
    checkExecutable: async () => true, save: async (_target, source) => { saved = parseConfigSource(source, "test.toml"); } });
  await handler({ global: false }, { cwd: "/repo", interactive: true, io: { stdout() {}, stderr() {} } });
  expect(saved).toEqual({});
  expect(selections).toEqual([]);
});

test("an invalid folder edit retries that input without discarding the setup draft", async () => {
  const selections = ["code", "keep", "keep", "worktree_dir", "custom", "save"];
  const texts = ["", "../corrected-folder"];
  let saved: unknown; let stderr = "";
  const prompt: SetupPrompt = {
    select: async (message, choices) => {
      const answer = selections.shift();
      if (answer === undefined || !choices.some(choice => choice.value === answer)) throw new Error(`Unexpected question: ${message}`);
      return answer;
    },
    confirm: async () => false,
    text: async () => { const answer = texts.shift(); if (answer === undefined) throw new Error("Unexpected text question"); return answer; },
    close() {},
  };
  const handler = createSetupHandler({ inspectTarget: async () => structuredClone(target), prompt: () => prompt,
    checkExecutable: async () => true, save: async (_target, source) => { saved = parseConfigSource(source, "test.toml"); } });
  await handler({ global: false }, { cwd: "/repo", interactive: true, io: { stdout() {}, stderr: text => { stderr += text; } } });
  expect(saved).toEqual({ editor: { command: "code", args: ["--new-window"], enabled: false }, worktree_dir: "../corrected-folder" });
  expect(texts).toEqual([]);
  expect(stderr).toContain("nonempty");
});

test("visibility recovery recreates the Jira session before the global retry", async () => {
  const local = structuredClone(target);
  const globalTarget: SetupTarget = {
    ...structuredClone(target),
    scope: "global",
    path: "/home/config.toml",
    file: { path: "/home/config.toml", source: null, values: {} },
  };
  const selections = [
    "keep", "keep", "keep", "save", "global",
    "keep", "keep", "keep", "save",
  ];
  let sessions = 0;
  let savedScope: string | undefined;
  const prompt: SetupPrompt = {
    select: async (message, choices) => {
      const answer = selections.shift();
      if (answer === undefined || !choices.some(choice => choice.value === answer)) {
        throw new Error(`Unexpected question: ${message}`);
      }
      return answer;
    },
    confirm: async () => false,
    text: async () => { throw new Error("Unexpected text question"); },
    close() {},
  };
  const handler = createSetupHandler({
    inspectTarget: async global => global ? structuredClone(globalTarget) : structuredClone(local),
    prompt: () => prompt,
    checkExecutable: async () => true,
    jira: () => {
      sessions += 1;
      return {
        async edit() {},
        review() {},
        async save(publishConfig) { await publishConfig(); },
      } satisfies JiraSetupSession;
    },
    save: async (destination, _source, _approved, _signal) => {
      if (destination.scope === "repository") throw new SetupVisibilityError("Repository ignore rules cannot hide .timber.toml.");
      savedScope = destination.scope;
    },
  });
  await handler({ global: false }, { cwd: "/repo", interactive: true, io: { stdout() {}, stderr() {} } });
  expect(sessions).toBe(2);
  expect(savedScope).toBe("global");
  expect(selections).toEqual([]);
});
