import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRepositoryConfig, parseConfigSource } from "../src/config";
import { createNewHandler } from "../src/commands/new";
import { discoverRepository } from "../src/git/repository";
import { resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { writeBaseAssociation } from "../src/git/base-metadata";
import { resolveOpenTarget } from "../src/git/open-target";
import { finishWordAt, shortenAtWord } from "../src/branch-shorten";
import { generateTicketBranch, jiraBranchName } from "../src/jira/branch";
import type { TerminalChooser, TerminalTextPrompt } from "../src/selection";
import { createServiceDouble } from "./helpers/services";
import { git, withRepository } from "./helpers/git";

const setting = "max_generated_branch_name_length";
const io = { stdout() {}, stderr() {} };

function handler(env: NodeJS.ProcessEnv, title = "Fix café login now", key = "ENG-123") {
  return createNewHandler(createServiceDouble({
    discoverRepository,
    loadConfig: repository => loadRepositoryConfig(repository, env),
    resolveBase, createWorktree, writeBaseAssociation,
    resolveGithubRepository: async () => ({ owner: "team", name: "project" }),
    resolveGithubTicket: async () => ({ key: "GH-123", title, url: "https://github.com/team/project/issues/123" }),
    resolveLinearTicket: async () => ({ key, title, url: "https://linear.app/team/issue/ENG-123" }),
    resolveJiraTicket: async () => ({ key, title, url: "https://example.atlassian.net/browse/ENG-123" }),
    launchEditor: async () => ({ kind: "skipped" }),
  }));
}

async function configure(primary: string, directory: string, maximum?: number) {
  const env = { HOME: directory, XDG_CONFIG_HOME: join(directory, "config") };
  await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n'
    + (maximum === undefined ? "" : `${setting} = ${maximum}\n`));
  return env;
}

test("generated length inherits global settings and repository overrides them", async () => {
  await withRepository(async (primary, directory) => {
    const env = await configure(primary, directory);
    await mkdir(join(env.XDG_CONFIG_HOME, "timber"), { recursive: true });
    const global = join(env.XDG_CONFIG_HOME, "timber/config.toml");
    await writeFile(global, `${setting} = 20\n`);
    const repository = await discoverRepository(primary);
    expect((await loadRepositoryConfig(repository, env)).maxGeneratedBranchNameLength).toBe(20);
    await configure(primary, directory, 12);
    expect((await loadRepositoryConfig(repository, env)).maxGeneratedBranchNameLength).toBe(12);
    await writeFile(global, `${setting} = 0\n`);
    await expect(loadRepositoryConfig(repository, env)).rejects.toThrow(setting);
  });
});

test.each(["0", "-1", "1.5", "inf", '"20"', "true"])(
  "rejects invalid generated length %s", value => {
    expect(() => parseConfigSource(`${setting} = ${value}`, "settings.toml")).toThrow(setting);
  },
);

test.each([
  ["ENG-123", "Fix café login", 12, "ENG-123-fix"],
  ["ENG-123", "Fix café login", 11, "ENG-123-fix"],
  ["ENG-123", "Fix café login", 9, "ENG-123-f"],
  ["ENG-123", "Fix this issue with number 5", 20, "ENG-123-fix-this"],
  ["ENG-123", "Fix this issue with number 5", 22, "ENG-123-fix-this-issue"],
  ["ENG-123", "Supercalifragilistic thing", 15, "ENG-123-superca"],
  ["ENG-123", "修復 🔧", 13, "ENG-123-issue"],
  ["GH-123", "a".repeat(200), 130, `GH-123-${"a".repeat(123)}`],
] as const)("issue generation preserves full ID and suffix: %s, %s, %i", (key, title, maximum, expected) => {
  expect(jiraBranchName(key, title, maximum)).toBe(expected);
});

test("rejects an integer outside the safe TOML range", () => {
  expect(() => parseConfigSource(`${setting} = 9007199254740992`, "settings.toml")).toThrow("Invalid TOML");
});

test("issue generation refuses limits without room for ID, separator and suffix", () => {
  expect(() => jiraBranchName("ENG-123", "Fix", 8)).toThrow(/ticket key.*suffix/i);
});

