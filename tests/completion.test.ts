import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createCli, runCli } from "../src/cli";
import { parseBashCompletion } from "../src/completion/bash";
import { completionCandidates } from "../src/completion/candidates";
import { candidates } from "./helpers/completion";

test("completion discovers commands and filters their prefix outside Git", async () => {
  expect(await candidates("timber ")).toEqual(["arena", "backup", "completion", "done", "help", "ls", "new", "open", "rebase", "setup"]);
  expect(await candidates("timber o")).toEqual(["open"]);
  expect(await candidates("timber completion ")).toEqual(["bash", "fish", "zsh"]);
  expect(await candidates("timber help o")).toEqual(["open"]);
});

test("completion flags are specific to the actual command", async () => {
  expect(await candidates("timber done --")).toEqual(["--base", "--discard-ignored", "--help", "--keep-branch", "--keep-ignored"]);
  expect(await candidates("timber open --")).toEqual([
    "--agent", "--editor", "--help", "--no-agent", "--no-editor", "--result-file", "--setup", "--w", "--workflow",
  ]);
  expect(await candidates("timber open --w")).toEqual(["--w", "--workflow"]);
  expect(await candidates("timber new --w")).toEqual(["--w", "--workflow"]);
  expect(await candidates("timber new --ba")).toEqual(["--base"]);
  expect(await candidates("timber new --re")).toEqual(["--remote", "--result-file"]);
  expect(await candidates("timber new -c")).toEqual(["-c"]);
  expect(await candidates("timber setup --")).toEqual(["--global", "--help"]);
  expect(await candidates("timber ls -")).toEqual(["--help", "--json", "-h"]);
  expect(await candidates("timber --")).toEqual(["--help", "--version"]);
});

test("unknown commands, extra operands and nonrepository target requests are quiet", async () => {
  for (const line of ["timber wat --", "timber open ", "timber done ", "timber open first second", "timber ls ", "timber new feature "]) {
    expect(await candidates(line)).toEqual([]);
  }
  expect(await candidates("timber open first --no-")).toEqual(["--no-agent", "--no-editor"]);
  expect(await candidates("timber open --typo --no-")).toEqual(["--no-agent", "--no-editor"]);
  expect(await candidates("timber open -- --")).toEqual([]);
});

test("hidden transport is absent from public help and unsupported shells fail clearly", async () => {
  let stdout = "";
  let stderr = "";
  const dependencies = { context: { cwd: tmpdir(), io: {
    stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; },
  } } };
  expect(await runCli(["--help"], dependencies)).toBe(0);
  expect(stdout).toContain("completion");
  expect(stdout).not.toContain("__complete");
  stdout = "";
  stderr = "";
  expect(await runCli(["completion", "fish"], dependencies)).toBe(0);
  expect(stdout).toContain("complete -c timber");
  expect(stderr).toBe("");
  stdout = "";
  expect(await runCli(["completion", "powershell"], dependencies)).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("timber completion bash");
  expect(stderr).toContain("timber completion zsh");
  expect(stderr).toContain("timber completion fish");
});

test("Fish argv transport matches shared candidate requests", async () => {
  async function transport(argv: string[]): Promise<{ code: number; candidates: string[]; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, { context: { cwd: tmpdir(), io: {
      stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
    } } });
    return { code, candidates: stdout.split("\0").filter(Boolean), stderr };
  }

  expect(await transport(["__complete", "--fish", "--", "--no-", "open"])).toEqual({
    code: 0, candidates: ["--no-agent", "--no-editor"], stderr: "",
  });
  expect(await transport(["__complete", "--fish", "--", "--tool=cu", "arena", "new"])).toEqual({
    code: 0, candidates: ["--tool=cursor"], stderr: "",
  });
  expect(await transport(["__complete", "--fish", "--", "", "arena"])).toEqual({
    code: 0, candidates: ["help", "new", "resume"], stderr: "",
  });
  expect(await transport(["__complete", "--fish", "--", "--", "open", "--"])).toEqual({
    code: 0, candidates: [], stderr: "",
  });
  const conflict = await transport(["__complete", "--bash", "--fish", "--", "timber open "]);
  expect(conflict.code).toBe(1);
  expect(conflict.stderr).toContain("Cannot combine --bash and --fish");
});

