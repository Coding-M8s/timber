import { expect, test } from "bun:test";
import { createSetupHandler } from "../src/commands/setup";
import { createGithubSetupSession } from "../src/setup/github";
import { repositoryFixture } from "./helpers/services";
import type { SetupPrompt, SetupTarget } from "../src/setup/types";

test.each([false, true])("GitHub setup entry works in both scopes and cancellation preserves Jira draft, global=%s", async global => {
  const file = { path: "/settings/config.toml", source: null, values: {} };
  const target: SetupTarget = { scope: global ? "global" : "repository", path: file.path, file,
    scopes: { global: file, local: global ? null : file }, repository: repositoryFixture(),
    branches: [], tracked: false, exclude: null };
  const actions = ["connections", "jira", "configure", "github", "back", "cancel"];
  let logins = 0; let saves = 0; let jiraDraft: string | undefined;
  const prompt: SetupPrompt = { select: async (_message, choices) => {
    const next = actions.shift()!;
    expect(choices.some(choice => choice.value === next)).toBe(true);
    return next;
  }, text: async () => "https://example.atlassian.net", confirm: async () => jiraDraft !== undefined,
    close() {}, withTerminal: async run => run() };
  const handler = createSetupHandler({ inspectTarget: async () => target, prompt: () => prompt,
    checkExecutable: async () => true, save: async () => { saves++; },
    jira: () => ({ edit: async config => { jiraDraft = config.siteUrl; }, review() {
      if (logins) expect(jiraDraft).toBe("https://example.atlassian.net");
    }, save: async () => { throw new Error("Jira must remain unpublished"); } }),
    github: () => createGithubSetupSession({ env: {}, available: async () => true,
      check: async () => { if (!logins) throw new Error("no login"); return "octocat"; },
      login: async () => { expect(jiraDraft).toBe("https://example.atlassian.net"); logins++; return true; } }),
  });
  await handler({ global }, { cwd: "/repo", interactive: true, io: { stdout() {}, stderr() {} } });
  expect(logins).toBe(1);
  expect(saves).toBe(0);
  expect(file.values).toEqual({});
});

test.skipIf(process.platform === "win32").each([false, true])("real setup login terminal handoff handles child exit and interrupt=%s", async interrupt => {
  let output = ""; let childAnswered = false; let parentAnswered = false; let confirmed = false;
  const fixture = new URL("./fixtures/setup-github-parent.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "--no-env-file", fixture], { timeout: 5000,
    terminal: { data(terminal, bytes) {
      output += Buffer.from(bytes).toString("utf8");
      if (!confirmed && output.includes("Run gh auth login for github.com now?")) { confirmed = true; terminal.write("1"); }
      if (!childAnswered && output.includes("CHILD_READY")) { childAnswered = true; terminal.write(interrupt ? "\u0003" : "child-answer\n"); }
      if (!parentAnswered && output.includes("Parent resumed")) { parentAnswered = true; terminal.write("parent-answer\r"); }
    } },
  });
  try {
    expect(await child.exited).toBe(0);
    if (interrupt) expect(output).toContain('PARENT_RESULT:{"answer":null,"cancelled":true,"rawRestored":true}');
    else {
      expect(output).toContain('CHILD_RESULT:{"tty":true,"answer":"child-answer"}');
      expect(output).toContain('PARENT_RESULT:{"answer":"parent-answer","cancelled":false,"rawRestored":true}');
    }
  } finally { child.kill(); child.terminal?.close(); }
});