test.each(["github:123", "linear:ENG-123", "jira:ENG-123"])(
  "%s uses configured total length in real Git creation and refuses truncated collisions", async selector => {
    await withRepository(async (primary, directory) => {
      const env = await configure(primary, directory, 12);
      if (selector.startsWith("jira:")) {
        await writeFile(join(primary, ".timber.toml"), `base_branch = "trunk"\n${setting} = 12\n[jira]\nsite_url = "https://example.atlassian.net"\n`);
      }
      const run = handler(env);
      await run(selector, {}, { cwd: primary, io });
      const name = selector.startsWith("github:") ? "GH-123-fix" : "ENG-123-fix";
      const target = join(directory, "primary repo-worktrees", name);
      expect(await git(target, "branch", "--show-current")).toBe(name);
      await writeFile(join(target, "tracked.txt"), "preserve target edits\n");
      await writeFile(join(primary, "untracked.txt"), "preserve source\n");
      const refs = await git(primary, "show-ref");
      const trees = await git(primary, "worktree", "list", "--porcelain");
      await expect(handler(env, "Fix café completely different")(selector, {}, { cwd: primary, io }))
        .rejects.toThrow(/Use timber open/);
      expect(await git(primary, "show-ref")).toBe(refs);
      expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
      expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("preserve target edits\n");
      expect(await readFile(join(primary, "untracked.txt"), "utf8")).toBe("preserve source\n");
    });
  }, 30_000,
);

test("sentence truncation counts Unicode code points and removes trailing separators", async () => {
  await withRepository(async (primary, directory) => {
    const env = await configure(primary, directory, 7);
    await handler(env)(" CAFÉ 😀 next ", {}, { cwd: primary, io });
    expect(await git(primary, "show-ref", "--verify", "refs/heads/café-😀")).toContain("refs/heads/café-😀");
    await handler(env)("Fix foo/bar", {}, { cwd: primary, io });
    expect(await git(primary, "show-ref", "--verify", "refs/heads/fix-foo")).toContain("refs/heads/fix-foo");
  });
});

test("truncated sentence collisions and invalid generated names preserve real files and refs", async () => {
  await withRepository(async (primary, directory) => {
    const env = await configure(primary, directory, 8);
    await handler(env)("Fix login first", {}, { cwd: primary, io });
    await writeFile(join(primary, "tracked.txt"), "source edits\n");
    await writeFile(join(primary, "untracked.txt"), "source untracked\n");
    const refs = await git(primary, "show-ref");
    const trees = await git(primary, "worktree", "list", "--porcelain");
    for (const [input, error] of [
      ["Fix login second", /Use timber open/],
      ["Bad [ref suffix", /Invalid branch name/],
      ["jira:ENG-123", /ticket key.*suffix/i],
    ] as const) {
      if (input.startsWith("jira:")) {
        await writeFile(join(primary, ".timber.toml"), `base_branch = "trunk"\n${setting} = 8\n[jira]\nsite_url = "https://example.atlassian.net"\n`);
      }
      await expect(handler(env)(input, {}, { cwd: primary, io })).rejects.toThrow(error);
      expect(await git(primary, "show-ref")).toBe(refs);
      expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
      expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("source edits\n");
      expect(await readFile(join(primary, "untracked.txt"), "utf8")).toBe("source untracked\n");
    }
  });
});

test("explicit names and existing open targets ignore configured generation length", async () => {
  await withRepository(async (primary, directory) => {
    const env = await configure(primary, directory, 1);
    const name = "Feature/Keep-Exact-Long-Name";
    await handler(env)(name, {}, { cwd: primary, io });
    const repository = await discoverRepository(primary);
    const config = await loadRepositoryConfig(repository, env);
    const opened = await resolveOpenTarget(repository, name, config);
    expect(opened.kind).toBe("found");
    expect(await git(primary, "show-ref", "--verify", `refs/heads/${name}`)).toContain(`refs/heads/${name}`);
  });
});

test("unset generation length preserves uncapped sentences and 120-character issue names", async () => {
  await withRepository(async (primary, directory) => {
    const env = await configure(primary, directory);
    const sentence = `Long ${"a".repeat(130)}`;
    await handler(env)(sentence, {}, { cwd: primary, io });
    expect(await git(primary, "show-ref", "--verify", `refs/heads/long-${"a".repeat(130)}`)).toContain("refs/heads/long-");
    await handler(env, "a".repeat(200))("github:123", {}, { cwd: primary, io });
    expect(await git(primary, "show-ref", "--verify", `refs/heads/GH-123-${"a".repeat(113)}`)).toContain("refs/heads/GH-123-");
  });
});

test.each([
  ["Fix foo next", 8, "fix-foo"],
  ["Fix foo/bar", 8, "fix-foo"],
  ["Fix foo_bar", 8, "fix-foo"],
  ["Fix foo.bar", 8, "fix-foo"],
  ["Fix foo", 7, "fix-foo"],
  ["Fix foo", 8, "fix-foo"],
  ["Fix task", 1, "f"],
  ["fix this issue with number 5", 10, "fix-this"],
  ["fix this issue with number 5", 8, "fix-this"],
  ["fix this issue with number 5", 9, "fix-this"],
  ["Supercalifragilistic thing", 8, "supercal"],
] as const)("sentence boundary: %s at %i characters", async (input, maximum, expected) => {
  await withRepository(async (primary, directory) => {
    const env = await configure(primary, directory, maximum);
    await handler(env)(input, {}, { cwd: primary, io });
    expect(await git(primary, "show-ref", "--verify", `refs/heads/${expected}`)).toContain(`refs/heads/${expected}`);
  });
});

