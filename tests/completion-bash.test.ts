import { expect, test } from "bun:test";
import { execa } from "execa";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, withRepository } from "./helpers/git";
import { candidates } from "./helpers/completion";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const ptyRunner = fileURLToPath(new URL("./helpers/pty-runner.py", import.meta.url));

async function withScript(cwd: string, run: (script: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "timber completion "));
  try {
    const result = await execa(process.execPath, ["--no-env-file", entry, "completion", "bash"], {
      cwd, reject: false, env: { XDG_STATE_HOME: join(directory, "state") },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const script = join(directory, "timber.bash");
    await writeFile(script, result.stdout);
    await run(script, directory);
    expect(await Bun.file(join(directory, "state/timber/setup-hint-shown")).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function bashCandidates(cwd: string, script: string, line: string) {
  const source = [
    'timber() { "$TIMBER_BUN" --no-env-file "$TIMBER_ENTRY" "$@"; }',
    'source "$TIMBER_SCRIPT"',
    'COMP_LINE=$TIMBER_LINE',
    'COMP_POINT=${#COMP_LINE}',
    'COMP_WORDS=(timber)',
    'COMP_CWORD=1',
    '_timber_complete timber',
    'if (("${#COMPREPLY[@]}")); then printf \'%s\\0\' "${COMPREPLY[@]}"; fi',
  ].join("\n");
  const result = await execa("bash", ["--noprofile", "--norc", "-c", source], {
    cwd, env: { TIMBER_BUN: process.execPath, TIMBER_ENTRY: entry, TIMBER_SCRIPT: script, TIMBER_LINE: line },
  });
  expect(result.stderr).toBe("");
  return result.stdout.split("\0").filter(Boolean);
}

test("generated Bash script loads outside Git and completes commands and command flags", async () => {
  await withScript(tmpdir(), async script => {
    expect(await bashCandidates(tmpdir(), script, "timber o")).toEqual(["open"]);
    expect(await bashCandidates(tmpdir(), script, "timber done --keep-")).toEqual(["--keep-branch", "--keep-ignored"]);
    expect(await bashCandidates(tmpdir(), script, "timber open ")).toEqual([]);
  });
});

test("Bash adapter handles quoted and escaped paths and shell word breaks", async () => {
  await withRepository(async (primary, directory) => {
    const tree = join(directory, "odd ' \" $() ; & ! = : name");
    await git(primary, "worktree", "add", "--detach", tree);
    await git(primary, "branch", "literal;name");
    await withScript(primary, async script => {
      const escapedPrefix = tree.slice(0, -4).replace(/([^a-zA-Z0-9_/.-])/gu, "\\$1");
      expect(await candidates("timber done " + escapedPrefix, primary)).toEqual([tree]);
      expect(await candidates("timber done '" + directory + "/odd", primary)).toEqual([tree]);
      expect(await candidates('timber done "' + directory + "/odd", primary)).toEqual([tree]);
      expect(await candidates("timber open literal\\;", primary)).toEqual(["literal;name"]);
    });
  });
});

test("Readline Tab inserts metacharacter paths as one literal argument", async () => {
  await withRepository(async (primary, directory) => {
    const tree = join(directory, "odd ' \" $(touch SHOULD_NOT_EXIST) ; & ! = : é \\\\ *?[] " + String.fromCharCode(96) + "\n name");
    await git(primary, "worktree", "add", "--detach", tree);
    await withScript(primary, async (script, scratch) => {
      const capture = join(scratch, "capture.json");
      const rc = join(scratch, "bashrc");
      await writeFile(rc, [
        "PS1='PROMPT> '",
        "bind 'set enable-bracketed-paste off'",
        'timber() {',
        '  if [[ $1 == __complete ]]; then',
        '    "$TIMBER_BUN" --no-env-file "$TIMBER_ENTRY" "$@"',
        '  else',
        '    python3 -c \'import json,os,sys; open(os.environ["TIMBER_CAPTURE"],"w").write(json.dumps(sys.argv[1:]))\' "$@"',
        '  fi',
        '}',
        'source "$TIMBER_SCRIPT"',
        "printf 'AGENT_READY\\n'",
      ].join("\n"));
      for (const prefix of ["'" + directory + "/odd", '"' + directory + "/odd", directory.replace(/ /gu, "\\ ") + "/odd"]) {
        const payload = join(scratch, "pty.json");
        await writeFile(payload, JSON.stringify({
          command: ["bash", "--noprofile", "--rcfile", rc, "-i"], cwd: primary,
          env: { TIMBER_BUN: process.execPath, TIMBER_ENTRY: entry, TIMBER_SCRIPT: script, TIMBER_CAPTURE: capture },
          input: "timber done " + prefix + "\t\nexit\n",
        }));
        const result = await execa("python3", [ptyRunner, payload], { timeout: 10_000 });
        const parsed: { exitCode: number; output: string } = JSON.parse(result.stdout);
        expect(parsed.exitCode, parsed.output).toBe(0);
        expect(JSON.parse(await readFile(capture, "utf8")) as string[], parsed.output).toEqual(["done", tree]);
        expect(await Bun.file(join(primary, "SHOULD_NOT_EXIST")).exists()).toBe(false);
      }
    });
  });
}, 30_000);

test("Readline insertion respects equal/colon word breaks and a closed quoted prefix", async () => {
  await withRepository(async (primary, directory) => {
    const tree = join(directory, "colon:equal=tree");
    const literalBranch = "literal;touch$" + "{IFS}SHOULD_NOT_EXIST";
    await git(primary, "branch", literalBranch);
    await git(primary, "branch", "éclair");
    await git(primary, "branch", "nbsp\u00a0branch");
    await git(primary, "worktree", "add", "--detach", tree);
    await withScript(primary, async (script, scratch) => {
      const capture = join(scratch, "capture.json");
      const rc = join(scratch, "bashrc");
      await writeFile(rc, [
        "PS1='PROMPT> '",
        "bind 'set enable-bracketed-paste off'",
        'timber() {',
        '  if [[ $1 == __complete ]]; then',
        '    "$TIMBER_BUN" --no-env-file "$TIMBER_ENTRY" "$@"',
        '  else',
        '    python3 -c \'import json,os,sys; open(os.environ["TIMBER_CAPTURE"],"w").write(json.dumps(sys.argv[1:]))\' "$@"',
        '  fi',
        '}',
        'source "$TIMBER_SCRIPT"',
        "printf 'AGENT_READY\\n'",
      ].join("\n"));
      const cases = [
        { input: "timber new --base=tru", expected: ["new", "--base=trunk"] },
        { input: "timber done " + directory.replace(/ /gu, "\\ ") + "/colon:equal=tr", expected: ["done", tree] },
        { input: "timber done '" + directory + "/colon:'", expected: ["done", tree] },
        { input: "timber open literal", expected: ["open", literalBranch] },
        { input: "timber open é", expected: ["open", "éclair"] },
        { input: "timber open nbsp\u00a0br", expected: ["open", "nbsp\u00a0branch"] },
      ];
      for (const item of cases) {
        await rm(capture, { force: true });
        const payload = join(scratch, "pty.json");
        await writeFile(payload, JSON.stringify({
          command: ["bash", "--noprofile", "--rcfile", rc, "-i"], cwd: primary,
          env: { TIMBER_BUN: process.execPath, TIMBER_ENTRY: entry, TIMBER_SCRIPT: script, TIMBER_CAPTURE: capture },
          input: item.input + "\t\nexit\n",
        }));
        const result = await execa("python3", [ptyRunner, payload], { timeout: 10_000 });
        const parsed: { exitCode: number; output: string } = JSON.parse(result.stdout);
        expect(parsed.exitCode, parsed.output).toBe(0);
        expect(JSON.parse(await readFile(capture, "utf8")) as string[], parsed.output).toEqual(item.expected);
        expect(await Bun.file(join(primary, "SHOULD_NOT_EXIST")).exists()).toBe(false);
      }
    });
  });
}, 30_000);
