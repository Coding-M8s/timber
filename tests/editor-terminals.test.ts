import { expect, test } from "bun:test";
import { createEditorTerminalLauncher } from "../src/editor-terminals/launch";
import { OrcaSelectionFailure } from "../src/editor-terminals/orca";
import type { TerminalTask, TaskResult } from "../src/editor-terminals/protocol";
import type { TerminalRequest } from "../src/editor-terminals/request";
import { repositoryFixture, worktreeFixture } from "./helpers/services";
import type { EditorTerminalLaunch } from "../src/services";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const editors = {
  orca: { command: "orca-ide", args: [], enabled: true, integration: "orca" },
  vscode: { command: "code", args: ["--new-window"], enabled: true, integration: "vscode" },
} as const;
const input = (waitForSetup = false, integration: keyof typeof editors = "orca"): EditorTerminalLaunch => ({
  repository: repositoryFixture(), worktree: worktreeFixture(),
  config: { baseBranch: null, remote: null, worktreeDir: null,
    editor: { ...editors[integration], args: [...editors[integration].args] }, agent: null,
    hooks: { postCreate: ["ordinary"] } },
  agent: { command: "claude", args: ["literal prompt"], waitForSetup }, setup: true,
  workflowName: "review", workflowScripts: ["workflow"],
});
const io = { stdout: () => {}, stderr: () => {} };

function harness(waitForSetup = false, agentFailure = false, integration: keyof typeof editors = "orca") {
  const completed = deferred<TaskResult>();
  const started = deferred<void>();
  const events: string[] = [];
  const payloads: TerminalTask[] = [];
  const argvs: (readonly string[] | undefined)[] = [];
  const output: string[] = [];
  let count = 0;
  const launch = createEditorTerminalLauncher({ self: { executable: "/runtime" },
    ready: async () => {
      events.push("ready");
      return { create: async (title: string, _bootstrap?: string, argv?: readonly string[]) => {
        events.push(title);
        argvs.push(argv);
        if (agentFailure && title === "Timber agent") throw new Error("handoff uncertain");
        return `term_${++count}`;
      }, select: async () => { events.push("select"); } };
    },
    request: async (task): Promise<TerminalRequest> => {
      payloads.push(task);
      return { directory: "/tmp/generated", bootstrap: "/tmp/generated/runtime __editor-task /tmp/generated",
        argv: ["/tmp/generated/runtime", "__editor-task", "/tmp/generated"], fence: async () => true,
        waitStarted: async () => { events.push(`${task.kind}-started`); started.resolve(); },
        waitSetup: async () => completed.promise,
        cleanup: async () => { events.push(`${task.kind}-cleaned`); } };
    } });
  let finished = false;
  const run = launch(input(waitForSetup, integration), { stdout: text => { output.push(text); }, stderr: () => {} })
    .finally(() => { finished = true; });
  return { run, events, payloads, argvs, output, completed, started, finished: () => finished };
}

test("parallel mode hands off agent before required setup completes and passes exact context", async () => {
  const h = harness();
  await h.started.promise;
  await Bun.sleep(5);
  expect(h.events).toContain("agent-started");
  expect(h.finished()).toBe(false);
  expect(h.payloads[0]).toEqual({ kind: "setup", cwd: "/repo", repositoryRoot: "/repo", branch: "main",
    workflow: "review", hooks: ["ordinary"], workflowHooks: ["workflow"] });
  expect(h.payloads[1]).toMatchObject({ kind: "agent", cwd: "/repo", command: "claude", args: ["literal prompt"] });
  h.completed.resolve({ kind: "setup-complete" });
  await h.run;
});

test("setup dependency blocks agent until successful setup", async () => {
  const h = harness(true);
  await h.started.promise;
  expect(h.events).not.toContain("Timber agent");
  h.completed.resolve({ kind: "setup-complete" });
  await h.run;
  expect(h.events).toContain("agent-started");
});