test("invalid settings and empty truncated names refuse before real Git mutation", async () => {
  await withRepository(async (primary, directory) => {
    const env = await configure(primary, directory);
    await writeFile(join(primary, "untracked.txt"), "preserve\n");
    const refs = await git(primary, "show-ref");
    const trees = await git(primary, "worktree", "list", "--porcelain");
    for (const [maximum, input, error] of [[0, "Fix task", /max_generated_branch_name_length/], [1, "__ task", /Invalid branch name/]] as const) {
      await configure(primary, directory, maximum);
      await expect(handler(env)(input, {}, { cwd: primary, io })).rejects.toThrow(error);
      expect(await git(primary, "show-ref")).toBe(refs);
      expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
      expect(await readFile(join(primary, "untracked.txt"), "utf8")).toBe("preserve\n");
    }
  });
});


test("truncated destination collision preserves existing path and unchecked branch", async () => {
  await withRepository(async (primary, directory) => {
    const env = await configure(primary, directory, 8);
    await git(primary, "branch", "fix");
    const root = join(directory, "primary repo-worktrees");
    await mkdir(root);
    const target = join(root, "fix-path");
    await writeFile(target, "existing destination\n");
    const refs = await git(primary, "show-ref");
    const trees = await git(primary, "worktree", "list", "--porcelain");
    for (const [input, error] of [["Fix login again", /already exists/], ["Fix path collision", /Worktree path already exists/]] as const) {
      await expect(handler(env)(input, {}, { cwd: primary, io })).rejects.toThrow(error);
      expect(await git(primary, "show-ref")).toBe(refs);
      expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
      expect(await readFile(target, "utf8")).toBe("existing destination\n");
      expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("original\n");
    }
  });
});

const sentence = "fix this issue with number 5";

async function run(
  primary: string, directory: string, input: string, maximum: number,
  context: Partial<{ choose: TerminalChooser; ask: TerminalTextPrompt; interactive: boolean }>,
  title?: string,
) {
  const env = await configure(primary, directory, maximum);
  const output: string[] = [];
  await handler(env, title)(input, {}, {
    cwd: primary, io: { stdout: text => { output.push(text); }, stderr() {} }, ...context,
  });
  return output.join("");
}

function scripted(choice: string | null, answers: (string | null)[]) {
  const prompts: string[] = [];
  const messages: string[] = [];
  const asked: string[] = [];
  const choose: TerminalChooser = async message => { messages.push(message); return choice; };
  const ask: TerminalTextPrompt = async message => { asked.push(message); prompts.push(message); return answers.shift() ?? null; };
  return { choose, ask, messages, asked };
}

test("interactive prompt shows original, proposal and limit; accepting uses the proposal", async () => {
  await withRepository(async (primary, directory) => {
    const prompt = scripted("accept", []);
    await run(primary, directory, sentence, 10, { interactive: true, choose: prompt.choose, ask: prompt.ask });
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]).toContain("fix-this-issue-with-number-5");
    expect(prompt.messages[0]).toContain("fix-this");
    expect(prompt.messages[0]).toContain("(10)");
    expect(prompt.asked).toHaveLength(0);
    expect(await git(primary, "show-ref", "--verify", "refs/heads/fix-this")).toContain("refs/heads/fix-this");
  });
});

test("interactive custom replacement is used and invalid replacements are asked again", async () => {
  await withRepository(async (primary, directory) => {
    const prompt = scripted("custom", ["", "this is far too long", "bad[name", "mine"]);
    const output = await run(primary, directory, sentence, 10, { interactive: true, choose: prompt.choose, ask: prompt.ask });
    expect(prompt.asked).toHaveLength(4);
    expect(output).toContain("must not be blank");
    expect(output).toContain("at most 10");
    expect(output).toContain("Invalid branch name");
    expect(await git(primary, "show-ref", "--verify", "refs/heads/mine")).toContain("refs/heads/mine");
  });
});

test("ticket replacement must keep the ticket key prefix", async () => {
  await withRepository(async (primary, directory) => {
    const prompt = scripted("custom", ["other-name", "ENG-123-ok"]);
    const output = await run(primary, directory, "linear:ENG-123", 14,
      { interactive: true, choose: prompt.choose, ask: prompt.ask }, "Fix this issue now");
    expect(prompt.messages[0]).toContain("ENG-123-fix-this-issue-now");
    expect(output).toContain("must start with ENG-123-");
    expect(await git(primary, "show-ref", "--verify", "refs/heads/ENG-123-ok")).toContain("ENG-123-ok");
  });
});

