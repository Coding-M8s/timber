import { expect, test } from "bun:test";
import { editSetupSection, questionnaire } from "../src/setup/questions";
import { renderConfig } from "../src/setup/render";
import { parseConfigSource, resolveConfig } from "../src/config";
import type { ConfigFile } from "../src/config";
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

test.each([
  { label: "malformed", input: "not a url" },
  { label: "insecure", input: "http://example.atlassian.net" },
  { label: "wrong host", input: "https://example.invalid" },
  { label: "extra path", input: "https://example.atlassian.net/issues" },
  { label: "embedded credentials", input: "https://person:PRIVATE_VALUE@example.atlassian.net" },
])("Jira rejects a $label URL before asking about token scopes", async ({ input }) => {
  const file: ConfigFile = { remote: "upstream" };
  const capture = io();
  let urlQuestions = 0; let scopesQuestions = 0;
  const prompt: SetupPrompt = {
    select: async () => "configure",
    text: async () => {
      urlQuestions++;
      if (urlQuestions === 1) return input;
      expect(capture.output()).toContain("Invalid Jira URL");
      expect(scopesQuestions).toBe(0);
      expect(file).toEqual({ remote: "upstream" });
      return "https://example.atlassian.net/";
    },
    confirm: async () => {
      scopesQuestions++;
      expect(urlQuestions).toBe(2);
      return false;
    }, close() {},
  };
  await editSetupSection("jira", file, target(file), prompt, capture.io, async () => true);
  expect(file).toEqual({ remote: "upstream", jira: { site_url: "https://example.atlassian.net" } });
  expect(scopesQuestions).toBe(1);
  expect(capture.output()).not.toContain("PRIVATE_VALUE");
});

for (const section of ["hooks", "pre_delete"] as const) {
  test(`${section} offers only None and Add for an empty list`, async () => {
    const file: ConfigFile = {};
    const prompt = scripted([]);
    prompt.select = async (_message, choices, defaultValue) => {
      expect(choices.map(choice => choice.value)).toEqual(["none", "custom"]);
      expect(defaultValue).toBe("none");
      return defaultValue;
    };
    await editSetupSection(section, file, target(), prompt, io().io, async () => true);
    expect(file).toEqual({});
  });

  test(`${section} keeps inherited scripts on Enter through its two-choice editor`, async () => {
    const file: ConfigFile = {};
    const destination = target();
    destination.scopes.global.values = { hooks: { post_create: ["setup"], pre_delete: ["cleanup", "second cleanup"] } };
    const prompt = scripted([]);
    prompt.select = async (message, choices, defaultValue) => {
      if (message.startsWith("Run")) {
        expect(choices.map(choice => choice.value)).toEqual(["none", "custom"]);
        expect(defaultValue).toBe("custom");
      }
      return defaultValue;
    };
    prompt.text = async (_message, defaultValue) => defaultValue ?? "";
    await editSetupSection(section, file, destination, prompt, io().io, async () => true);
    expect(file).toEqual({});
  });

  test(`${section} can remove trailing commands without changing the other list`, async () => {
    const file: ConfigFile = { hooks: {
      post_create: ["setup", "obsolete setup"], pre_delete: ["cleanup", "obsolete cleanup"],
    } };
    const prompt = scripted(["custom", "finish"]);
    let textQuestions = 0;
    prompt.text = async (_message, current) => { textQuestions++; return current ?? ""; };
    await editSetupSection(section, file, target(file), prompt, io().io, async () => true);
    expect(textQuestions).toBe(1);
    expect(file.hooks).toEqual(section === "hooks"
      ? { post_create: ["setup"], pre_delete: ["cleanup", "obsolete cleanup"] }
      : { post_create: ["setup", "obsolete setup"], pre_delete: ["cleanup"] });
  });
}

