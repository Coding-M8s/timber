import { expect, test } from "bun:test";
import { createGithubSetupSession } from "../src/setup/github";
import { createKeyboardPrompt } from "../src/setup/keyboard";
import { PassThrough } from "node:stream";
import type { SetupPrompt } from "../src/setup/types";

function prompt(answer: boolean | null = true): SetupPrompt {
  return { select: async () => "", text: async () => "", confirm: async () => answer,
    withTerminal: async run => run(), close() {} };
}

test("GitHub setup offers explicit login and rechecks account without storing credentials", async () => {
  const calls: string[] = []; let output = "";
  const session = createGithubSetupSession({ env: {}, available: async () => true,
    check: async () => { calls.push("check"); if (calls.length === 1) throw new Error("private raw error"); return "octocat"; },
    login: async () => { calls.push("login"); return true; } });
  await session.edit(prompt(), { stdout: value => { output += value; }, stderr: value => { output += value; } });
  expect(calls).toEqual(["check", "login", "check"]);
  expect(output).toContain("octocat");
  expect(output).toContain("Cancelling Timber");
  expect(output).not.toContain("private raw error");
});

test("missing gh, declined login and environment credentials never launch login", async () => {
  for (const mode of ["missing", "declined", "environment"] as const) {
    let launched = false;
    await createGithubSetupSession({ env: mode === "environment" ? { GH_TOKEN: "synthetic" } : {},
      available: async () => mode !== "missing", check: async () => { throw new Error("bad login"); },
      login: async () => { launched = true; return true; },
    }).edit(prompt(false), { stdout() {}, stderr() {} });
    expect(launched).toBe(false);
  }
});

test("failed login reports failure without claiming a successful check", async () => {
  let checks = 0; let output = "";
  await createGithubSetupSession({ env: {}, available: async () => true,
    check: async () => { checks++; throw new Error("private"); }, login: async () => false,
  }).edit(prompt(), { stdout: text => { output += text; }, stderr: text => { output += text; } });
  expect(checks).toBe(1);
  expect(output).toContain("did not complete");
  expect(output).not.toContain("authenticated as");
});

test.each([false, true])("terminal handoff releases raw input and restores prompt after child failure=%s", async failed => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = new PassThrough(); output.resume();
  const terminal = createKeyboardPrompt(input, output);
  try {
    const handoff = terminal.withTerminal!(async () => {
      expect(input.isRaw).toBe(false);
      expect(input.listenerCount("keypress")).toBe(0);
      expect(input.isPaused()).toBe(true);
      if (failed) throw new Error("child failed");
      return "done";
    });
    if (failed) await expect(handoff).rejects.toThrow("child failed"); else expect(await handoff).toBe("done");
    expect(input.isRaw).toBe(true);
    expect(input.listenerCount("keypress")).toBe(1);
    const answer = terminal.text("Still usable"); input.write("ready\r");
    expect(await answer).toBe("ready");
  } finally { terminal.close(); input.destroy(); output.destroy(); }
  expect(input.isRaw).toBe(false);
});

test("interrupt during terminal handoff cancels setup after restoring terminal ownership", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = new PassThrough(); output.resume();
  const terminal = createKeyboardPrompt(input, output);
  try {
    await terminal.withTerminal!(async () => { process.emit("SIGINT"); });
    expect(terminal.signal!.aborted).toBe(true);
    expect(input.listenerCount("keypress")).toBe(1);
  } finally { terminal.close(); input.destroy(); output.destroy(); }
  expect(input.isRaw).toBe(false);
});
