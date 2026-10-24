import { expect, test } from "bun:test";
import { execa } from "execa";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const executable = process.env.TIMBER_COMPLETION_EXECUTABLE ? resolve(process.env.TIMBER_COMPLETION_EXECUTABLE) : undefined;
const timber = executable ? [executable] : [process.execPath, "--no-env-file", entry];
const timberEnv = { TIMBER_BUN: process.execPath, TIMBER_ENTRY: entry, TIMBER_EXECUTABLE: executable ?? "" };
const timberBackend = 'if [[ -n $TIMBER_EXECUTABLE ]]; then "$TIMBER_EXECUTABLE" "$@"; else "$TIMBER_BUN" --no-env-file "$TIMBER_ENTRY" "$@"; fi';
const ptyRunner = fileURLToPath(new URL("./helpers/pty-runner.py", import.meta.url));

async function withScript(cwd: string, run: (script: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "timber zsh completion "));
  try {
    const insecureFpath = join(directory, "insecure completion");
    await mkdir(insecureFpath);
    await chmod(insecureFpath, 0o777);
    const generated = await execa(timber[0]!, [...timber.slice(1), "completion", "zsh"], {
      cwd, reject: false, env: { XDG_STATE_HOME: join(directory, "state") },
    });
    expect(generated.exitCode).toBe(0);
    expect(generated.stderr).toBe("");
    const script = join(directory, "_timber");
    await writeFile(script, generated.stdout);
    await run(script, directory);
    expect(await Bun.file(join(directory, "state/timber/setup-hint-shown")).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function zshArgs(cwd: string, script: string, directory: string, input: string, setup: string[] = []) {
  const capture = join(directory, "capture.json");
  const rc = join(directory, ".zshrc");
  await rm(capture, { force: true });
  await writeFile(rc, [
    'fpath=("$TIMBER_INSECURE_FPATH" $fpath)',
    "autoload -Uz compinit",
    "compinit -i -D",
    ...setup,
    'timber() {',
    '  if [[ $1 == __complete-words ]]; then',
    "    " + timberBackend,
    '  else',
    '    python3 -c \'import json,os,sys; open(os.environ["TIMBER_CAPTURE"],"w").write(json.dumps(sys.argv[1:]))\' "$@"',
    '  fi',
    '}',
    'source "$TIMBER_SCRIPT"',
    "bindkey '^I' expand-or-complete",
    "print AGENT_READY",
  ].join("\n"));
  const payload = join(directory, "pty.json");
  await writeFile(payload, JSON.stringify({
    command: ["zsh", "-d", "-i"], cwd,
    env: {
      ...timberEnv,
      ZDOTDIR: directory,
      XDG_STATE_HOME: join(directory, "state"),
      TIMBER_SCRIPT: script,
      TIMBER_CAPTURE: capture,
      TIMBER_INSECURE_FPATH: join(directory, "insecure completion"),
    },
    input: input + "\t\nexit\n",
  }));
  const result = await execa("python3", [ptyRunner, payload], { timeout: 10_000 });
  const parsed: { exitCode: number; output: string } = JSON.parse(result.stdout);
  expect(parsed.exitCode, parsed.output).toBe(0);
  return { args: JSON.parse(await readFile(capture, "utf8")) as string[], output: parsed.output };
}

test("generated Zsh script loads when insecure completion paths are ignored", async () => {
  await withScript(tmpdir(), async (script, directory) => {
    const loaded = await execa("zsh", ["-f", "-c", [
      'fpath=("$TIMBER_INSECURE_FPATH" $fpath)',
      "autoload -Uz compinit",
      "compinit -i -D",
      'source "$TIMBER_SCRIPT"',
      '[[ ${_comps[timber]-} == _timber_complete ]]',
    ].join("\n")], { env: {
      TIMBER_SCRIPT: script,
      TIMBER_INSECURE_FPATH: join(directory, "insecure completion"),
    } });
    expect(loaded.stderr).toBe("");
  });
});

test("Zsh Tab completes a command through the generated script", async () => {
  await withScript(tmpdir(), async (script, directory) => {
    expect((await zshArgs(tmpdir(), script, directory, "timber o", ["setopt KSH_ARRAYS SH_WORD_SPLIT"])).args).toEqual(["open"]);
    expect((await zshArgs(tmpdir(), script, directory, "timber done --keep-b")).args).toEqual(["done", "--keep-branch"]);
    expect((await zshArgs(tmpdir(), script, directory, "timber 'open' --no-a")).args).toEqual(["open", "--no-agent"]);
    expect((await zshArgs(tmpdir(), script, directory, "timber arena new task '--tool' co")).args).toEqual([
      "arena", "new", "task", "--tool", "codex",
    ]);
    expect((await zshArgs(tmpdir(), script, directory, "timber open '--' --no-a")).args).toEqual([
      "open", "--", "--no-a",
    ]);
  });
});

test("Zsh inserts repository candidates as literal arguments", async () => {
  await withRepository(async (primary, directory) => {
    const tree = join(directory, "odd ' \" $(touch SHOULD_NOT_EXIST) ; & ! = : é \\ *?[] " + String.fromCharCode(96) + "\n name");
    const colonTree = join(directory, "colon:equal=tree");
    const slashTree = join(directory, "slash\\quote tail");
    const quoteTree = join(directory, "quote 'pair' tail");
    const literalBranch = "literal;touch$" + "{IFS}SHOULD_NOT_EXIST";
    await git(primary, "worktree", "add", "--detach", tree);
    await git(primary, "worktree", "add", "--detach", colonTree);
    await git(primary, "worktree", "add", "--detach", slashTree);
    await git(primary, "worktree", "add", "--detach", quoteTree);
    await git(primary, "branch", literalBranch);
    await git(primary, "branch", "éclair");
    await git(primary, "branch", "nbsp\u00a0branch");
    await withScript(primary, async (script, scratch) => {
      const cases = [
        { input: "timber done '" + directory + "/odd", expected: ["done", tree] },
        { input: 'timber done "' + directory + "/odd", expected: ["done", tree] },
        { input: "timber done " + directory.replace(/ /gu, "\\ ") + "/odd", expected: ["done", tree] },
        { input: "timber done " + directory.replace(/ /gu, "\\ ") + "/colon:equal=tr", expected: ["done", colonTree] },
        { input: "timber done '" + directory + "/slash\\q", expected: ["done", slashTree] },
        { input: 'timber done "' + directory + "/slash\\q", expected: ["done", slashTree] },
        { input: 'timber done "' + directory + "/quote 'pair'", expected: ["done", quoteTree] },
        { input: "timber new --base=tru", expected: ["new", "--base=trunk"] },
        { input: "timber open literal", expected: ["open", literalBranch] },
        { input: "timber open é", expected: ["open", "éclair"] },
        { input: "timber open nbsp\u00a0br", expected: ["open", "nbsp\u00a0branch"] },
      ];
      for (const item of cases) {
        let result;
        try {
          result = await zshArgs(primary, script, scratch, item.input);
        } catch (error) {
          throw new Error(`Zsh completion failed for ${JSON.stringify(item.input)}`, { cause: error });
        }
        expect(result.args, result.output).toEqual(item.expected);
        expect(await Bun.file(join(primary, "SHOULD_NOT_EXIST")).exists()).toBe(false);
      }
    });
  });
}, 30_000);