for (const section of ["editor", "agent", "jira"] as const) {
  test(`${section} has one default None choice when unconfigured`, async () => {
    const file: ConfigFile = {};
    const prompt = scripted([]);
    prompt.select = async (_message, choices, defaultValue) => {
      expect(choices.some(choice => choice.value === "keep" || choice.value === "inherit")).toBe(false);
      expect(defaultValue).toBe("none");
      expect(choices.filter(choice => choice.value === "none")).toHaveLength(1);
      return defaultValue;
    };
    await editSetupSection(section, file, target(), prompt, io().io, async () => true);
    expect(file).toEqual({});
  });

  test(`${section} keeps inheritance and disabling as distinct choices when configured`, async () => {
    const file: ConfigFile = {};
    const destination = target();
    destination.scopes.global.values = {
      editor: { command: "code", args: [], enabled: true },
      agent: { command: "codex", args: [], enabled: true },
      jira: { site_url: "https://example.atlassian.net" },
    };
    const prompt = scripted([]);
    prompt.select = async (_message, choices, defaultValue) => {
      expect(defaultValue).toBe("keep");
      expect(choices.filter(choice => choice.value === "none")).toHaveLength(1);
      expect(choices.some(choice => choice.value === "inherit")).toBe(false);
      return "none";
    };
    await editSetupSection(section, file, destination, prompt, io().io, async () => true);
    expect(file[section]).toBe(false);
  });

  test(`${section} omits a reset that duplicates the current machine setting`, async () => {
    const existing: ConfigFile = {
      editor: { command: "code", args: [], enabled: true },
      agent: { command: "codex", args: [], enabled: true },
      jira: { site_url: "https://example.atlassian.net" },
    };
    const file = structuredClone(existing);
    const destination = target(file);
    destination.scopes.global.values = structuredClone(existing);
    const prompt = scripted([]);
    prompt.select = async (_message, choices, defaultValue) => {
      expect(defaultValue).toBe("keep");
      expect(choices.some(choice => choice.value === "inherit")).toBe(false);
      return defaultValue;
    };
    await editSetupSection(section, file, destination, prompt, io().io, async () => true);
    expect(file).toEqual(existing);
  });
}

for (const section of ["base_branch", "remote", "worktree_dir"] as const) {
  test(`${section} offers one automatic default without a duplicate skip choice`, async () => {
    const file = {};
    const prompt = scripted([]);
    prompt.select = async (_message, choices, defaultValue) => {
      expect(choices.some(choice => choice.value === "keep")).toBe(false);
      expect(defaultValue).toBe("automatic");
      return defaultValue;
    };
    await editSetupSection(section, file, target(), prompt, io().io, async () => true);
    expect(file).toEqual({});
  });

  test(`${section} retains a saved value without duplicating matching machine defaults`, async () => {
    const file = { [section]: "same-value" };
    const destination = target(file);
    destination.scopes.global.values = { [section]: "same-value" };
    const prompt = scripted([]);
    prompt.select = async (_message, choices, defaultValue) => {
      expect(defaultValue).toBe("keep");
      expect(choices.some(choice => choice.value === "automatic")).toBe(false);
      return defaultValue;
    };
    await editSetupSection(section, file, destination, prompt, io().io, async () => true);
    expect(file).toEqual({ [section]: "same-value" });
  });
}

for (const section of ["editor", "agent"] as const) {
  test(`${section} rejects a relative executable before availability checking`, async () => {
    const file = {};
    const capture = io();
    const checked: string[] = [];
    await editSetupSection(section, file, target(), scripted([
      "custom", "./tools/launcher", "[]", "none",
    ]), capture.io, async command => { checked.push(command); return true; });
    expect(file).toEqual({});
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
      enabled: false,
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
    "code", false, "codex", false, "none", true, "none", "none", "automatic", "automatic", "automatic",
  ]), capture.io, async () => true);
  expect(file?.editor).toEqual({ command: "code", args: ["--new-window"], enabled: false });
  expect(file?.agent).toEqual({ command: "codex", args: [], enabled: false });
  expect(file?.hooks).toBeUndefined();
  expect(file?.jira).toBeUndefined();
});

test("setup stores the editor command while defaulting automatic launch off", async () => {
  const file = {};
  const questions: string[] = [];
  const prompt = scripted(["code", false]);
  const confirm = prompt.confirm;
  prompt.confirm = async (message, current) => {
    questions.push(message);
    expect(current).toBe(false);
    return confirm(message, current);
  };
  await editSetupSection("editor", file, target(), prompt, io().io, async () => true);
  expect(file).toEqual({ editor: { command: "code", args: ["--new-window"], enabled: false } });
  expect(questions).toEqual(["Open this editor automatically when opening a workspace?"]);
  expect(parseConfigSource(renderConfig(file), "saved.toml").editor)
    .toEqual({ command: "code", args: ["--new-window"], enabled: false });
});

