import { expect, test } from "bun:test";
import type { CommandContext } from "../src/services";
import { createProgram, runCli } from "../src/cli";
import { complete, completionCatalog } from "../src/completion/candidates";
import type { CompletionCommand, CompletionServices } from "../src/completion/candidates";

function context(output: { stdout: string; stderr: string }): CommandContext {
  return {
    cwd: "/repo",
    io: {
      stdout: text => { output.stdout += text; },
      stderr: text => { output.stderr += text; },
    },
  };
}

function catalog() {
  return completionCatalog(createProgram({ context: context({ stdout: "", stderr: "" }) }));
}

function command(catalogValue: ReturnType<typeof catalog>, name: string): CompletionCommand {
  const found = catalogValue.commands.find(item => item.name === name);
  if (!found) throw new Error(`missing completion command ${name}`);
  return found;
}

const neverListTargets: CompletionServices = {
  listTargets: async () => { throw new Error("target lookup should not run in this context"); },
};

test("Commander catalog reflects visible commands and actual options, including built-in help", () => {
  const program = createProgram({ context: context({ stdout: "", stderr: "" }) });
  program.command("inspect").option("--extra-value <value>", "test-only value");
  const result = completionCatalog(program);
  const rootNames = result.rootFlags.map(flag => flag.name);
  expect(rootNames).toEqual(expect.arrayContaining(["-h", "--help", "-V", "--version"]));

  const newCommand = command(result, "new");
  expect(newCommand.flags.map(flag => flag.name)).toEqual(expect.arrayContaining([
    "--agent", "--no-agent", "--base", "--no-editor", "-h", "--help",
  ]));
  expect(newCommand.flags.find(flag => flag.name === "--base")?.takesValue).toBe(true);

  const open = command(result, "open");
  const done = command(result, "done");
  const setup = command(result, "setup");
  expect(open.flags.map(flag => flag.name)).toContain("--no-editor");
  expect(open.flags.map(flag => flag.name)).not.toContain("--keep-branch");
  expect(done.flags.map(flag => flag.name)).toContain("--keep-branch");
  expect(done.flags.map(flag => flag.name)).not.toContain("--setup");
  expect(setup.flags.map(flag => flag.name)).toContain("--global");
  expect(open.flags.map(flag => flag.name)).not.toContain("--global");
  expect(command(result, "help")).toBeDefined();
  expect(result.commands.some(item => item.name === "completion bash")).toBe(true);
  expect(result.commands.some(item => item.name.includes("__query"))).toBe(false);

  const inspect = command(result, "inspect");
  expect(inspect.flags.find(flag => flag.name === "--extra-value")).toEqual({ name: "--extra-value", takesValue: true });
});

test("root completion includes visible commands and root flags without target lookup", async () => {
  const result = catalog();
  expect(await complete({ cwd: "/repo", words: [], current: "op" }, result, neverListTargets)).toEqual(["open"]);
  expect(await complete({ cwd: "/repo", words: [], current: "-V" }, result, neverListTargets)).toEqual(["-V"]);
  expect(await complete({ cwd: "/repo", words: [], current: "--" }, result, neverListTargets)).toEqual(["--help", "--version"]);
  const empty = await complete({ cwd: "/repo", words: [], current: "" }, result, neverListTargets);
  expect(empty).toContain("completion");
  expect(empty).toContain("--help");
  expect(empty).not.toContain("__query");
  expect(await complete({ cwd: "/repo", words: ["unknown"], current: "" }, result, neverListTargets)).toEqual([]);
});

test("completion subcommands derive visible shell values and omit the private query route", async () => {
  const result = catalog();
  expect(await complete({ cwd: "/repo", words: ["completion"], current: "ba" }, result, neverListTargets)).toEqual(["bash"]);
  const empty = await complete({ cwd: "/repo", words: ["completion"], current: "" }, result, neverListTargets);
  expect(empty).toContain("bash");
  expect(empty).toContain("--help");
  expect(empty).not.toContain("__query");
});

test("open and done targets are prefix filtered, sorted, deduplicated, and offered once", async () => {
  const calls: string[] = [];
  const services: CompletionServices = {
    listTargets: async (kind, cwd) => {
      calls.push(`${kind}:${cwd}`);
      return ["topic-z", "topic-a", "topic-a", "other"];
    },
  };
  const result = catalog();
  expect(await complete({ cwd: "/repo", words: ["open"], current: "topic" }, result, services)).toEqual(["topic-a", "topic-z"]);
  expect(await complete({ cwd: "/repo", words: ["done"], current: "topic-z" }, result, services)).toEqual(["topic-z"]);
  expect(calls).toEqual(["open:/repo", "done:/repo"]);
});

test("candidate order compares Unicode code points", async () => {
  const services: CompletionServices = {
    listTargets: async () => ["\u{10000}", "\ue000"],
  };
  expect(await complete({ cwd: "/repo", words: ["open"], current: "" }, catalog(), services))
    .toEqual(["\ue000", "\u{10000}"]);
});

