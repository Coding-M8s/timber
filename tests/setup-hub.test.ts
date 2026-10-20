import { expect, test } from "bun:test";
import { runSetupHub, sectionStatus } from "../src/setup/hub";
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

test("section status summarizes draft and inherited values without leaking secrets", () => {
  const destination = target({
    editor: { command: "code", args: ["--new-window"], enabled: false },
    agent: false,
    jira: { site_url: "https://example.atlassian.net" },
    hooks: { post_create: ["bun install", "bun test"] },
  });
  destination.scopes.global.values = { remote: "origin" };
  expect(sectionStatus("editor", destination.file.values, destination)).toContain("code");
  expect(sectionStatus("editor", destination.file.values, destination)).toContain("manual");
  expect(sectionStatus("agent", destination.file.values, destination)).toBe("off");
  expect(sectionStatus("jira", destination.file.values, destination)).toContain("example.atlassian.net");
  expect(sectionStatus("hooks", destination.file.values, destination)).toBe("2 setup scripts");
  expect(sectionStatus("remote", {}, destination)).toContain("origin");
  expect(sectionStatus("remote", {}, destination)).toContain("machine");
});

test("hub opens on the review menu and can save without a forced walkthrough", async () => {
  const questions: string[] = [];
  const prompt = scripted(["save"]);
  const originalSelect = prompt.select;
  prompt.select = async (message, choices, defaultValue) => {
    questions.push(message);
    expect(message).toContain("Settings -");
    expect(choices.some(choice => choice.value === "editor")).toBe(true);
    expect(choices.some(choice => choice.value === "guide")).toBe(true);
    expect(choices.find(choice => choice.value === "editor")?.label).toMatch(/Editor/i);
    return originalSelect(message, choices, defaultValue);
  };
  const file = await runSetupHub(target(), prompt, io().io, async () => true);
  expect(file).toEqual({});
  expect(questions).toHaveLength(1);
});

test("hub edits one section then saves the draft", async () => {
  const file = await runSetupHub(target(), scripted(["editor", "code", false, "save"]), io().io, async () => true);
  expect(file).toEqual({ editor: { command: "code", args: ["--new-window"], enabled: false } });
});

test("hub offers pre-done scripts and saves them without replacing creation scripts", async () => {
  const destination = target({ hooks: { post_create: ["bun install"] } });
  const prompt = scripted(["pre_delete", "custom", "printf 'cleanup one'", "add", "printf 'cleanup two'", "finish", "save"]);
  const select = prompt.select;
  prompt.select = async (message, choices, defaultValue) => {
    if (message.includes("Settings -")) {
      expect(choices.find(choice => choice.value === "pre_delete")?.label).toContain("Pre-done");
    }
    return select(message, choices, defaultValue);
  };
  const file = await runSetupHub(destination, prompt, io().io, async () => true);
  expect(file?.hooks).toEqual({ post_create: ["bun install"], pre_delete: ["printf 'cleanup one'", "printf 'cleanup two'"] });
  expect(sectionStatus("pre_delete", file!, destination)).toBe("2 pre-done scripts");
});

test("hub guided walkthrough asks essentials then returns for save", async () => {
  const file = await runSetupHub(target(), scripted([
    "guide", "none", "none", "none", false, "save",
  ]), io().io, async () => true);
  expect(file).toEqual({});
});

test("cancelling guided walkthrough keeps prior hub edits when the session is still alive", async () => {
  const file = await runSetupHub(target(), scripted([
    "editor", "code", false, "guide", null, "save",
  ]), io().io, async () => true);
  expect(file).toEqual({ editor: { command: "code", args: ["--new-window"], enabled: false } });
});

test("aborted guided walkthrough cancels the whole hub", async () => {
  const prompt = scripted(["guide", null]);
  prompt.signal = AbortSignal.abort();
  expect(await runSetupHub(target({ remote: "upstream" }), prompt, io().io, async () => true)).toBeNull();
});

test("hub cancel never returns a draft", async () => {
  expect(await runSetupHub(target({ remote: "upstream" }), scripted(["cancel"]), io().io, async () => true)).toBeNull();
  expect(await runSetupHub(target(), scripted([null]), io().io, async () => true)).toBeNull();
});

test("hub review labels refresh after an edit", async () => {
  const labels: string[] = [];
  const prompt = scripted(["editor", "zed", false, "save"]);
  const select = prompt.select;
  prompt.select = async (message, choices, defaultValue) => {
    const editor = choices.find(choice => choice.value === "editor");
    if (editor) labels.push(editor.label);
    return select(message, choices, defaultValue);
  };
  const file = await runSetupHub(target(), prompt, io().io, async () => true);
  expect(file?.editor).toEqual({ command: "zed", args: ["--new"], enabled: false });
  expect(labels[0]).not.toContain("zed");
  expect(labels[1]).toContain("zed");
});
