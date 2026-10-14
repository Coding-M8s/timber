import { expect, test } from "bun:test";
import { editSetupSection, questionnaire } from "../src/setup/questions";
import { renderConfig } from "../src/setup/render";
import { parseConfigSource, resolveConfig } from "../src/config";
import type { SetupPrompt, SetupTarget } from "../src/setup/types";
import { repositoryFixture } from "./helpers/services";

function target(values = {}): SetupTarget {
  const file = { path: "/repo/.timber.toml", source: null, values };
  return { scope: "repository", path: file.path, file, scopes: {
    local: file, global: { path: "/home/config.toml", source: null, values: {} },
  }, repository: repositoryFixture(), branches: ["main", "feature"], tracked: false, exclude: null };
}

function scripted(answers: (string | boolean | null)[]): SetupPrompt {
  const answer = async () => {
    if (!answers.length) throw new Error("Unexpected question");
    return answers.shift()!;
  };
  return { select: answer as SetupPrompt["select"], text: answer as SetupPrompt["text"],
    confirm: answer as SetupPrompt["confirm"], close() {} };
}

const io = () => {
  let output = "";
  return { io: { stdout: (text: string) => { output += text; }, stderr: (text: string) => { output += text; } },
    output: () => output };
};

for (const section of ["editor", "agent"] as const) {
  test(`${section} rejects a relative executable before availability checking`, async () => {
    const file = {};
    const capture = io();
    const checked: string[] = [];
    await editSetupSection(section, file, target(), scripted([
      "custom", "./tools/launcher", "[]", "none",
    ]), capture.io, async command => { checked.push(command); return true; });
    expect(file).toEqual({ [section]: false });
    expect(checked).toEqual([]);
    expect(capture.output()).toContain("absolute path");
  });

  test(`${section} retains absolute executable paths and literal arguments`, async () => {
    const file = {};
    await editSetupSection(section, file, target(), scripted([
      "custom", "/opt/my tools/launcher", '["--flag", "literal argument"]', false,
    ]), io().io, async () => true);
    expect(file).toEqual({ [section]: {
      command: "/opt/my tools/launcher", args: ["--flag", "literal argument"],
      ...(section === "agent" ? { enabled: false } : {}),
    } });
  });
}

for (const section of ["base_branch", "remote", "worktree_dir"] as const) {
  test(`${section} reset describes inherited machine defaults`, async () => {
    const file = { [section]: "local-value" };
    const destination = target(file);
    destination.scopes.global.values = { [section]: "machine-value" };
    const prompt = scripted([]);
    prompt.select = async (message, choices) => {
      expect(message).toContain("machine defaults");
      expect(message).not.toContain("Skip for automatic");
      expect(choices.find(choice => choice.value === "automatic")?.label).toBe("Use machine defaults");
      return "automatic";
    };
    await editSetupSection(section, file, destination, prompt, io().io, async () => true);
    expect(file).not.toHaveProperty(section);
    const config = resolveConfig({ ...destination.scopes, local: { ...destination.file, values: file } }, "/repo");
    expect(config[({ base_branch: "baseBranch", remote: "remote", worktree_dir: "worktreeDir" } as const)[section]])
      .toBe(section === "worktree_dir" ? "/repo/machine-value" : "machine-value");
  });
}

test("guided choices keep editor and agent separate with agent disabled by default", async () => {
  const capture = io();
  const file = await questionnaire(target(), scripted([
    "code", "codex", false, "none", true, "none", "keep", "keep", "keep",
  ]), capture.io, async () => true);
  expect(file?.editor).toEqual({ command: "code", args: ["--new-window"] });
  expect(file?.agent).toEqual({ command: "codex", args: [], enabled: false });
  expect(file?.hooks).toBe(false);
  expect(file?.jira).toBe(false);
});

test("keeping existing values retains custom arguments hooks and explicit off without flattening inheritance", async () => {
  const existing = { editor: false as const, agent: { command: "wrapper", args: ["  literal  "], enabled: true },
    hooks: { post_create: [" printf 'a' "] }, remote: "upstream" };
  const file = await questionnaire(target(existing), scripted([
    "keep", "keep", "keep", false,
  ]), io().io, async () => true);
  expect(file).toEqual(existing);
  expect(file).not.toHaveProperty("worktree_dir");
});

