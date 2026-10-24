import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { execa } from "execa";
import { fileURLToPath } from "node:url";
import { git, withRepository } from "./helpers/git";

const fish = Bun.which("fish");
if (fish === null && process.env.CI) throw new Error("Fish is required for completion tests in CI. Install fish before running tests.");
if (fish === null) console.warn("Skipping Fish completion tests: fish executable is not installed.");
const fishTest = fish === null ? test.skip : test;
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
/** TIMBER_COMPLETION_EXECUTABLE selects a built artifact instead of the source entry. */
const executable = process.env.TIMBER_COMPLETION_EXECUTABLE ? resolve(process.env.TIMBER_COMPLETION_EXECUTABLE) : undefined;
const timber = executable ? [executable] : [process.execPath, "--no-env-file", entry];
const ptyRunner = fileURLToPath(new URL("./helpers/pty-runner.py", import.meta.url));

async function withScript(cwd: string, run: (script: string, directory: string, bin: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "timber fish completion "));
  try {
    const result = await execa(timber[0]!, [...timber.slice(1), "completion", "fish"], {
      cwd, reject: false, env: { XDG_STATE_HOME: join(directory, "state") },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const script = join(directory, "timber.fish");
    await writeFile(script, result.stdout);
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "timber"), [
      "#!/bin/sh",
      'if [ "$1" = __complete ] || [ "$1" = completion ]; then',
      '  if [ -n "$TIMBER_EXECUTABLE" ]; then exec "$TIMBER_EXECUTABLE" "$@"; fi',
      '  exec "$TIMBER_BUN" --no-env-file "$TIMBER_ENTRY" "$@"',
      "fi",
      'exec python3 -c \'import json,os,sys; open(os.environ["TIMBER_CAPTURE"],"w").write(json.dumps(sys.argv[1:]))\' "$@"',
    ].join("\n"), { mode: 0o755 });
    await run(script, directory, bin);
    expect(await Bun.file(join(directory, "state/timber/setup-hint-shown")).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runFishTab(
  cwd: string, script: string, bin: string, directory: string, line: string,
): Promise<{ args: string[]; output: string }> {
  const capture = join(directory, "capture.json");
  await rm(capture, { force: true });
  const payload = join(directory, "pty.json");
  await writeFile(payload, JSON.stringify({
    command: [fish!, "--no-config", "--private", "--interactive", "-C", 'source "$TIMBER_SCRIPT"; echo AGENT_READY'],
    cwd,
    env: {
      PATH: bin + delimiter + process.env.PATH,
      TIMBER_SCRIPT: script,
      TIMBER_CAPTURE: capture,
      TIMBER_BUN: process.execPath,
      TIMBER_ENTRY: entry,
      TIMBER_EXECUTABLE: executable ?? "",
      XDG_STATE_HOME: join(directory, "state"),
      TERM: "xterm-256color",
    },
    input: line + "\t\nexit\n",
  }));
  const result = await execa("python3", [ptyRunner, payload], { timeout: 10_000 });
  const parsed: { exitCode: number; output: string } = JSON.parse(result.stdout);
  expect(parsed.exitCode, parsed.output).toBe(0);
  return { args: JSON.parse(await readFile(capture, "utf8")) as string[], output: parsed.output };
}

async function fishCandidates(cwd: string, script: string, bin: string, line: string): Promise<string[]> {
  const source = [
    'source "$TIMBER_SCRIPT"',
    'for candidate in (complete -C "$TIMBER_LINE" --escape)',
    '    printf %s "$candidate" | read --tokenize --list value',
    "    printf '%s\\0' $value",
    'end',
  ].join("\n");
  const result = await execa(fish!, ["--no-config", "-c", source], {
    cwd,
    env: {
      PATH: bin + delimiter + process.env.PATH,
      TIMBER_SCRIPT: script,
      TIMBER_LINE: line,
      TIMBER_BUN: process.execPath,
      TIMBER_ENTRY: entry,
      TIMBER_EXECUTABLE: executable ?? "",
    },
  });
  expect(result.stderr).toBe("");
  return result.stdout.split("\0").filter(Boolean);
}

fishTest("generated Fish script loads outside Git and completes commands and command flags", async () => {
  await withScript(tmpdir(), async (script, _directory, bin) => {
    expect(await fishCandidates(tmpdir(), script, bin, "timber o")).toEqual(["open"]);
    expect(await fishCandidates(tmpdir(), script, bin, "timber done --keep-")).toEqual(["--keep-branch", "--keep-ignored"]);
    expect(await fishCandidates(tmpdir(), script, bin, "timber open ")).toEqual([]);
  });
});

fishTest("Fish adapter uses current process and current token", async () => {
  await withScript(tmpdir(), async (script, _directory, bin) => {
    expect(await fishCandidates(tmpdir(), script, bin, "echo ignored; timber o")).toEqual(["open"]);
    expect(await fishCandidates(tmpdir(), script, bin, "printf x | timber done --keep-")).toEqual([
      "--keep-branch", "--keep-ignored",
    ]);
  });
});

fishTest("Fish adapter preserves completed multiline option values", async () => {
  await withScript(tmpdir(), async (script, _directory, bin) => {
    for (const prompt of ['""', '"hello\n--"', "'hello\n--'"]) {
      expect(await fishCandidates(tmpdir(), script, bin, "timber arena new --prompt " + prompt + " --tool c")).toEqual([
        "claude", "codex", "cursor",
      ]);
    }
  });
});

fishTest("Fish adapter preserves newlines already typed in a quoted prefix", async () => {
  await withRepository(async (primary, directory) => {
    const tree = join(directory, "odd\nright tree");
    const other = join(directory, "odd\nwrong tree");
    await git(primary, "worktree", "add", "--detach", tree);
    await git(primary, "worktree", "add", "--detach", other);
    await withScript(primary, async (script, scratch, bin) => {
      const result = await runFishTab(primary, script, bin, scratch, "timber done '" + directory + "/odd\nri");
      expect(result.args, result.output).toEqual(["done", tree]);
    });
  });
});

fishTest("Fish adapter handles quoted paths and preserves candidate boundaries", async () => {
  await withRepository(async (primary, directory) => {
    const space = join(directory, "odd space tree");
    const newline = join(directory, "odd\nnewline tree");
    await git(primary, "worktree", "add", "--detach", space);
    await git(primary, "worktree", "add", "--detach", newline);
    await withScript(primary, async (script, _scratch, bin) => {
      const values = await fishCandidates(primary, script, bin, "timber done '" + directory + "/odd");
      expect(values).toContain(space);
      expect(values).toContain(newline);
    });
  });
});

fishTest("Fish adapter reads fresh selectors from nested and linked worktrees", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "linked tree");
    const nested = join(primary, "nested");
    await mkdir(nested);
    await git(primary, "worktree", "add", "-b", "feature", linked);
    await git(primary, "branch", "unchecked");
    await git(primary, "remote", "add", "origin", "https://example.invalid/never-contact");
    await git(primary, "update-ref", "refs/remotes/origin/cached", "HEAD");
    await writeFile(join(primary, ".timber.toml"), "invalid TOML [[[\n");
    await writeFile(join(linked, "tracked.txt"), "local work\n");
    const refs = await git(primary, "show-ref");
    const inventory = await git(primary, "worktree", "list", "--porcelain", "-z");
    await withScript(primary, async (script, _scratch, bin) => {
      for (const cwd of [primary, nested, linked]) {
        expect((await fishCandidates(cwd, script, bin, "timber done ")).sort()).toEqual([linked, "feature"].sort());
        expect(await fishCandidates(cwd, script, bin, "timber open unch")).toEqual(["unchecked"]);
        expect(await fishCandidates(cwd, script, bin, "timber open origin/")).toEqual(["origin/cached"]);
        expect(await fishCandidates(cwd, script, bin, "timber new --base tru")).toEqual(["trunk"]);
      }
      const fresh = join(directory, "fresh tree");
      await git(primary, "worktree", "add", "-b", "fresh", fresh);
      expect(await fishCandidates(nested, script, bin, "timber done fresh")).toEqual(["fresh"]);
      await git(primary, "worktree", "remove", fresh);
      expect(await fishCandidates(linked, script, bin, "timber done fresh")).toEqual([]);
      await git(primary, "branch", "-d", "fresh");
    });
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(inventory);
    expect(await readFile(join(linked, "tracked.txt"), "utf8")).toBe("local work\n");
  });
});