test.each(["choice", "answer"] as const)("cancelling at the %s prompt leaves files and refs intact", async stage => {
  await withRepository(async (primary, directory) => {
    await writeFile(join(primary, "untracked.txt"), "preserve\n");
    const refs = await git(primary, "show-ref");
    const trees = await git(primary, "worktree", "list", "--porcelain");
    const prompt = stage === "choice" ? scripted(null, []) : scripted("custom", [null]);
    const output = await run(primary, directory, sentence, 10, { interactive: true, choose: prompt.choose, ask: prompt.ask });
    expect(output).toContain("Cancelled.");
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
    expect(await readFile(join(primary, "untracked.txt"), "utf8")).toBe("preserve\n");
  });
});

test("prompt is skipped when the name is within the limit and when not interactive", async () => {
  await withRepository(async (primary, directory) => {
    const prompt = scripted("custom", ["never"]);
    await run(primary, directory, "go now", 10, { interactive: true, choose: prompt.choose, ask: prompt.ask });
    expect(prompt.messages).toHaveLength(0);
    await run(primary, directory, sentence, 10, {});
    expect(await git(primary, "show-ref", "--verify", "refs/heads/fix-this")).toContain("refs/heads/fix-this");
    expect(prompt.messages).toHaveLength(0);
    expect(prompt.asked).toHaveLength(0);
  });
});

const separators = new Set(["-", "_", ".", "/"]);

test("finishWordAt completes the cut word and offers nothing when no word was cut", () => {
  const characters = Array.from("fix-this-issue-with-number-5");
  expect(shortenAtWord(characters, 10, separators)).toBe("fix-this");
  expect(finishWordAt(characters, 10, separators)).toBe("fix-this-issue");
  expect(finishWordAt(Array.from("fix-this-issue"), 8, separators)).toBeUndefined();
  expect(finishWordAt(Array.from("fix-this-issue"), 9, separators)).toBeUndefined();
  expect(finishWordAt(Array.from("short"), 10, separators)).toBeUndefined();
  expect(finishWordAt(Array.from("abc-defgh"), 5, separators)).toBe("abc-defgh");
});

test("ticket generation records the finished name only when a word was cut", () => {
  expect(generateTicketBranch("ENG-123", "Fix this issue now", 14))
    .toEqual({ name: "ENG-123-fix", original: "ENG-123-fix-this-issue-now", finished: "ENG-123-fix-this" });
  expect(generateTicketBranch("ENG-123", "Fix this issue now", 16).finished).toBeUndefined();
  expect(generateTicketBranch("ENG-123", "Fix this issue now").finished).toBeUndefined();
});

test("interactive finish option completes the cut word for sentences", async () => {
  await withRepository(async (primary, directory) => {
    const options: string[] = [];
    const choose: TerminalChooser = async (_message, choices) => {
      options.push(...choices.map(choice => `${choice.value}|${choice.label}|${choice.default === true}`));
      return "finish";
    };
    const prompt = scripted(null, []);
    await run(primary, directory, sentence, 10, { interactive: true, choose, ask: prompt.ask });
    expect(options).toEqual([
      "accept|Use fix-this|true",
      "finish|Finish the cut word: fix-this-issue (14 characters, over the limit)|false",
      "custom|Enter a different branch name|false",
    ]);
    expect(prompt.asked).toHaveLength(0);
    expect(await git(primary, "show-ref", "--verify", "refs/heads/fix-this-issue")).toContain("fix-this-issue");
  });
});

test("interactive finish option completes the cut word for tickets", async () => {
  await withRepository(async (primary, directory) => {
    const prompt = scripted("finish", []);
    await run(primary, directory, "linear:ENG-123", 14,
      { interactive: true, choose: prompt.choose, ask: prompt.ask }, "Fix this issue now");
    expect(await git(primary, "show-ref", "--verify", "refs/heads/ENG-123-fix-this")).toContain("ENG-123-fix-this");
  });
});

test("finish option is absent when the limit does not cut a word", async () => {
  await withRepository(async (primary, directory) => {
    const labels: string[] = [];
    const choose: TerminalChooser = async (_message, choices) => {
      labels.push(...choices.map(choice => choice.value));
      return "accept";
    };
    await run(primary, directory, "fix this issue now", 8, { interactive: true, choose, ask: async () => null });
    expect(labels).toEqual(["accept", "custom"]);
  });
});