test("setup can opt in to automatic editor launch", async () => {
  const file = {};
  await editSetupSection("editor", file, target(), scripted(["zed", true]), io().io, async () => true);
  expect(parseConfigSource(renderConfig(file), "saved.toml").editor)
    .toEqual({ command: "zed", args: ["--new"], enabled: true });
});

test("keeping existing values retains custom arguments hooks and explicit off without flattening inheritance", async () => {
  const existing = { editor: false as const, agent: { command: "wrapper", args: ["  literal  "], enabled: true },
    hooks: { post_create: [" printf 'a' "] }, remote: "upstream" };
  const file = await questionnaire(target(existing), scripted([
    "none", "keep", "inherit", false,
  ]), io().io, async () => true);
  expect(file).toEqual(existing);
  expect(file).not.toHaveProperty("worktree_dir");
});

test.each(["local", "global"])("editing setup scripts retains %s pre-deletion hooks through save", async scope => {
  const hooks = { post_create: ["old setup"], pre_delete: [" printf cleanup "] };
  const file = scope === "local" ? { hooks } : {};
  const destination = target(file);
  if (scope === "global") destination.scopes.global.values = { hooks };
  await editSetupSection("hooks", file, destination, scripted(["custom", "new setup", "finish"]),
    io().io, async () => true);
  expect(parseConfigSource(renderConfig(file), "saved.toml").hooks)
    .toEqual({ post_create: ["new setup"], pre_delete: [" printf cleanup "] });
});

test.each(["local", "global"])("editing pre-done scripts retains %s creation scripts through save", async scope => {
  const hooks = { post_create: [" printf 'setup' "], pre_delete: ["old cleanup"] };
  const file: ConfigFile = scope === "local" ? { hooks } : {};
  const destination = target(file);
  if (scope === "global") destination.scopes.global.values = { hooks };
  await editSetupSection("pre_delete", file, destination, scripted([
    "custom", "", "bad\0command", " printf 'cleanup' ", "finish",
  ]), io().io, async () => { throw new Error("Hooks must never run during setup"); });
  expect(parseConfigSource(renderConfig(file), "saved.toml").hooks)
    .toEqual({ post_create: [" printf 'setup' "], pre_delete: [" printf 'cleanup' "] });
});

test.each(["hooks", "pre_delete"] as const)("disabling %s preserves the other inherited script list", async section => {
  const file: ConfigFile = {};
  const destination = target(file);
  destination.scopes.global.values = { hooks: { post_create: ["setup"], pre_delete: ["cleanup"] } };
  await editSetupSection(section, file, destination, scripted(["none"]), io().io, async () => true);
  expect(parseConfigSource(renderConfig(file), "saved.toml").hooks).toEqual(section === "hooks"
    ? { post_create: [], pre_delete: ["cleanup"] } : { post_create: ["setup"], pre_delete: [] });
});

test("materializing local hooks does not alias machine-default script arrays", async () => {
  const globalHooks = { post_create: ["setup"], pre_delete: ["cleanup"] };
  const file: ConfigFile = {};
  const destination = target(file);
  destination.scopes.global.values = { hooks: globalHooks };
  await editSetupSection("hooks", file, destination, scripted(["none"]), io().io, async () => true);
  expect(file.hooks).toEqual({ post_create: [], pre_delete: ["cleanup"] });
  expect(typeof file.hooks).toBe("object");
  const local = file.hooks as { post_create: string[]; pre_delete: string[] };
  local.pre_delete.push("mutated");
  expect(globalHooks.pre_delete).toEqual(["cleanup"]);
});

test("guided advanced setup includes a pre-done script step", async () => {
  const file = await questionnaire(target(), scripted([
    "none", "none", "none", true, "none", "custom", "printf cleanup", "finish", "automatic", "automatic", "automatic",
  ]), io().io, async () => true);
  expect(file?.hooks).toEqual({ post_create: [], pre_delete: ["printf cleanup"] });
});