test("Fish transport omits tab paths instead of suggesting a truncated selector", async () => {
  const { withRepository, git } = await import("./helpers/git");
  const { join } = await import("node:path");
  await withRepository(async (primary, directory) => {
    const tree = join(directory, "odd\ttree");
    await git(primary, "worktree", "add", "--detach", tree);
    let stdout = "";
    let stderr = "";
    expect(await runCli(["__complete", "--fish", "--", "", "done"], { context: { cwd: primary, io: {
      stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
    } } })).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(await candidates("timber done ", primary)).toEqual([tree]);
  });
});

test("structured completion transport accepts native shell words", async () => {
  let stdout = "";
  let stderr = "";
  const dependencies = { context: { cwd: tmpdir(), io: {
    stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; },
  } } };
  expect(await runCli(["__complete-words", "--", "--no-", "open"], dependencies)).toBe(0);
  expect(stdout.split("\0").filter(Boolean)).toEqual(["--no-agent", "--no-editor"]);
  expect(stderr).toBe("");
});

test("Unicode operands before a flag prefix do not affect candidate lookup", async () => {
  const prefix = "timber open --no-editor ü --no-";
  expect(await candidates(prefix)).toEqual(["--no-agent", "--no-editor"]);
});

test("candidate discovery follows additions to Commander definitions", async () => {
  const program = createCli({ context: { cwd: tmpdir(), io: { stdout() {}, stderr() {} } } });
  program.command("inspect").option("--details", "Test metadata discovery");
  expect(await completionCandidates(program, { cwd: tmpdir(), words: [], prefix: "in" })).toEqual(["inspect"]);
  expect(await completionCandidates(program, { cwd: tmpdir(), words: ["inspect"], prefix: "--" })).toEqual(["--details", "--help"]);
});

test("Bash parser keeps mid-word literals and declines only expanding positions", () => {
  for (const line of ["timber open issue#12", "timber open a~b", "timber open 'x'~", "timber open a}b"]) {
    const parsed = parseBashCompletion(line);
    expect(parsed.hasExpansion, line).toBe(false);
    expect(parsed.prefix, line).toBe(line.replace("timber open ", "").replaceAll("'", ""));
  }
  for (const line of ["timber open ~", "timber open ~user/x", "timber open x=~", "timber open x:~", "timber open a{b"]) {
    expect(parseBashCompletion(line).hasExpansion, line).toBe(true);
  }
});

test("shell line continuations do not introduce empty arguments", async () => {
  expect(await candidates("timber \\\n open --no-")).toEqual(["--no-agent", "--no-editor"]);
});

test("Bash transport declines retained prefixes with active shell expansion", async () => {
  const { withRepository, git } = await import("./helpers/git");
  const { join } = await import("node:path");
  await withRepository(async (primary, directory) => {
    const names = ["dollar$VAR=name", "glob*=name", "history!=name",
      "backtick" + String.fromCharCode(96) + "touch$" + "{IFS}SHOULD_NOT_EXIST" + String.fromCharCode(96) + "=name"];
    for (const name of names) await git(primary, "worktree", "add", "--detach", join(directory, name));
    for (const name of names) {
      const line = "timber done " + join(directory, name).replace(/ /gu, "\\ ").slice(0, -2);
      let stdout = "";
      let stderr = "";
      const code = await runCli(["__complete", "--bash", "--word-breaks", "=:",
        "--", line], { context: { cwd: primary, io: {
          stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
        } } });
      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
    }
  });
});
