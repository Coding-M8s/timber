import { expect, test } from "bun:test";
import { createSetupHandler } from "../src/commands/setup";
import { placeholderHandlers, runCli } from "../src/cli";
import type { SetupPrompt, SetupTarget } from "../src/setup/types";
import { repositoryFixture } from "./helpers/services";

const file = { path: "/repo/.timber.toml", source: null, values: {} };
const target: SetupTarget = { scope: "repository", path: file.path, file,
  scopes: { local: file, global: { path: "/home/config.toml", source: null, values: {} } },
  repository: repositoryFixture(), branches: ["main"], tracked: false, exclude: null };

async function setup(options: { interactive?: boolean; tracked?: boolean; existing?: boolean; save?: boolean; cancel?: boolean; global?: boolean } = {}) {
  let stdout = ""; let stderr = ""; let writes = 0; let prompted = false;
  const destination = { ...target, tracked: options.tracked ?? false,
    file: { ...file, source: options.existing ? 'remote = "upstream"' : null,
      values: options.existing ? { remote: "upstream" } : {} } };
  const prompt: SetupPrompt = {
    select: async (message, _choices, defaultValue) => options.cancel ? null : message.includes("Tracked") ? "cancel" : defaultValue,
    text: async () => { throw new Error("unexpected text"); },
    confirm: async () => options.save ?? false, close() {},
  };
  const handler = createSetupHandler({
    inspectTarget: async (global, cwd) => { expect(cwd).toBe("/repo"); expect(global).toBe(options.global ?? false); return destination; },
    prompt: () => { prompted = true; return prompt; }, checkExecutable: async () => true,
    save: async (_target, source, approved) => { writes++; expect(source).toContain("# Timber"); expect(approved).toBe(false); },
  });
  const code = await runCli(["setup", ...(options.global ? ["--global"] : [])], {
    handlers: { ...placeholderHandlers, setup: handler }, context: { cwd: "/repo", interactive: options.interactive ?? true,
      io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } } },
  });
  return { code, stdout, stderr, writes, prompted };
}

test("setup summary precedes saving and names repository destination", async () => {
  const result = await setup({ save: true });
  expect(result.code).toBe(0);
  expect(result.writes).toBe(1);
  expect(result.stdout.indexOf("Summary")).toBeLessThan(result.stdout.indexOf("Saved"));
  expect(result.stdout).toContain("/repo/.timber.toml");
});

test("declining replacement and cancelling questionnaire never writes settings", async () => {
  for (const options of [{ existing: true }, { cancel: true }, { tracked: true }]) {
    const result = await setup(options);
    expect(result.code).toBe(0);
    expect(result.writes).toBe(0);
    expect(result.stdout).toContain("Cancelled");
  }
});

test("noninteractive setup fails before asking or saving", async () => {
  const result = await setup({ interactive: false });
  expect(result.code).toBe(1);
  expect(result.prompted).toBe(false);
  expect(result.writes).toBe(0);
  expect(result.stderr).toContain("interactive terminal");
});

test("setup --global dispatches scope and help without prompting", async () => {
  expect((await setup({ global: true })).code).toBe(0);
  let stdout = "";
  const code = await runCli(["setup", "--help"], { context: { cwd: "/outside",
    io: { stdout: text => { stdout += text; }, stderr: () => {} } } });
  expect(code).toBe(0);
  expect(stdout).toContain("--global");
});