test.each([false, true])("failed setup retains an already-started parallel agent, dependency=%s", async dependent => {
  const h = harness(dependent);
  await h.started.promise;
  await Bun.sleep(5);
  h.completed.resolve({ kind: "setup-failed", step: 2, phase: "workflow", reason: "exit code 7" });
  await expect(h.run).rejects.toThrow(/step 2.*--editor --setup --no-agent/);
  expect(h.events.includes("agent-started")).toBe(!dependent);
  expect(h.events).not.toContain("kill");
});

test("agent handoff failure still awaits setup before returning", async () => {
  const h = harness(false, true);
  await h.started.promise;
  await Bun.sleep(5);
  expect(h.events).toContain("Timber agent");
  expect(h.finished()).toBe(false);
  h.completed.resolve({ kind: "setup-complete" });
  await expect(h.run).rejects.toThrow(/handoff uncertain/);
  expect(h.events).toContain("setup-cleaned");
});

test("readiness failure creates no requests or terminals", async () => {
  const launch = createEditorTerminalLauncher({ self: { executable: "/runtime" },
    ready: async () => { throw new Error("not ready"); },
    request: async () => { throw new Error("must not allocate"); } });
  await expect(launch(input(), io)).rejects.toThrow("not ready");
});

test("explicit agent-only launch with setup dependency does not require setup", async () => {
  const events: string[] = [];
  const launch = createEditorTerminalLauncher({ self: { executable: "/runtime" },
    ready: async () => ({ create: async title => { events.push(title); return "term_agent"; }, select: async () => {} }),
    request: async task => ({ directory: "/tmp/generated", bootstrap: "fixed", argv: ["fixed"], fence: async () => true,
      waitStarted: async () => { events.push(task.kind); },
      waitSetup: async () => { throw new Error("must not run setup"); }, cleanup: async () => {} }) });
  await launch({ ...input(true), setup: false }, io);
  expect(events).toEqual(["Timber agent", "agent"]);
});

test("lost setup observation never suggests replay while its hook may still be running", async () => {
  const launch = createEditorTerminalLauncher({ self: { executable: "/runtime" },
    ready: async () => ({ create: async () => "term_setup", select: async () => {} }),
    request: async () => ({ directory: "/tmp/generated", bootstrap: "fixed", argv: ["fixed"], fence: async () => false,
      waitStarted: async () => {}, waitSetup: async () => { throw new Error("Setup runner exited without completion"); },
      cleanup: async () => { throw new Error("uncertain request must be retained"); } }) });
  const error = await launch({ ...input(true), agent: null }, io).catch(e => e);
  expect(error.message).toMatch(/inspect/i);
  expect(error.message).toContain("term_setup");
  expect(error.message).not.toContain("timber open");
});

test("readiness failure reports the retained path and one retry for everything not started", async () => {
  const launch = createEditorTerminalLauncher({ self: { executable: "/runtime" },
    ready: async () => { throw new Error("not ready"); },
    request: async () => { throw new Error("must not allocate"); } });
  for (const [request, flags] of [
    [input(), "--editor --setup --agent"],
    [{ ...input(), agent: null }, "--editor --setup --no-agent"],
    [{ ...input(), setup: false }, "--editor --agent"],
    [{ ...input(), setup: false, agent: null }, "--editor"],
  ] as const) {
    const error = await launch(request, io).catch(e => e);
    expect(error.message).toContain("not ready");
    expect(error.message).toContain("Workspace retained at /repo");
    expect(error.message).toContain(`Retry with: timber open ${flags} --workflow review -- '/repo'`);
  }
});

