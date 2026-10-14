import { expect, test } from "bun:test";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { decodeBashInput, renderBashCompletion } from "../src/completion/bash";
import { runCompletionTerminal } from "./helpers/completion-terminal";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const releaseExecutable = process.env.TIMBER_COMPLETION_EXECUTABLE
  ? resolve(process.env.TIMBER_COMPLETION_EXECUTABLE)
  : undefined;
const backend = releaseExecutable ? { executable: releaseExecutable } : { entry };

const wordbreaks = " \t\n'\"@><=;|&(:";

function input(line: string, point = Array.from(line).length, words?: readonly string[]) {
  const suppliedWords = words ?? line.trim().split(/\s+/u);
  return {
    cword: Math.max(0, suppliedWords.length - 1),
    point,
    line,
    wordbreaks,
    words: suppliedWords,
  };
}

test("generated Bash completion inserts the open command and registers once after repeated sourcing", async () => {
  const result = await runCompletionTerminal({
    script: renderBashCompletion(),
    candidates: ["open"],
    input: "timber \t\r",
    sourceTwice: true,
    queryStderr: "suppressed backend diagnostic",
  });
  expect(result.code).toBe(0);
  expect(result.output.match(/complete -F _timber_complete timber/gu)).toHaveLength(1);
  expect(result.argv).toEqual(["open"]);
  expect(result.queryArgs?.slice(0, 6)).toEqual(["completion", "__query", "--", "1", "7", "timber "]);
  expect(result.queryArgs?.slice(-2)).toEqual(["timber", ""]);
  expect(result.output).not.toContain("suppressed backend diagnostic");
});

for (const candidate of [
  "/tmp/tree with spaces",
  "/tmp/tree'quote",
  '/tmp/tree"quote',
  "/tmp/tree$(touch SENTINEL)",
  "/tmp/tree`touch SENTINEL`",
  "/tmp/tree;touch SENTINEL",
  "/tmp/tree\\slash[glob]*",
  "/tmp/tree=café",
]) {
  test(`Readline inserts the selector literally: ${JSON.stringify(candidate)}`, async () => {
    const result = await runCompletionTerminal({
      script: renderBashCompletion(),
      candidates: [candidate],
      input: "timber open \t\r",
    });
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.argv).toEqual(["open", candidate]);
    expect(result.sentinelCreated).toBe(false);
    expect(result.output).toContain("timber open");
  });
}

test("multiple matches remain choices and do not silently select one", async () => {
  const result = await runCompletionTerminal({
    script: renderBashCompletion(),
    candidates: ["topic-one", "topic-two"],
    input: "timber open topic-\t\t\r",
  });
  expect(result.code).toBe(0);
  expect(result.output).toContain("topic-one");
  expect(result.output).toContain("topic-two");
  expect(result.argv).toEqual(["open", "topic-"]);
});

test("Readline does not append a directory slash to a selected worktree path", async () => {
  const result = await runCompletionTerminal({
    script: renderBashCompletion(),
    candidates: ["topic"],
    directories: directory => [`${directory}/topic`],
    input: "timber open \t\r",
  });
  expect(result.code).toBe(0);
  expect(result.argv).toEqual(["open", "topic"]);
});

for (const [description, line, current, prefixWords] of [
  ["open single quote", "timber open '/tmp/tree with", "/tmp/tree with", ["timber", "open"]],
  ["open double quote", 'timber open "/tmp/tree with', "/tmp/tree with", ["timber", "open"]],
  ["decode an escaped space", "timber open /tmp/tree\\ with", "/tmp/tree with", ["timber", "open"]],
  ["keep equals within a selector", "timber open feature=value", "feature=value", ["timber", "open"]],
  ["stop at the cursor before a suffix", "timber open café-branch", "café-", ["timber", "open"]],
] as const) {
  test(`Bash input decoder can ${description}`, () => {
    const fullLine = line;
    const cursor = description === "stop at the cursor before a suffix"
      ? Array.from("timber open café-").length
      : Array.from(fullLine).length;
    const actualWords = description === "keep equals within a selector"
      ? ["timber", "open", "feature", "=", "value"]
      : [...prefixWords, current];
    const decoded = decodeBashInput(input(fullLine, cursor, actualWords));
    expect(decoded).toEqual({ words: prefixWords, current });
  });
}

