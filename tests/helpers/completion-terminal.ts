import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const prompt = "__TIMBER_COMPLETION_PROMPT__ ";
const argvFixture = fileURLToPath(new URL("../fixtures/completion-argv.ts", import.meta.url));

export type CompletionTerminalBackend = { entry: string } | { executable: string };

export interface CompletionTerminalOptions {
  script?: string;
  candidates?: readonly string[] | ((directory: string) => readonly string[]);
  directories?: readonly string[] | ((directory: string) => readonly string[]);
  input?: string;
  inputs?: readonly string[];
  sourceTwice?: boolean;
  sourceCommand?: string;
  installScript?: boolean;
  backend?: CompletionTerminalBackend;
  cwd?: string;
  env?: Record<string, string>;
  betweenInputs?: readonly (() => Promise<void>)[];
  queryStderr?: string;
}

export interface CompletionTerminalResult {
  code: number;
  timedOut: boolean;
  sentinelCreated: boolean;
  output: string;
  argv: readonly string[] | null;
  argvCalls: readonly (readonly string[])[];
  queryArgs: readonly string[] | null;
  queryCalls: readonly (readonly string[])[];
  homeEntries: readonly string[];
  directory: string;
}

const stub = `#!/bin/bash
if [[ \${1-} == completion && \${2-} == __query ]]; then
  printf '%s\\0' "$@" >> "$TIMBER_QUERY_LOG"
  printf '\\001' >> "$TIMBER_QUERY_LOG"
  if [[ -n \${TIMBER_QUERY_STDERR-} ]]; then printf '%s\\n' "$TIMBER_QUERY_STDERR" >&2; fi
  while IFS= read -r candidate; do printf '%s\\0' "$candidate"; done < "$TIMBER_CANDIDATE_FILE"
  exit 0
fi
if [[ \${1-} == completion ]]; then exit 0; fi
exec "$TIMBER_BUN_BIN" "$TIMBER_ARGV_FIXTURE" "$@"
`;

const shippedShim = `#!/bin/bash
if [[ \${1-} == completion && \${2-} == __query ]]; then
  printf '%s\\0' "$@" >> "$TIMBER_QUERY_LOG"
  printf '\\001' >> "$TIMBER_QUERY_LOG"
  if [[ -n \${TIMBER_EXECUTABLE-} ]]; then exec "$TIMBER_EXECUTABLE" "$@"; fi
  exec "$TIMBER_BUN_BIN" --no-env-file "$TIMBER_ENTRY" "$@"
fi
if [[ \${1-} == completion && \${2-} == bash ]]; then
  if [[ -n \${TIMBER_EXECUTABLE-} ]]; then exec "$TIMBER_EXECUTABLE" "$@"; fi
  exec "$TIMBER_BUN_BIN" --no-env-file "$TIMBER_ENTRY" "$@"
fi
if [[ \${1-} == completion ]]; then exit 0; fi
exec "$TIMBER_BUN_BIN" "$TIMBER_ARGV_FIXTURE" "$@"
`;

function framedRecords(bytes: Uint8Array): string[][] {
  if (bytes.length === 0) return [];
  return Buffer.from(bytes).toString("utf8").split("\u0001").filter(Boolean).map(record => {
    const values = record.split("\0");
    if (values.at(-1) === "") values.pop();
    return values;
  });
}

function argvRecords(bytes: Uint8Array): string[][] {
  return Buffer.from(bytes).toString("utf8").split("\n").filter(Boolean).map(value => JSON.parse(value) as string[]);
}

async function treeEntries(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    result.push(path);
    if (entry.isDirectory()) result.push(...await treeEntries(root, path));
  }
  return result.sort();
}

