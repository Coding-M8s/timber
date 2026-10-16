import { expect, test } from "bun:test";
import { createEditorTerminalLauncher } from "../src/editor-terminals/launch";
import type { TerminalTask, TaskResult } from "../src/editor-terminals/protocol";
import type { TerminalRequest } from "../src/editor-terminals/request";
import { repositoryFixture, worktreeFixture } from "./helpers/services";
import type { EditorTerminalLaunch } from "../src/services";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const input = (waitForSetup = false): EditorTerminalLaunch => ({
  repository: repositoryFixture(), worktree: worktreeFixture(),
  config: { baseBranch: null, remote: null, worktreeDir: null,
    editor: { command: "orca-ide", args: [], enabled: true, integration: "orca" }, agent: null,
    hooks: { postCreate: ["ordinary"] } },
  agent: { command: "claude", args: ["literal prompt"], waitForSetup }, setup: true,
  workflowName: "review", workflowScripts: ["workflow"],
});
const io = { stdout: () => {}, stderr: () => {} };

function harness(waitForSetup = false, agentFailure = false) {
  const completed = deferred<TaskResult>();
  const started = deferred<void>();
  const events: string[] = [];
  const payloads: TerminalTask[] = [];
  let count = 0;
  const launch = createEditorTerminalLauncher({ self: { executable: "/runtime" },
    ready: async () => {
      events.push("ready");
      return { create: async (title: string) => {
        events.push(title);
        if (agentFailure && title === "Timber agent") throw new Error("handoff uncertain");
        return `term_${++count}`;
      }, select: async () => { events.push("select"); } };
    },
    request: async (task): Promise<TerminalRequest> => {
      payloads.push(task);
      return { directory: "/tmp/generated", bootstrap: "/tmp/generated/runtime", fence: async () => true,
        waitStarted: async () => { events.push(`${task.kind}-started`); started.resolve(); },
        waitSetup: async () => completed.promise,
        cleanup: async () => { events.push(`${task.kind}-cleaned`); } };
    } });
  let finished = false;
  const run = launch(input(waitForSetup), io).finally(() => { finished = true; });
  return { run, events, payloads, completed, started, finished: () => finished };
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
    request: async task => ({ directory: "/tmp/generated", bootstrap: "fixed", fence: async () => true,
      waitStarted: async () => { events.push(task.kind); },
      waitSetup: async () => { throw new Error("must not run setup"); }, cleanup: async () => {} }) });
  await launch({ ...input(true), setup: false }, io);
  expect(events).toEqual(["Timber agent", "agent"]);
});

test("lost setup observation never suggests replay while its hook may still be running", async () => {
  const launch = createEditorTerminalLauncher({ self: { executable: "/runtime" },
    ready: async () => ({ create: async () => "term_setup", select: async () => {} }),
    request: async () => ({ directory: "/tmp/generated", bootstrap: "fixed", fence: async () => false,
      waitStarted: async () => {}, waitSetup: async () => { throw new Error("Setup runner exited without completion"); },
      cleanup: async () => { throw new Error("uncertain request must be retained"); } }) });
  const error = await launch({ ...input(true), agent: null }, io).catch(e => e);
  expect(error.message).toMatch(/inspect/i);
  expect(error.message).toContain("term_setup");
  expect(error.message).not.toContain("timber open");
});