for (const line of [
  "timber open $(touch SENTINEL)",
  "timber open `touch SENTINEL`",
  "timber open target; touch SENTINEL",
]) {
  test(`Bash input decoder rejects shell syntax without evaluating it: ${JSON.stringify(line)}`, () => {
    expect(decodeBashInput(input(line))).toBeNull();
  });
}

test("Readline completes an escaped prefix, partial quote, cursor suffix, and equals selector", async () => {
  const cases = [
    { candidate: "/tmp/tree with spaces", line: "timber open /tmp/tree\\ with\t\r" },
    { candidate: "/tmp/tree with spaces", line: "timber open '/tmp/tree wit\t\r" },
    { candidate: "/tmp/tree with spaces", line: 'timber open "/tmp/tree wit\t\r' },
    { candidate: "/tmp/tree'quote", line: "timber open '/tmp/tree\t\r" },
    { candidate: "/tmp/tree$(touch SENTINEL)", line: "timber open '/tmp/tree\t\r" },
    { candidate: '/tmp/tree`touch SENTINEL`', line: 'timber open "/tmp/tree\t\r' },
    { candidate: "candidate", line: "timber open candi_suffix\u001b[D\u001b[D\u001b[D\u001b[D\u001b[D\u001b[D\u001b[D\t\r", expected: "candidate_suffix" },
    { candidate: "café-branch", line: "timber open café-\t\r" },
    { candidate: "feature=value", line: "timber open feature=\t\r" },
  ];
  for (const item of cases) {
    const result = await runCompletionTerminal({ script: renderBashCompletion(), candidates: [item.candidate], input: item.line });
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.argv).toEqual(["open", item.expected ?? item.candidate]);
    expect(result.sentinelCreated).toBe(false);
    if (item.candidate === "café-branch") {
      expect(result.queryArgs?.[4]).toBe(String(Array.from("timber open café-").length));
      expect(result.queryArgs?.[5]).toBe("timber open café-");
    }
  }
});

test("the shipped script loads twice through process substitution and completes commands and flags outside Git", async () => {
  const result = await runCompletionTerminal({
    backend,
    sourceCommand: "source <(timber completion bash)",
    sourceTwice: true,
    inputs: [
      "timber comp\t\r",
      "timber new --ag\t\r",
      "timber open /tmp/timber-completion-no-target\t\r",
      "timber open feature=value --no-e\t\r",
    ],
  });
  expect(result.code).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.output.match(/complete -F _timber_complete timber/gu)).toHaveLength(1);
  expect(result.queryCalls).toHaveLength(4);
  expect(result.argvCalls).toEqual([
    ["new", "--agent"],
    ["open", "/tmp/timber-completion-no-target"],
    ["open", "feature=value", "--no-editor"],
  ]);
  expect(result.homeEntries).toEqual([]);
  expect(result.output).not.toContain("Before using Timber");
  expect(result.output).not.toContain("suppressed backend diagnostic");
});