export async function runCompletionTerminal(options: CompletionTerminalOptions): Promise<CompletionTerminalResult> {
  const directory = await mkdtemp(join(tmpdir(), "timber completion PTY "));
  const home = join(directory, "home");
  const binDirectory = join(directory, "bin");
  const temporaryScriptPath = join(directory, "completion.bash");
  const installDirectory = join(home, ".local", "share", "bash-completion", "completions");
  const scriptPath = options.installScript ? join(installDirectory, "timber") : temporaryScriptPath;
  const shimPath = join(binDirectory, "timber");
  const candidatePath = join(directory, "candidates.txt");
  const argvPath = join(directory, "argv.jsonl");
  const queryPath = join(directory, "query.bin");
  await mkdir(binDirectory);
  await mkdir(home);
  if (options.installScript) await mkdir(installDirectory, { recursive: true });
  const candidates = typeof options.candidates === "function"
    ? options.candidates(directory)
    : options.candidates ?? [];
  const directories = typeof options.directories === "function"
    ? options.directories(directory)
    : options.directories ?? [];
  for (const path of directories) await mkdir(path, { recursive: true });
  if (options.script !== undefined) await writeFile(scriptPath, options.script);
  await writeFile(candidatePath, candidates.map(candidate => `${candidate}\n`).join(""));
  await writeFile(shimPath, options.backend ? shippedShim : stub, { mode: 0o755 });
  await chmod(shimPath, 0o755);

  const source = options.sourceCommand
    ?? (options.installScript ? 'source "$TIMBER_COMPLETION_SCRIPT"' : 'source "$TIMBER_COMPLETION_SCRIPT"');
  const sourceCommand = options.sourceTwice
    ? `${source}; ${source}; set +H; complete -p timber\r`
    : `${source}; set +H; complete -p timber\r`;
  const inputs = options.inputs ?? (options.input === undefined ? [] : [options.input]);
  let output = "";
  let promptCount = 0;
  let searchedThrough = 0;
  let timedOut = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let overallTimeout: ReturnType<typeof setTimeout> | undefined;
  const promptWaiters: Array<{ count: number; resolve: () => void }> = [];

  const waitForPrompt = (count: number): Promise<void> => {
    if (promptCount >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        child?.kill("SIGKILL");
        reject(new Error(`Bash did not reach prompt ${count}`));
      }, 5000);
      const complete = () => {
        clearTimeout(timeout);
        resolve();
      };
      promptWaiters.push({ count, resolve: complete });
      child?.exited.then(() => {
        clearTimeout(timeout);
        reject(new Error(`Bash exited before prompt ${count}`));
      });
    });
  };

  try {
    child = Bun.spawn(["/bin/bash", "--noprofile", "--norc", "-i"], {
      cwd: options.cwd ?? directory,
      env: {
        ...process.env,
        ...options.env,
        CI: "true",
        PATH: `${binDirectory}${delimiter}${options.env?.PATH ?? process.env.PATH ?? ""}`,
        HOME: home,
        XDG_CONFIG_HOME: join(home, "xdg-config"),
        XDG_STATE_HOME: join(home, "xdg-state"),
        INPUTRC: "/dev/null",
        HISTFILE: "/dev/null",
        HISTCONTROL: "ignoreboth",
        LC_ALL: "C.UTF-8",
        LANG: "C.UTF-8",
        PS1: prompt,
        TIMBER_COMPLETION_SCRIPT: scriptPath,
        TIMBER_CANDIDATE_FILE: candidatePath,
        TIMBER_ARGV_FIXTURE: argvFixture,
        TIMBER_ARGV_OUT: argvPath,
        TIMBER_QUERY_LOG: queryPath,
        TIMBER_QUERY_STDERR: options.queryStderr ?? "",
        TIMBER_BUN_BIN: process.execPath,
        TIMBER_ENTRY: options.backend && "entry" in options.backend ? options.backend.entry : "",
        TIMBER_EXECUTABLE: options.backend && "executable" in options.backend ? options.backend.executable : "",
        BUN_INSTALL_CACHE_DIR: join(directory, "bun-install-cache"),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
      terminal: {
        data(_terminal, bytes) {
          output += Buffer.from(bytes).toString("utf8");
          let next = output.indexOf(prompt, searchedThrough);
          while (next >= 0) {
            searchedThrough = next + prompt.length;
            promptCount += 1;
            for (let index = promptWaiters.length - 1; index >= 0; index -= 1) {
              if (promptWaiters[index]!.count <= promptCount) promptWaiters.splice(index, 1)[0]!.resolve();
            }
            next = output.indexOf(prompt, searchedThrough);
          }
        },
      },
    });
    overallTimeout = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGKILL");
    }, 5000);

    const terminal = child.terminal!;
    await waitForPrompt(1);
    terminal.write(sourceCommand);
    await waitForPrompt(2);
    for (let index = 0; index < inputs.length; index += 1) {
      if (index > 0) await options.betweenInputs?.[index - 1]?.();
      terminal.write(inputs[index]!);
      await waitForPrompt(index + 3);
    }
    terminal.write("exit\r");
    let exitTimeout: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([
      child.exited,
      new Promise<number>(resolve => {
        exitTimeout = setTimeout(() => {
          timedOut = true;
          child?.kill("SIGKILL");
          resolve(-1);
        }, 5000);
      }),
    ]);
    if (exitTimeout !== undefined) clearTimeout(exitTimeout);
    const argvCalls = await readFile(argvPath).then(argvRecords).catch(() => []);
    const queryCalls = await readFile(queryPath).then(framedRecords).catch(() => []);
    const sentinelCreated = await access(join(directory, "SENTINEL")).then(() => true).catch(() => false);
    const homeEntries = await treeEntries(home);
    return {
      code,
      timedOut,
      sentinelCreated,
      output,
      argv: argvCalls.at(-1) ?? null,
      argvCalls,
      queryArgs: queryCalls[0] ?? null,
      queryCalls,
      homeEntries,
      directory,
    };
  } finally {
    if (overallTimeout !== undefined) clearTimeout(overallTimeout);
    child?.kill("SIGKILL");
    child?.terminal?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
