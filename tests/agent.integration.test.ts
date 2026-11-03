import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const stub = fileURLToPath(new URL("./fixtures/agent-stub.ts", import.meta.url));
const terminal = fileURLToPath(new URL("./helpers/pty-runner.py", import.meta.url));
let serial = 0;

async function pty(
  cwd: string, directory: string, args: string[],
  options: { env?: Record<string, string>; input?: string; interrupt?: boolean } = {},
): Promise<{ exitCode: number; output: string }> {
  const payload = join(directory, `pty-${serial++}.json`);
  await writeFile(payload, JSON.stringify({ cwd, command: [process.execPath, entry, ...args],
    ...options }));
  const result = await execa("python3", ["-B", terminal, payload], { timeout: 8000 });
  return JSON.parse(result.stdout);
}

async function configure(
  primary: string, capture: string,
  { enabled = true, mode = "exit", args = ["0"], command = process.execPath, editor = "" } = {},
) {
  await writeFile(join(primary, ".timber.toml"), [
    'base_branch = "trunk"', editor, "[agent]",
    `enabled = ${enabled}`, `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify([stub, mode, capture, ...args])}`,
  ].join("\n"));
}

async function snapshot(primary: string) {
  return {
    refs: await git(primary, "show-ref"),
    inventory: await git(primary, "worktree", "list", "--porcelain"),
    status: await git(primary, "status", "--porcelain", "--untracked-files=all"),
  };
}

test("new uses primary config from linked/nested cwd and passes literal args through a real terminal", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "existing linked");
    const nested = join(linked, "nested");
    await git(primary, "worktree", "add", "-b", "context", linked);
    await mkdir(nested);
    await writeFile(join(linked, ".timber.toml"), "invalid [ toml");
    const capture = join(directory, "capture.json");
    const literal = ["", "space value", "$(touch SHELL_MARKER)", ";", "'quoted'", "$HOME"];
    await configure(primary, capture, { mode: "capture", args: literal });
    const result = await pty(nested, directory, ["new", "feature/agent", "--no-editor"]);
    expect(result.exitCode).toBe(0);
    const recorded = JSON.parse(await readFile(capture, "utf8"));
    const target = join(directory, "primary repo-worktrees", "feature-agent");
    expect(recorded.cwd).toBe(target);
    expect(recorded.args).toEqual(literal);
    expect(recorded.stdinTTY).toBe(true);
    expect(recorded.stdoutTTY).toBe(true);
    expect(await Bun.file(join(target, "SHELL_MARKER")).exists()).toBe(false);
    expect(await git(target, "rev-parse", "HEAD")).toBe(await git(primary, "rev-parse", "trunk"));
  });
});