test("guided setup preserves named workflow definitions and disables during save", async () => {
  const existing = parseConfigSource([
    '[workflows.review]', 'post_create = ["printf review"]',
    '[workflows.review.editor]', 'command = "zed"', 'args = ["--new"]',
    '[workflows]', 'investigate = false',
  ].join("\n"), "test.toml");
  const file = await questionnaire(target(existing), scripted(["keep", "keep", "keep", false]), io().io,
    async () => true);
  expect(parseConfigSource(renderConfig(file!), "saved.toml").workflows).toEqual(existing.workflows);
});

test("custom commands, hooks, and Jira values round trip with literal quotes and paths", async () => {
  const capture = io();
  const file = await questionnaire(target(), scripted([
    "custom", "my editor", '["a\\\"b", "$(touch nope)", ""]',
    "claude", true, "configure", "https://example.atlassian.net/", true, "00000000-0000-4000-8000-000000000000",
    true, "custom", "printf 'one'", "add", "echo two", "finish",
    "custom", "trunk", "custom", "upstream", "custom", " ../work trees ",
  ]), capture.io, async () => true);
  expect(file?.hooks).toEqual({ post_create: ["printf 'one'", "echo two"] });
  const source = renderConfig(file!);
  const parsed = parseConfigSource(source, "test.toml");
  const result = resolveConfig({ local: { path: "test.toml", source, values: parsed },
    global: { path: "global.toml", source: null, values: {} } }, "/repo");
  expect(result.editor).toEqual({ command: "my editor", args: ['a"b', "$(touch nope)", ""] });
  expect(result.jira).toEqual({ siteUrl: "https://example.atlassian.net", cloudId: "00000000-0000-4000-8000-000000000000" });
  expect(capture.output()).not.toContain("alias");
});

test("a missing executable offers off and never saves an unusable selection silently", async () => {
  const capture = io();
  const file = await questionnaire(target(), scripted([
    "zed", "none", "none", "none", false,
  ]), capture.io, async () => false);
  expect(file?.editor).toBe(false);
  expect(capture.output()).toContain("PATH");
});

test("cancellation at a prompt preserves original values", async () => {
  const original = target({ remote: "upstream" });
  expect(await questionnaire(original, scripted([null]), io().io, async () => true)).toBeNull();
  expect(original.file.values).toEqual({ remote: "upstream" });
});

test("skipped sections produce editable examples without enabling tools", () => {
  const source = renderConfig({});
  expect(source).toContain("# [editor]");
  expect(source).toContain("# [agent]");
  expect(source).toContain("# [hooks]");
  expect(source).toContain("# [jira]");
  expect(parseConfigSource(source, "test.toml")).toEqual({});
});

test("repeated repository setup can remove optional overrides and inherit global settings again", async () => {
  const destination = target({ editor: false, agent: false, hooks: false, jira: false });
  destination.scopes.global.values = { editor: { command: "code", args: ["--new-window"] },
    agent: { command: "codex", args: [], enabled: true }, hooks: { post_create: ["global hook"] },
    jira: { site_url: "https://global.atlassian.net" } };
  const file = await questionnaire(destination, scripted([
    "inherit", "inherit", "inherit", true, "inherit", "keep", "keep", "keep",
  ]), io().io, async () => true);
  expect(file).toEqual({});
  expect(resolveConfig({ ...destination.scopes, local: { ...destination.file, values: file! } }, "/repo").agent)
    .toEqual({ command: "codex", args: [], enabled: true });
});

test("selecting inheritance checks the newly effective global editor executable", async () => {
  const destination = target({ editor: { command: "local", args: [] } });
  destination.scopes.global.values = { editor: { command: "missing-global", args: [] } };
  const capture = io();
  const file = await questionnaire(destination, scripted([
    "inherit", "keep", "keep", false,
  ]), capture.io, async () => false);
  expect(file).not.toHaveProperty("editor");
  expect(capture.output()).toContain("editor executable is unavailable");
  expect(capture.output()).toContain("PATH");
});

test("quick setup skips advanced questions and leaves new settings empty on Enter defaults", async () => {
  const questions: string[] = [];
  const prompt: SetupPrompt = {
    select: async (message, choices, defaultValue) => {
      questions.push(message);
      expect(choices.find(choice => choice.value === defaultValue)?.label).toContain("Skip");
      return defaultValue;
    },
    confirm: async message => { questions.push(message); return false; },
    text: async () => { throw new Error("Quick setup must not request text"); }, close() {},
  };
  expect(await questionnaire(target(), prompt, io().io, async () => true)).toEqual({});
  expect(questions).toHaveLength(4);
  expect(questions.join(" ")).toContain("work ticket tracker");
  expect(questions.join(" ")).not.toContain("alias");
  expect(questions.join(" ")).not.toContain("base_branch");
});