test("a refused terminal creation fences the request and reports a definitive retry", async () => {
  const events: string[] = [];
  const launch = createEditorTerminalLauncher({ self: { executable: "/runtime" },
    ready: async () => ({ create: async () => { throw new Error("Orca refused permission."); }, select: async () => {} }),
    request: async task => ({ directory: "/tmp/generated", bootstrap: "fixed", argv: ["fixed"],
      fence: async () => { events.push(`${task.kind}-fenced`); return true; },
      waitStarted: async () => { throw new Error("must not wait"); }, waitSetup: async () => { throw new Error("must not run"); },
      cleanup: async () => { events.push(`${task.kind}-cleaned`); } }) });
  const error = await launch(input(), io).catch(e => e);
  expect(error.message).toContain("Orca refused permission.");
  expect(error.message).toContain("Retry with: timber open --editor --setup --agent --workflow review -- '/repo'");
  expect(events).toEqual(["setup-fenced", "setup-cleaned"]);
  const agentOnly = await launch({ ...input(), setup: false }, io).catch(e => e);
  expect(agentOnly.message).toContain("Retry with: timber open --editor --agent --workflow review -- '/repo'");
});

test.each(["setup", "agent"])("selection failure retains the known %s terminal and awaits required setup", async failed => {
  const setupDone = deferred<TaskResult>();
  const attempted = deferred<void>();
  const events: string[] = [];
  const launch = createEditorTerminalLauncher({ self: { executable: "/runtime" },
    ready: async () => ({ create: async title => {
      events.push(title);
      if (title === `Timber ${failed}`) { attempted.resolve(); throw new OrcaSelectionFailure(`term_${failed}`); }
      return "term_setup";
    }, select: async () => {} }),
    request: async task => ({ directory: "/tmp/generated", bootstrap: "fixed", argv: ["fixed"],
      fence: async () => { events.push("fenced"); return true; },
      waitStarted: async () => { events.push(`${task.kind}-started`); },
      waitSetup: async () => setupDone.promise,
      cleanup: async () => { events.push(`${task.kind}-cleaned`); } }) });
  let settled = false;
  const outcome = launch(input(), io).then(() => null, error => error).finally(() => { settled = true; });
  await attempted.promise;
  await Bun.sleep(5);
  expect(settled).toBe(false);
  expect(events).toContain(`${failed}-started`);
  expect(events).not.toContain("fenced");
  setupDone.resolve({ kind: "setup-complete" });
  const error = await outcome;
  expect(error.message).toContain(`term_${failed}`);
  expect(error.message).toMatch(/inspect/i);
  expect(error.message).toContain("Workspace retained at /repo");
  expect(error.message).not.toContain("timber open");
  expect(events).toContain("setup-cleaned");
  expect(events.filter(e => e === "Timber agent")).toHaveLength(failed === "agent" ? 1 : 0);
});

test("VS Code integration reuses the same lifecycle, passes literal argv and names VS Code", async () => {
  const h = harness(true, false, "vscode");
  await h.started.promise;
  expect(h.events).not.toContain("Timber agent");
  h.completed.resolve({ kind: "setup-complete" });
  await h.run;
  expect(h.events.filter(event => event.startsWith("Timber "))).toEqual(["Timber setup", "Timber agent"]);
  expect(h.argvs).toEqual([
    ["/tmp/generated/runtime", "__editor-task", "/tmp/generated"],
    ["/tmp/generated/runtime", "__editor-task", "/tmp/generated"],
  ]);
  expect(h.output.join("")).toContain("Agent handed off to VS Code terminal term_2.");
});

test("VS Code readiness failure names VS Code and retries everything that was requested", async () => {
  const launch = createEditorTerminalLauncher({ self: { executable: "/runtime" },
    ready: async () => { throw new Error("The Timber VS Code extension is not installed."); },
    request: async () => { throw new Error("must not allocate"); } });
  const error = await launch(input(false, "vscode"), io).catch(e => e);
  expect(error.message).toContain("The Timber VS Code extension is not installed.");
  expect(error.message).toContain("Retry with: timber open --editor --setup --agent --workflow review -- '/repo'");
});

test("an editor without an integration is refused before any session starts", async () => {
  const launch = createEditorTerminalLauncher({ self: { executable: "/runtime" },
    ready: async () => { throw new Error("must not start"); } });
  const plain = input();
  plain.config = { ...plain.config, editor: { command: "code", args: [], enabled: true } };
  await expect(launch(plain, io)).rejects.toThrow(/Orca or VS Code integration/);
});