test("flags work before and after a target, and a completed target is not offered again", async () => {
  const calls: string[] = [];
  const services: CompletionServices = {
    listTargets: async kind => { calls.push(kind); return ["topic-one", "topic-two"]; },
  };
  const result = catalog();
  const beforeTarget = await complete({ cwd: "/repo", words: ["open", "--no-editor"], current: "topic" }, result, services);
  expect(beforeTarget).toEqual(["topic-one", "topic-two"]);
  const afterTarget = await complete({ cwd: "/repo", words: ["open", "topic-one"], current: "--no" }, result, neverListTargets);
  expect(afterTarget).toEqual(["--no-agent", "--no-editor"]);
  expect(await complete({ cwd: "/repo", words: ["open", "topic-one"], current: "" }, result, neverListTargets))
    .toContain("--help");
  expect(await complete({ cwd: "/repo", words: ["done", "topic-one"], current: "another" }, result, neverListTargets)).toEqual([]);
  expect(calls).toEqual(["open"]);
});

test("required option values, free-form new names, and text after -- get no flag or branch guessing", async () => {
  const result = catalog();
  expect(await complete({ cwd: "/repo", words: ["new", "--base"], current: "" }, result, neverListTargets)).toEqual([]);
  expect(await complete({ cwd: "/repo", words: ["new", "--base"], current: "main" }, result, neverListTargets)).toEqual([]);
  expect(await complete({ cwd: "/repo", words: ["new"], current: "--base=" }, result, neverListTargets)).toEqual([]);
  expect(await complete({ cwd: "/repo", words: ["new"], current: "" }, result, neverListTargets)).toContain("--base");
  expect(await complete({ cwd: "/repo", words: ["new"], current: "feature-name" }, result, neverListTargets)).toEqual([]);
  expect(await complete({ cwd: "/repo", words: ["setup"], current: "" }, result, neverListTargets)).toContain("--global");
  expect(await complete({ cwd: "/repo", words: ["ls"], current: "" }, result, neverListTargets)).toContain("--help");
  expect(await complete({ cwd: "/repo", words: ["open", "--", "--keep"], current: "" }, result, neverListTargets)).toEqual([]);
});

test("an explicit -- terminator permits only the one remaining target, never flags", async () => {
  const calls: string[] = [];
  const services: CompletionServices = {
    listTargets: async kind => { calls.push(kind); return ["topic-one", "topic-two"]; },
  };
  const result = catalog();
  expect(await complete({ cwd: "/repo", words: ["open", "--"], current: "topic" }, result, services)).toEqual(["topic-one", "topic-two"]);
  expect(await complete({ cwd: "/repo", words: ["open", "topic-one", "--"], current: "" }, result, services)).toEqual([]);
  expect(calls).toEqual(["open"]);
});

test("implicit help completes command names and does not request repository targets", async () => {
  const result = catalog();
  expect(await complete({ cwd: "/repo", words: ["help"], current: "op" }, result, neverListTargets)).toEqual(["open"]);
  expect(await complete({ cwd: "/repo", words: ["help", "completion"], current: "ba" }, result, neverListTargets)).toEqual(["bash"]);
  expect(await complete({ cwd: "/repo", words: ["help", "open"], current: "" }, result, neverListTargets)).toEqual([]);
});

test("hidden query parse is quiet and keeps human handlers and chooser out of the route", async () => {
  const output = { stdout: "", stderr: "" };
  const cliContext = context(output);
  cliContext.choose = async () => { throw new Error("chooser must not run"); };
  const unexpectedHandler = async (): Promise<void> => { throw new Error("ordinary handler must not run"); };
  const code = await runCli(["completion", "__query", "--", "1", "9", "timber op", " \t\n'\"@><=;|&(:", "timber", "op"], {
    context: cliContext,
    handlers: {
      setup: unexpectedHandler,
      new: unexpectedHandler,
      open: unexpectedHandler,
      list: unexpectedHandler,
      done: unexpectedHandler,
    },
    completion: neverListTargets,
  });
  expect(code).toBe(0);
  expect(output.stdout).toBe("open\0");
  expect(output.stderr).toBe("");
});

test("hidden query accepts Bash word breaks inside a completed selector", async () => {
  const line = "timber open feature=value --no-editor";
  const output = { stdout: "", stderr: "" };
  const code = await runCli([
    "completion", "__query", "--", "5", String(Array.from(line).length), line,
    " \t\n'\"@><=;|&(:", "timber", "open", "feature", "=", "value", "--no-editor",
  ], {
    context: context(output),
    completion: neverListTargets,
  });

  expect(code).toBe(0);
  expect(output.stdout).toBe("--no-editor\0");
  expect(output.stderr).toBe("");
});

test("malformed query inputs and lookup failures return an empty quiet response", async () => {
  for (const args of [
    ["completion", "__query"],
    ["completion", "__query", "--", "not-a-number", "0", "", "", "timber"],
    ["completion", "__query", "--", "2", "999", "timber open", " ", "timber", "open"],
    ["completion", "__query", "--", "2", "12", "timber open ", " ", "timber", "open", ""],
    ["completion", "__query", "--", "1", "12", "timber open ", " ", "timber", "open", ""],
  ]) {
    const output = { stdout: "", stderr: "" };
    const code = await runCli(args, {
      context: context(output),
      completion: { listTargets: async () => { throw new Error("read failed"); } },
    });
    expect(code).toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).toBe("");
  }
});

test("query output preserves literal values and filters terminal controls", async () => {
  const output = { stdout: "", stderr: "" };
  const code = await runCli(["completion", "__query", "--", "2", "12", "timber open ", " ", "timber", "open", ""], {
    context: context(output),
    completion: { listTargets: async () => ["/tmp/tree with spaces", "/tmp/tree\u001b[2J", "/tmp/tree with spaces"] },
  });
  expect(code).toBe(0);
  expect(output.stdout).toBe("/tmp/tree with spaces\0");
  expect(output.stderr).toBe("");
});
