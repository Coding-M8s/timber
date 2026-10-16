import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiraSetupSession } from "../src/setup/jira";
import { loadSavedCredentials, readCredentialStore, withCredentialSave } from "../src/jira/credentials";
import { JiraLookupFailure } from "../src/jira/client";
import type { SetupPrompt } from "../src/setup/types";
const config = { siteUrl: "https://example.atlassian.net" };
const pair = { email: "person@example.invalid", token: "SYNTHETIC_TOKEN" };
function prompt(answers: (string | boolean | null)[]): SetupPrompt {
  const next = async () => { if (!answers.length) throw new Error("Unexpected question"); return answers.shift()!; };
  return { select: next as SetupPrompt["select"], text: next as SetupPrompt["text"],
    secret: next as NonNullable<SetupPrompt["secret"]>, confirm: next as SetupPrompt["confirm"], close() {} };
}
async function fixture(run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "timber-setup-jira-"));
  try { await run({ HOME: root, XDG_CONFIG_HOME: join(root, "config"), JIRA_EMAIL: "env@example.invalid", JIRA_API_TOKEN: "ENV_SYNTHETIC" }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function capture() {
  let output = "";
  return { io: { stdout(text: string) { output += text; }, stderr(text: string) { output += text; } }, output: () => output };
}
test("setup drafts replacement privately, checks the draft pair, and saves only after explicit publication", async () => {
  await fixture(async env => {
    const io = capture(); let checked = false;
    const session = createJiraSetupSession(env, async (site, credentials) => {
      expect(site).toEqual(config); expect(credentials).toEqual(pair); checked = true;
    });
    await session.edit(config, prompt(["replace", pair.email, pair.token, true]), io.io);
    expect(await loadSavedCredentials(config, env)).toBeNull();
    session.review(io.io);
    expect(io.output()).toContain("plaintext");
    expect(io.output()).toContain("jira.json");
    expect(io.output()).toContain("does not guarantee");
    expect(io.output()).not.toContain(pair.token); expect(io.output()).not.toContain("ENV_SYNTHETIC");
    expect(checked).toBe(true);
    await session.save(async () => {});
    expect(await loadSavedCredentials(config, env)).toEqual(pair);
  });
});

test("keep, replace, and remove use current draft and retain unrelated site credentials", async () => {
  await fixture(async env => {
    const other = { siteUrl: "https://other.atlassian.net" };
    const initial = await readCredentialStore(env); initial.set(config, pair); initial.set(other, pair);
    await withCredentialSave(initial, async () => {});
    const session = createJiraSetupSession(env);
    await session.edit(config, prompt(["keep", false]), capture().io);
    await session.edit(config, prompt(["replace", pair.email, "REPLACEMENT_SYNTHETIC", false]), capture().io);
    await session.edit(config, prompt(["keep", false]), capture().io);
    await session.edit(config, prompt(["remove"]), capture().io);
    await session.save(async () => {});
    expect(await loadSavedCredentials(config, env)).toBeNull();
    expect(await loadSavedCredentials(other, env)).toEqual(pair);
  });
});

test("cancellation, failed checks, and failed saves redact secrets and preserve the prior store", async () => {
  await fixture(async env => {
    const initial = await readCredentialStore(env); initial.set(config, pair);
    await withCredentialSave(initial, async () => {});
    const original = await readFile(initial.path);
    const cancelled = createJiraSetupSession(env);
    await expect(cancelled.edit(config, prompt(["replace", pair.email, null]), capture().io)).rejects.toThrow(/cancel/i);
    expect(await readFile(initial.path)).toEqual(original);
    for (const error of [new Error("RAW_SYNTHETIC"), new JiraLookupFailure("Jira authentication rejected (401).")]) {
      const io = capture();
      const session = createJiraSetupSession(env, async () => { throw error; });
      await session.edit(config, prompt(["replace", pair.email, "REPLACEMENT_SYNTHETIC", true]), io.io);
      expect(io.output()).not.toContain("RAW_SYNTHETIC"); expect(io.output()).not.toContain("REPLACEMENT_SYNTHETIC");
      expect(io.output()).toMatch(/failed/i);
      await expect(session.save(async () => { throw new Error("config failed"); })).rejects.toThrow("config failed");
      expect(await readFile(initial.path)).toEqual(original);
    }
  });
});

test("connection-check AbortError becomes setup cancellation without leaking abort details", async () => {
  await fixture(async env => {
    const abort = Object.assign(new Error("TRANSPORT_ABORT_SYNTHETIC"), { name: "AbortError" });
    const io = capture();
    const session = createJiraSetupSession(env, async () => { throw abort; });
    await expect(session.edit(config, prompt(["replace", pair.email, pair.token, true]), io.io))
      .rejects.toThrow(/Setup cancelled/);
    expect(io.output()).not.toContain("TRANSPORT_ABORT_SYNTHETIC");
  });
});

test("switching site or cloud mode never offers another pair and blank secrets retry without echo", async () => {
  await fixture(async env => {
    const initial = await readCredentialStore(env); initial.set(config, pair); await withCredentialSave(initial, async () => {});
    const session = createJiraSetupSession(env); const io = capture();
    const p = prompt(["replace", "invalid", "", pair.email, pair.token, false]);
    const select = p.select;
    p.select = async (message, choices, defaultValue) => {
      expect(choices.some(choice => choice.value === "remove")).toBe(false);
      return select(message, choices, defaultValue);
    };
    const scoped = { ...config, cloudId: "00000000-0000-4000-8000-000000000000" };
    await session.edit(scoped, p, io.io);
    await session.save(async () => {});
    expect(await loadSavedCredentials(scoped, env)).toEqual(pair);
    expect(await loadSavedCredentials(config, env)).toEqual(pair);
    expect(io.output()).not.toContain(pair.token);
  });
});