test("guided setup preserves named workflow definitions and disables during save", async () => {
  const existing = parseConfigSource([
    '[workflows.review]', 'post_create = ["printf review"]',
    '[workflows.review.editor]', 'command = "zed"', 'args = ["--new"]',
    '[workflows]', 'investigate = false',
  ].join("\n"), "test.toml");
  const file = await questionnaire(target(existing), scripted(["none", "none", "none", false]), io().io,
    async () => true);
  expect(parseConfigSource(renderConfig(file!), "saved.toml").workflows).toEqual(existing.workflows);
});

test("custom commands, hooks, and Jira values round trip with literal quotes and paths", async () => {
  const capture = io();
  const file = await questionnaire(target(), scripted([
    "custom", "my editor", '["a\\\"b", "$(touch nope)", ""]',
    false,
    "claude", true, "jira", "https://example.atlassian.net/", true, "00000000-0000-4000-8000-000000000000",
    true, "custom", "printf 'one'", "add", "echo two", "finish", "none",
    "custom", "trunk", "custom", "upstream", "custom", " ../work trees ",
  ]), capture.io, async () => true);
  expect(file?.hooks).toEqual({ post_create: ["printf 'one'", "echo two"] });
  const source = renderConfig(file!);
  const parsed = parseConfigSource(source, "test.toml");
  const result = resolveConfig({ local: { path: "test.toml", source, values: parsed },
    global: { path: "global.toml", source: null, values: {} } }, "/repo");
  expect(result.editor).toEqual({ command: "my editor", args: ['a"b', "$(touch nope)", ""], enabled: false });
  expect(result.jira).toEqual({ siteUrl: "https://example.atlassian.net", cloudId: "00000000-0000-4000-8000-000000000000" });
  expect(capture.output()).not.toContain("alias");
});

test("a missing executable offers off and never saves an unusable selection silently", async () => {
  const capture = io();
  const file = await questionnaire(target(), scripted([
    "zed", "none", "none", "none", false,
  ]), capture.io, async () => false);
  expect(file?.editor).toBeUndefined();
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
  const destination = target({ editor: false, agent: false, jira: false });
  destination.scopes.global.values = { editor: { command: "code", args: ["--new-window"], enabled: false },
    agent: { command: "codex", args: [], enabled: true }, hooks: { post_create: ["global hook"] },
    jira: { site_url: "https://global.atlassian.net" } };
  const file = await questionnaire(destination, scripted([
    "inherit", "inherit", "inherit", true, "custom", "global hook", "finish", "none", "automatic", "automatic", "automatic",
  ]), io().io, async () => true);
  expect(file).toEqual({ jira: false });
  expect(resolveConfig({ ...destination.scopes, local: { ...destination.file, values: file! } }, "/repo").agent)
    .toEqual({ command: "codex", args: [], enabled: true });
});