test("open reuses dirty workspace and propagates nonzero agent exit without changing files or refs", async () => {
  await withRepository(async (primary, directory) => {
    const tree = join(directory, "linked agent tree");
    await git(primary, "worktree", "add", "-b", "feature/agent", tree);
    await writeFile(join(tree, "tracked.txt"), "modified\n");
    await writeFile(join(tree, "untracked.txt"), "untracked\n");
    await writeFile(join(tree, ".env"), "fixture-only\n");
    const capture = join(directory, "capture");
    await configure(primary, capture, { args: ["23"] });
    const before = await snapshot(primary);
    const result = await pty(primary, directory, ["open", tree, "--no-editor"]);
    expect(result.exitCode).toBe(23);
    expect(result.output).not.toContain("Choose a base");
    expect(result.output).toContain("Workspace retained");
    expect(await snapshot(primary)).toEqual(before);
    expect(await readFile(join(tree, "tracked.txt"), "utf8")).toBe("modified\n");
    expect(await readFile(join(tree, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(await readFile(join(tree, ".env"), "utf8")).toBe("fixture-only\n");
    expect(JSON.parse(await readFile(capture, "utf8")).cwd).toBe(tree);
  });
});

test("new startup failure retains created branch and retry reuses the quoted absolute path", async () => {
  await withRepository(async (primary, directory) => {
    const capture = join(directory, "capture");
    await configure(primary, capture, { command: join(directory, "missing agent") });
    const failed = await pty(primary, directory, ["new", "feature/failed", "--no-editor"]);
    const tree = join(directory, "primary repo-worktrees", "feature-failed");
    expect(failed.exitCode).toBe(1);
    expect(failed.output).toContain("Could not start the configured agent");
    expect(failed.output).toContain(`timber open --agent --no-editor -- '${tree}'`);
    expect(await git(tree, "rev-parse", "HEAD")).toBe(await git(primary, "rev-parse", "trunk"));
    await writeFile(join(tree, ".env"), "retained fixture\n");
    await configure(primary, capture);
    const before = await snapshot(primary);
    const retried = await pty(primary, directory, ["open", "--agent", "--no-editor", "--", tree]);
    expect(retried.exitCode).toBe(0);
    expect(retried.output).toContain("Opened existing");
    expect(await snapshot(primary)).toEqual(before);
    expect(await readFile(join(tree, ".env"), "utf8")).toBe("retained fixture\n");
  });
});

test("explicit enable overrides disabled config; explicit disable suppresses enabled config", async () => {
  await withRepository(async (primary, directory) => {
    const capture = join(directory, "capture");
    await configure(primary, capture, { enabled: false });
    const skipped = await pty(primary, directory, ["new", "feature/off", "--no-editor"]);
    expect(skipped.exitCode).toBe(0);
    expect(await Bun.file(capture).exists()).toBe(false);
    const enabled = await pty(primary, directory, ["open", "feature/off", "--agent", "--no-editor"]);
    expect(enabled.exitCode).toBe(0);
    expect(await Bun.file(capture).exists()).toBe(true);
    const suppressedCapture = join(directory, "suppressed");
    await configure(primary, suppressedCapture);
    const suppressed = await pty(primary, directory, ["open", "feature/off", "--no-agent", "--no-editor"]);
    expect(suppressed.exitCode).toBe(0);
    expect(await Bun.file(suppressedCapture).exists()).toBe(false);
  });
});

test("CI and piped commands skip configured agent; explicit noninteractive choice fails before creation", async () => {
  await withRepository(async (primary, directory) => {
    const capture = join(directory, "capture");
    await configure(primary, capture);
    for (const ci of ["true", "1", "yes", "0", "false", ""]) {
      const result = await execa(process.execPath, [entry, "new", `ci-${ci || "empty"}`, "--no-editor"], {
        cwd: primary, reject: false, timeout: 3000, env: { CI: ci },
      });
      expect(result.exitCode).toBe(0);
      expect(await Bun.file(capture).exists()).toBe(false);
    }
    const before = await snapshot(primary);
    const explicit = await execa(process.execPath, [entry, "new", "must-not-exist", "--agent"], {
      cwd: primary, reject: false, timeout: 3000, env: { CI: "false" },
    });
    expect(explicit.exitCode).toBe(1);
    expect(explicit.stderr).toContain("terminal");
    expect(await snapshot(primary)).toEqual(before);
    const ciTerminal = await pty(primary, directory, ["open", "ci-true", "--no-editor"], { env: { CI: "true" } });
    expect(ciTerminal.exitCode).toBe(0);
    expect(await Bun.file(capture).exists()).toBe(false);
    const explicitCI = await pty(primary, directory, ["new", "also-must-not-exist", "--agent"], { env: { CI: "1" } });
    expect(explicitCI.exitCode).toBe(1);
    expect(await snapshot(primary)).toEqual(before);
    for (const ci of ["0", "false", ""]) {
      expect((await pty(primary, directory, ["open", "ci-true", "--no-editor"], { env: { CI: ci } })).exitCode).toBe(0);
    }
    expect(await Bun.file(capture).exists()).toBe(true);
  });
});

test("explicit agent without config fails before Git mutation even with a terminal", async () => {
  await withRepository(async (primary, directory) => {
    const before = await snapshot(primary);
    const result = await pty(primary, directory, ["new", "no-config", "--agent", "--base", "trunk"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/Configure.*agent/i);
    expect(await snapshot(primary)).toEqual(before);
  });
});

test("failed Git or editor setup suppresses configured agent", async () => {
  await withRepository(async (primary, directory) => {
    const capture = join(directory, "capture");
    const editor = `[editor]\ncommand = ${JSON.stringify(join(directory, "missing editor"))}\nargs = []\nenabled = true`;
    await configure(primary, capture, { editor });
    const gitFailure = await pty(primary, directory, ["new", "feature/git-fail", "--base", "missing-base"]);
    expect(gitFailure.exitCode).toBe(1);
    expect(await Bun.file(capture).exists()).toBe(false);
    const editorFailure = await pty(primary, directory, ["new", "feature/editor-fail"]);
    expect(editorFailure.exitCode).toBe(1);
    expect(await Bun.file(capture).exists()).toBe(false);
    const opened = await pty(primary, directory, ["open", "feature/editor-fail"]);
    expect(opened.exitCode).toBe(0);
    expect(await Bun.file(capture).exists()).toBe(false);
  });
});

test("open materializes local branch before interactive stdin and Ctrl-C handling", async () => {
  await withRepository(async (primary, directory) => {
    const capture = join(directory, "capture");
    await git(primary, "branch", "feature/input");
    await configure(primary, capture, { mode: "stdin", args: [] });
    const input = await pty(primary, directory, ["open", "feature/input", "--no-editor"], { input: "hello\n" });
    expect(input.exitCode).toBe(0);
    expect(input.output).toContain("Created worktree");
    expect(input.output).toContain("AGENT_INPUT:hello");
    await configure(primary, capture, { mode: "hold", args: [] });
    const before = await snapshot(primary);
    const interrupt = await pty(primary, directory, ["open", "feature/input", "--no-editor"], { interrupt: true });
    expect(interrupt.exitCode).toBe(130);
    expect(interrupt.output).toContain("Workspace retained");
    expect(await snapshot(primary)).toEqual(before);
    const recorded = JSON.parse(await readFile(capture, "utf8"));
    expect(() => process.kill(recorded.pid, 0)).toThrow();
  });
});
