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
    "guide", "none", "none", "inherit", false, "save",
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

test("hub exposes separate Linear credentials and includes their draft in review", async () => {
  const events: string[] = [];
  const prompt = scripted(["connections", "linear", "back", "save"]);
  const select = prompt.select;
  prompt.select = async (message, choices, initial) => {
    expect(choices.some(choice => /Linear/u.test(choice.label))).toBe(true);
    return select(message, choices, initial);
  };
  expect(await runSetupHub(target(), prompt, io().io, async () => true, undefined, undefined, {
    edit: async () => { events.push("edit"); }, review: () => { events.push("review"); }, save: async publish => publish(),
  })).toEqual({});
  expect(events).toEqual(["review", "edit", "review"]);
});

test("guided walkthrough selects Linear as default", async () => {
  let edits = 0;
  const file = await runSetupHub(target(), scripted(["guide", "none", "none", "linear", false, "save"]), io().io, async () => true,
    undefined, undefined, { edit: async () => { edits++; }, review() {}, save: async publish => publish() });
  expect(edits).toBe(1); expect(file).toEqual({ default_tracker: "linear" });
});

test("backup sections explain automatic expiry and save retention and warning values", async () => {
  const destination = target();
  expect(sectionStatus("backup_retention_days", {}, destination)).toBe("7 days (default)");
  expect(sectionStatus("backup_storage_warning", {}, destination)).toBe("5GiB (default)");
  const messages: string[] = [];
  const prompt = scripted(["backup_retention_days", "custom", "0", "14", "backup_storage_warning", "custom", "5 GB", "2GiB", "save"]);
  const select = prompt.select;
  prompt.select = async (message, choices, defaultValue) => {
    messages.push(message);
    if (message.includes("Settings -")) {
      expect(choices.find(choice => choice.value === "backup_retention_days")?.label).toContain("Backup retention");
      expect(choices.find(choice => choice.value === "backup_storage_warning")?.label).toContain("Backup size warning");
    }
    return select(message, choices, defaultValue);
  };
  const output = io();
  const file = await runSetupHub(destination, prompt, output.io, async () => true);
  expect(file).toEqual({ backup_retention_days: 14, backup_storage_warning: "2GiB" });
  const retention = messages.find(message => message.includes("How long should recovery backups be kept"))!;
  expect(retention).toContain("secrets such as .env");
  expect(retention).toContain("may be deleted automatically the next time timber backup create or timber backup cleanup runs");
  expect(retention).toContain("Nothing runs in the background");
  expect(output.output()).toContain("Enter a whole number of days from 1 to 36500.");
  expect(output.output()).toContain("Enter a size such as 5GiB");
  expect(sectionStatus("backup_retention_days", file!, destination)).toBe("14 days");
  expect(sectionStatus("backup_storage_warning", file!, destination)).toBe("2GiB");
});

test("backup sections can turn retention and the warning off, keep values and inherit machine defaults", async () => {
  const off = await runSetupHub(target(), scripted(["backup_retention_days", "off", "backup_storage_warning", "off", "save"]),
    io().io, async () => true);
  expect(off).toEqual({ backup_retention_days: false, backup_storage_warning: false });
  expect(sectionStatus("backup_retention_days", off!, target())).toBe("kept until deleted");
  expect(sectionStatus("backup_storage_warning", off!, target())).toBe("off");

  const destination = target({ backup_retention_days: 3 });
  destination.scopes.global.values = { backup_retention_days: 30, backup_storage_warning: "1GiB" };
  expect(sectionStatus("backup_storage_warning", {}, destination)).toBe("1GiB · from machine defaults");
  const kept = await runSetupHub(destination, scripted(["backup_retention_days", "keep", "save"]), io().io, async () => true);
  expect(kept).toEqual({ backup_retention_days: 3 });
  const inherited = await runSetupHub(destination, scripted(["backup_retention_days", "inherit", "save"]), io().io, async () => true);
  expect(inherited).toEqual({});
});