test("selecting inheritance checks the newly effective global editor executable", async () => {
  const destination = target({ editor: { command: "local", args: [], enabled: false } });
  destination.scopes.global.values = { editor: { command: "missing-global", args: [], enabled: false } };
  const capture = io();
  const file = await questionnaire(destination, scripted([
    "inherit", "none", "none", false,
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
      expect(choices.find(choice => choice.value === defaultValue)?.label).toMatch(/None|Inherit machine default/u);
      return defaultValue;
    },
    confirm: async message => { questions.push(message); return false; },
    text: async () => { throw new Error("Quick setup must not request text"); }, close() {},
  };
  expect(await questionnaire(target(), prompt, io().io, async () => true)).toEqual({});
  expect(questions).toHaveLength(4);
  expect(questions.join(" ")).toContain("Which issue tracker do you use?");
  expect(questions.join(" ")).not.toContain("alias");
  expect(questions.join(" ")).not.toContain("base_branch");
});

test("reselecting an assistant keeps the existing setup dependency preference", async () => {
  const file = { agent: { command: "claude", args: [], enabled: true, wait_for_setup: true } };
  await editSetupSection("agent", file, target(file), scripted(["codex", false]), io().io, async () => true);
  expect(file.agent).toEqual({ command: "codex", args: [], wait_for_setup: true, enabled: false });
  const inherited = {};
  const scoped = target();
  scoped.scopes.global.values = { agent: { command: "claude", args: [], enabled: false, wait_for_setup: true } };
  await editSetupSection("agent", inherited, scoped, scripted(["claude", true]), io().io, async () => true);
  expect(inherited).toEqual({ agent: { command: "claude", args: [], wait_for_setup: true, enabled: true } });
  expect(parseConfigSource(renderConfig(inherited), "saved.toml").agent).toMatchObject({ wait_for_setup: true });
});

test("setup offers Orca terminals as an editor and asks whether the assistant waits for setup", async () => {
  const checked: string[] = [];
  const confirms: string[] = [];
  const prompt = scripted(["orca", true, "claude", true, true, "none", false]);
  const confirm = prompt.confirm;
  prompt.confirm = async (message, current) => { confirms.push(message); return confirm(message, current); };
  const file = await questionnaire(target(), prompt, io().io, async command => { checked.push(command); return true; });
  expect(file?.editor).toEqual({ command: "orca-ide", args: [], enabled: true, integration: "orca" });
  expect(file?.agent).toEqual({ command: "claude", args: [], enabled: true, wait_for_setup: true });
  expect(checked).toEqual(["orca-ide", "claude"]);
  expect(confirms[0]).toMatch(/Orca terminals/);
  expect(confirms[2]).toMatch(/wait for setup/i);
  expect(parseConfigSource(renderConfig(file!), "saved.toml")).toMatchObject({
    editor: { integration: "orca" }, agent: { wait_for_setup: true } });
});

test("setup offers VS Code terminals with the Timber extension and asks whether the assistant waits for setup", async () => {
  const confirms: string[] = [];
  const labels: string[] = [];
  const prompt = scripted(["vscodeTerminals", true, "claude", true, false, "none", false]);
  const confirm = prompt.confirm;
  prompt.confirm = async (message, current) => { confirms.push(message); return confirm(message, current); };
  const select = prompt.select;
  prompt.select = async (message, choices, defaultValue) => {
    labels.push(...choices.map(choice => choice.label));
    return select(message, choices, defaultValue);
  };
  const file = await questionnaire(target(), prompt, io().io, async () => true);
  expect(file?.editor).toEqual({ command: "code", args: ["--new-window"], enabled: true, integration: "vscode" });
  expect(file?.agent).toEqual({ command: "claude", args: [], enabled: true, wait_for_setup: false });
  expect(labels).toContain("VS Code terminals (setup and assistant in VS Code; needs the Timber extension)");
  expect(confirms[0]).toMatch(/VS Code terminals/);
  expect(confirms[2]).toMatch(/wait for setup/i);
  expect(parseConfigSource(renderConfig(file!), "saved.toml")).toMatchObject({ editor: { integration: "vscode" } });
});

test("the wait-for-setup question follows the effective Orca editor, including machine defaults and kept assistants", async () => {
  const inheritedOrca = target();
  inheritedOrca.scopes.global.values = { editor: { command: "orca-ide", args: [], enabled: true, integration: "orca" } };
  const fresh: ConfigFile = {};
  await editSetupSection("agent", fresh, inheritedOrca, scripted(["claude", false, true]), io().io, async () => true);
  expect(fresh).toEqual({ agent: { command: "claude", args: [], enabled: false, wait_for_setup: true } });

  const kept: ConfigFile = { editor: { command: "orca-ide", args: [], enabled: true, integration: "orca" as const },
    agent: { command: "claude", args: [], enabled: true } };
  await editSetupSection("agent", kept, target(kept), scripted(["keep", true]), io().io, async () => true);
  expect(kept.agent).toEqual({ command: "claude", args: [], enabled: true, wait_for_setup: true });

  const inheritedAgent: ConfigFile = { editor: { command: "orca-ide", args: [], enabled: true, integration: "orca" as const } };
  const scoped = target(inheritedAgent);
  scoped.scopes.global.values = { agent: { command: "claude", args: [], enabled: true } };
  await editSetupSection("agent", inheritedAgent, scoped, scripted(["keep", false]), io().io, async () => true);
  expect(inheritedAgent).not.toHaveProperty("agent");

  const generic: ConfigFile = { editor: { command: "code", args: [], enabled: true } };
  await editSetupSection("agent", generic, target(generic), scripted(["codex", true]), io().io, async () => true);
  expect(generic).toEqual({ editor: { command: "code", args: [], enabled: true }, agent: { command: "codex", args: [], enabled: true } });
});

test.each(["keep", "inherit"])("Orca dependency can override a global assistant through %s without losing its settings", async selected => {
  const globalAgent = { command: "/opt/assistant wrapper", args: ["literal prompt", "--flag"], enabled: true, wait_for_setup: false };
  const file: ConfigFile = { editor: { command: "orca-ide", args: [], enabled: true, integration: "orca" },
    ...(selected === "inherit" ? { agent: { command: "old-local", args: [], enabled: false, wait_for_setup: true } } : {}) };
  const scoped = target(file);
  scoped.scopes.global.values = { agent: globalAgent };
  const prompt = scripted([selected, true]);
  const confirm = prompt.confirm;
  let questions = 0;
  prompt.confirm = async (message, current) => {
    questions++;
    expect(message).toMatch(/wait for setup/i);
    expect(current).toBe(false);
    return confirm(message, current);
  };
  await editSetupSection("agent", file, scoped, prompt, io().io, async () => true);
  expect(questions).toBe(1);
  expect(file.agent).toEqual({ command: "/opt/assistant wrapper", args: ["literal prompt", "--flag"], enabled: true, wait_for_setup: true });
  expect(globalAgent.wait_for_setup).toBe(false);
  expect(parseConfigSource(renderConfig(file), "saved.toml").agent).toEqual(file.agent);
});

test("keeping an inherited setup dependency leaves future global agent changes inheritable", async () => {
  const file: ConfigFile = { editor: { command: "orca-ide", args: [], enabled: true, integration: "orca" },
    agent: { command: "old-local", args: [], enabled: false } };
  const scoped = target(file);
  scoped.scopes.global.values = { agent: { command: "global-agent", args: ["global"], enabled: true, wait_for_setup: true } };
  await editSetupSection("agent", file, scoped, scripted(["inherit", true]), io().io, async () => true);
  expect(file).not.toHaveProperty("agent");
});

test("rebase --resolve section sets, keeps and clears the handoff on this scope's assistant", async () => {
  const file: ConfigFile = { agent: { command: "claude", args: ["--flag"], enabled: false } };
  await editSetupSection("rebase_resolve", file, target(file), scripted(["claude", "  Run tests first.  "]), io().io, async () => true);
  expect(file.agent).toEqual({ command: "claude", args: ["--flag"], enabled: false, resolve_handoff: "claude", resolve_instructions: "Run tests first." });
  expect(parseConfigSource(renderConfig(file), "saved.toml").agent).toEqual(file.agent);
  await editSetupSection("rebase_resolve", file, target(file), scripted(["keep", "remove"]), io().io, async () => true);
  expect(file.agent).toEqual({ command: "claude", args: ["--flag"], enabled: false, resolve_handoff: "claude" });
  await editSetupSection("rebase_resolve", file, target(file), scripted(["codex", "Kept? no"]), io().io, async () => true);
  expect(file.agent).toEqual({ command: "claude", args: ["--flag"], enabled: false, resolve_handoff: "codex", resolve_instructions: "Kept? no" });
  await editSetupSection("rebase_resolve", file, target(file), scripted(["keep", "edit", ""]), io().io, async () => true);
  expect(file.agent).toEqual({ command: "claude", args: ["--flag"], enabled: false, resolve_handoff: "codex" });
  await editSetupSection("rebase_resolve", file, target(file), scripted(["none"]), io().io, async () => true);
  expect(file.agent).toEqual({ command: "claude", args: ["--flag"], enabled: false });
});

test("rebase --resolve section needs an assistant in the edited scope and reselecting the assistant drops the handoff", async () => {
  const capture = io();
  const inherited: ConfigFile = {};
  const scoped = target(inherited);
  scoped.scopes.global.values = { agent: { command: "codex", args: [], enabled: false } };
  await editSetupSection("rebase_resolve", inherited, scoped, scripted([]), capture.io, async () => true);
  expect(inherited).toEqual({});
  expect(capture.output()).toContain("timber setup --global");
  const file: ConfigFile = { agent: { command: "claude", args: [], enabled: false, resolve_handoff: "claude" } };
  await editSetupSection("agent", file, target(file), scripted(["codex", false]), io().io, async () => true);
  expect(file.agent).toEqual({ command: "codex", args: [], enabled: false });
});
