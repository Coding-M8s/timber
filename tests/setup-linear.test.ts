import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinearSetupSession } from "../src/setup/linear";
import { loadSavedLinearKey, readLinearCredentialStore, withLinearCredentialSave } from "../src/linear/credentials";
import type { SetupPrompt } from "../src/setup/types";

function prompt(answers: (string | boolean | null)[]): SetupPrompt {
  const next = async () => { if (!answers.length) throw new Error("Unexpected question"); return answers.shift()!; };
  return { select: next as SetupPrompt["select"], text: next as SetupPrompt["text"],
    secret: next as NonNullable<SetupPrompt["secret"]>, confirm: next as SetupPrompt["confirm"], close() {} };
}
async function fixture(run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "timber-setup-linear-"));
  try { await run({ HOME: root, XDG_CONFIG_HOME: join(root, "config"), LINEAR_API_KEY: "ENV_SYNTHETIC" }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function capture() {
  let output = "";
  return { io: { stdout(text: string) { output += text; }, stderr(text: string) { output += text; } }, output: () => output };
}

test("Linear setup checks draft privately and only saves after publication", async () => {
  await fixture(async env => {
    const out = capture(); let checked = false;
    const session = createLinearSetupSession(env, async (key, signal) => {
      expect(key).toBe("DRAFT_SYNTHETIC"); expect(signal).toBeUndefined(); checked = true;
      expect(await loadSavedLinearKey(env)).toBeNull();
    });
    await session.edit(prompt(["replace", "DRAFT_SYNTHETIC", true]), out.io);
    session.review(out.io);
    expect(checked).toBe(true);
    expect(await loadSavedLinearKey(env)).toBeNull();
    expect(out.output()).toContain("plaintext"); expect(out.output()).toContain("linear.json");
    expect(out.output()).toContain("https://linear.app/docs/api-and-webhooks");
    expect(out.output()).toContain("Read"); expect(out.output()).toContain("team and issue access was not checked");
    expect(out.output()).toContain("LINEAR_API_KEY"); expect(out.output()).not.toMatch(/DRAFT_SYNTHETIC|ENV_SYNTHETIC/u);
    await session.save(async () => {});
    expect(await loadSavedLinearKey(env)).toBe("DRAFT_SYNTHETIC");
  });
});

test("Linear keep, replace and remove act on the current draft", async () => {
  await fixture(async env => {
    const store = await readLinearCredentialStore(env); store.set("OLD"); await withLinearCredentialSave(store, async () => {});
    const session = createLinearSetupSession(env); const out = capture();
    await session.edit(prompt(["keep", false]), out.io);
    await session.edit(prompt(["replace", "NEW", false]), out.io);
    await session.edit(prompt(["keep", false]), out.io);
    await session.edit(prompt(["remove"]), out.io);
    await session.save(async () => {});
    expect(await loadSavedLinearKey(env)).toBeNull();
  });
});

test("Linear failed check permits correction and cancellation without changing saved credentials", async () => {
  await fixture(async env => {
    const store = await readLinearCredentialStore(env); store.set("OLD"); await withLinearCredentialSave(store, async () => {});
    const before = await readFile(store.path); const out = capture(); let checks = 0;
    const session = createLinearSetupSession(env, async () => { checks++; throw new Error("RAW_PRIVATE_TOKEN_ERROR"); });
    await session.edit(prompt(["replace", "BAD_DRAFT", true]), out.io);
    expect(await readFile(store.path)).toEqual(before);
    await session.edit(prompt(["replace", "CORRECTED_DRAFT", false]), out.io);
    await expect(session.edit(prompt([null]), out.io)).rejects.toThrow(/cancel/iu);
    expect(await readFile(store.path)).toEqual(before);
    expect(out.output()).toContain("failed"); expect(out.output()).not.toMatch(/BAD_DRAFT|CORRECTED_DRAFT|RAW_PRIVATE_TOKEN_ERROR/u);
    expect(checks).toBe(1);
  });
});

test("Linear blank secret retries, unavailable secret input refuses, and abort cancels", async () => {
  await fixture(async env => {
    const out = capture(); const session = createLinearSetupSession(env);
    await session.edit(prompt(["replace", " ", "VALID_DRAFT", false]), out.io);
    expect(await loadSavedLinearKey(env)).toBeNull();
    const noSecret = prompt(["replace"]); delete noSecret.secret;
    await expect(session.edit(noSecret, out.io)).rejects.toThrow("Hidden token input is unavailable");
    const cancelled = createLinearSetupSession(env, async () => { throw Object.assign(new Error("PRIVATE_ABORT"), { name: "AbortError" }); });
    await expect(cancelled.edit(prompt(["replace", "VALID_DRAFT", true]), out.io)).rejects.toThrow(/cancel/iu);
    expect(out.output()).not.toContain("PRIVATE_ABORT");
  });
});