fishTest("Fish Tab inserts metacharacter paths as one literal argument", async () => {
  await withRepository(async (primary, directory) => {
    const tree = join(directory, "odd ' \" $(touch SHOULD_NOT_EXIST) ; & ! = : é \\ *?[] \n name");
    await git(primary, "worktree", "add", "--detach", tree);
    await withScript(primary, async (script, scratch, bin) => {
      const prefixes = ["'" + directory + "/odd", '"' + directory + "/odd", directory.replace(/ /gu, "\\ ") + "/odd"];
      for (const prefix of prefixes) {
        const result = await runFishTab(primary, script, bin, scratch, "timber done " + prefix);
        expect(result.args, result.output).toEqual(["done", tree]);
        expect(await Bun.file(join(primary, "SHOULD_NOT_EXIST")).exists()).toBe(false);
      }
    });
  });
}, 30_000);

fishTest("Fish insertion handles equals, colon paths, closed quotes, and Unicode", async () => {
  await withRepository(async (primary, directory) => {
    const tree = join(directory, "colon:equal=tree");
    const literalBranch = "literal;touch$" + "{IFS}SHOULD_NOT_EXIST";
    await git(primary, "branch", literalBranch);
    await git(primary, "branch", "éclair");
    await git(primary, "worktree", "add", "--detach", tree);
    await withScript(primary, async (script, scratch, bin) => {
      const cases = [
        { input: "timber new --base=tru", expected: ["new", "--base=trunk"] },
        { input: "timber done '" + directory + "/colon:'", expected: ["done", tree] },
        { input: "timber open literal", expected: ["open", literalBranch] },
        { input: "timber open é", expected: ["open", "éclair"] },
      ];
      for (const item of cases) {
        const result = await runFishTab(primary, script, bin, scratch, item.input);
        expect(result.args, result.output).toEqual(item.expected);
        expect(await Bun.file(join(primary, "SHOULD_NOT_EXIST")).exists()).toBe(false);
      }
    });
  });
}, 30_000);