test("the documented completion file runs the shipped entry outside Git", async () => {
  await withRepository(async (_primary, directory) => {
    const generationHome = join(directory, "completion generation home");
    const xdgConfig = join(directory, "completion generation config");
    const xdgState = join(directory, "completion generation state");
    await mkdir(generationHome);
    const generated = await execa(
      releaseExecutable ?? process.execPath,
      releaseExecutable ? ["completion", "bash"] : ["--no-env-file", entry, "completion", "bash"],
      {
        cwd: directory,
        env: {
          CI: "true", HOME: generationHome, XDG_CONFIG_HOME: xdgConfig, XDG_STATE_HOME: xdgState,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
        stripFinalNewline: false,
        timeout: 5000,
      },
    );
    expect(await readdir(generationHome)).toEqual([]);
    await expect(access(xdgConfig)).rejects.toThrow();
    await expect(access(xdgState)).rejects.toThrow();
    const result = await runCompletionTerminal({
      script: generated.stdout,
      installScript: true,
      backend,
      sourceTwice: true,
      input: "timber op\t\r",
    });
    expect(result.code).toBe(0);
    expect(result.queryCalls).toHaveLength(1);
    expect(result.argvCalls).toEqual([["open"]]);
    expect(result.homeEntries).toEqual([
      ".local",
      ".local/share",
      ".local/share/bash-completion",
      ".local/share/bash-completion/completions",
      ".local/share/bash-completion/completions/timber",
    ]);
    expect(result.output).not.toContain("Before using Timber");
  });
});

test("the shipped completion handles Bash word breaks inside an equals selector", async () => {
  await withRepository(async (primary) => {
    await git(primary, "branch", "feature=value");
    const result = await runCompletionTerminal({
      backend,
      sourceCommand: "source <(timber completion bash)",
      cwd: primary,
      input: "timber open feature=\t\r",
    });

    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.queryCalls).toHaveLength(1);
    expect(result.queryArgs?.slice(3, 6)).toEqual([
      "3", String(Array.from("timber open feature=").length), "timber open feature=",
    ]);
    expect(result.argvCalls).toEqual([["open", "feature=value"]]);
    expect(result.output).not.toContain("Before using Timber");
  });
});

test("missing Git yields an empty quiet Bash reply without filesystem fallback", async () => {
  await withRepository(async (_primary, directory) => {
    const noGitPath = join(directory, "empty executable path");
    await mkdir(noGitPath);
    const result = await runCompletionTerminal({
      backend,
      sourceCommand: "source <(timber completion bash)",
      cwd: directory,
      env: { PATH: noGitPath },
      input: "timber open /tmp/timber-completion-no-fallback\t\r",
    });
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.queryCalls).toHaveLength(1);
    expect(result.argvCalls).toEqual([["open", "/tmp/timber-completion-no-fallback"]]);
    expect(result.homeEntries).toEqual([]);
    expect(result.output).not.toContain("Before using Timber");
  });
});

test("real open and done completion works from primary, nested, linked, and detached working directories", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "completion linked worktree");
    const nestedPrimary = join(primary, "nested cwd");
    const detached = join(directory, "completion detached worktree");
    await git(primary, "worktree", "add", "-b", "TIM-23-linked", linked);
    await git(primary, "worktree", "add", "--detach", detached);
    await mkdir(nestedPrimary);
    await writeFile(join(linked, "untracked-preserved.txt"), "keep this file\n");
    await writeFile(join(linked, ".env"), "ignored content\n");
    const before = {
      refs: await git(primary, "show-ref"),
      inventory: await git(primary, "worktree", "list", "--porcelain", "-z"),
      untracked: await readFile(join(linked, "untracked-preserved.txt"), "utf8"),
      ignored: await readFile(join(linked, ".env"), "utf8"),
    };
    const directories = [primary, nestedPrimary, linked, detached];

    for (const cwd of directories) {
      const inputs = [
        "timber open TIM-23-\t\r",
        "timber open --no-editor TIM-23-\t\r",
        "timber open TIM-23-linked --no-editor\t\r",
        "timber done -- TIM-23-\t\r",
        "timber done TIM-23-linked --no-editor\t\r",
        "timber done tru\t\r",
      ];
      const result = await runCompletionTerminal({
        backend,
        sourceCommand: "source <(timber completion bash)",
        cwd,
        inputs,
      });
      expect(result.code).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.argvCalls).toEqual([
        ["open", "TIM-23-linked"],
        ["open", "--no-editor", "TIM-23-linked"],
        ["open", "TIM-23-linked", "--no-editor"],
        ["done", "--", "TIM-23-linked"],
        ["done", "TIM-23-linked", "--no-editor"],
        ["done", "tru"],
      ]);
      expect(result.queryCalls).toHaveLength(inputs.length);
      expect(result.queryCalls.map(args => args[5])).toEqual([
        "timber open TIM-23-",
        "timber open --no-editor TIM-23-",
        "timber open TIM-23-linked --no-editor",
        "timber done -- TIM-23-",
        "timber done TIM-23-linked --no-editor",
        "timber done tru",
      ]);
      expect(result.homeEntries).toEqual([]);
      expect(result.output).not.toContain("Before using Timber");
    }

    expect({
      refs: await git(primary, "show-ref"),
      inventory: await git(primary, "worktree", "list", "--porcelain", "-z"),
      untracked: await readFile(join(linked, "untracked-preserved.txt"), "utf8"),
      ignored: await readFile(join(linked, ".env"), "utf8"),
    }).toEqual(before);
  });
});

test("real Bash queries see worktree additions and removals between Tabs in one shell", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "fresh completion worktree");
    await mkdir(join(primary, "fresh-filesystem-fallback"));
    const result = await runCompletionTerminal({
      backend,
      sourceCommand: "source <(timber completion bash)",
      cwd: primary,
      inputs: ["timber done fresh\t\r", "timber done fresh\t\r", "timber done fresh\t\r"],
      betweenInputs: [
        async () => git(primary, "worktree", "add", "-b", "fresh-target", linked).then(() => undefined),
        async () => { await git(primary, "worktree", "remove", linked); },
      ],
    });
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.queryCalls).toHaveLength(3);
    expect(result.argvCalls).toEqual([
      ["done", "fresh"],
      ["done", "fresh-target"],
      ["done", "fresh"],
    ]);
  });
});

test("real Git paths with shell metacharacters insert literally in unquoted and quoted prefixes", async () => {
  await withRepository(async (primary, directory) => {
    const root = join(directory, "completion path targets");
    await mkdir(root);
    const suffixes = [
      " tree with spaces",
      "'quote",
      '"quote',
      "$(touch SENTINEL)",
      "`touch SENTINEL`",
      ";touch SENTINEL",
      "\\slash[glob]*",
      "=café",
    ];
    for (const [index, suffix] of suffixes.entries()) {
      const safeStem = `literal-case-${index}`;
      const path = join(root, `${safeStem}${suffix}`);
      const branch = [
        `literal-branch-${index}+plus`,
        `literal-branch-${index}=equals`,
        `literal-branch-${index};semi`,
        `literal-branch-${index}$cash`,
        `literal-branch-${index}\`tick`,
        `literal-branch-${index}'quote`,
        `literal-branch-${index}.café`,
        `literal-branch-${index}-plain`,
      ][index]!;
      await git(primary, "check-ref-format", `refs/heads/${branch}`);
      await git(primary, "worktree", "add", "-b", branch, path);
      const typedPrefix = `${root}/${safeStem}`;
      const escapedPrefix = typedPrefix.replace(/[\\\s'"$`;&|<>()[\]{}*!?#~=]/gu, "\\$&");
      const quotedPrefix = index % 2 === 0 ? `'${typedPrefix}` : `"${typedPrefix}`;
      const result = await runCompletionTerminal({
        backend,
        sourceCommand: "source <(timber completion bash)",
        cwd: primary,
        inputs: [
          `timber open ${escapedPrefix}\t\r`,
          `timber open ${quotedPrefix}\t\r`,
          `timber done literal-branch-${index}\t\r`,
        ],
      });
      expect(result.code).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.argvCalls).toEqual([
        ["open", path],
        ["open", path],
        ["done", branch],
      ]);
      expect(result.sentinelCreated).toBe(false);
      await expect(access(join(primary, "SENTINEL"))).rejects.toThrow();
      await git(primary, "worktree", "remove", path);
    }
  });
});
