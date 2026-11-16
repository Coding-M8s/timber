import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinearSetupSession } from "../src/setup/linear";
import { createJiraSetupSession } from "../src/setup/jira";
import { loadSavedLinearKey, readLinearCredentialStore, withLinearCredentialSave } from "../src/linear/credentials";
import { loadSavedCredentials, readCredentialStore, withCredentialSave } from "../src/jira/credentials";
import type { ChoiceOption } from "../src/selection";
import type { SetupPrompt } from "../src/setup/types";

const repoA = "/synthetic/repo-a/.git";
const repoB = "/synthetic/repo-b/.git";

function prompt(answers: (string | boolean | null)[], menus: string[][] = []): SetupPrompt {
  const next = async () => { if (!answers.length) throw new Error("Unexpected question"); return answers.shift()!; };
  return {
    select: (async (_message: string, choices: readonly ChoiceOption[]) => { menus.push(choices.map(choice => choice.label)); return next(); }) as SetupPrompt["select"],
    text: next as SetupPrompt["text"], secret: next as NonNullable<SetupPrompt["secret"]>, confirm: next as SetupPrompt["confirm"], close() {},
  };
}
function capture() {
  let output = "";
  return { io: { stdout(text: string) { output += text; }, stderr(text: string) { output += text; } }, output: () => output };
}
async function fixture(run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "timber-setup-associations-"));
  try { await run({ HOME: root, XDG_CONFIG_HOME: join(root, "config") }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function savedLinear(env: NodeJS.ProcessEnv, entries: Record<string, string>, associations: Record<string, string> = {}) {
  const store = await readLinearCredentialStore(env);
  for (const [label, key] of Object.entries(entries)) store.set(key, label);
  for (const [repository, label] of Object.entries(associations)) store.associate(repository, label);
  await withLinearCredentialSave(store, async () => {});
}

test("Linear setup adds a second key for this repository and warns that others must select one", async () => {
  await fixture(async env => {
    await savedLinear(env, { default: "SYNTHETIC_FIRST" });
    const out = capture(); const menus: string[][] = [];
    const session = createLinearSetupSession(env, undefined, repoA);
    await session.edit(prompt(["add", "Bad Label", "default", "acme", "SYNTHETIC_ACME", true, false], menus), out.io);
    expect(menus[0]).toContain("Add another personal API key (for a different workspace or account)");
    session.review(out.io);
    expect(out.output()).toContain("Invalid label");
    expect(out.output()).toContain("already saved");
    expect(out.output()).toContain("each repository must select one");
    expect(out.output()).toContain('save/replace "acme"');
    expect(out.output()).toContain('use "acme" for this repository');
    expect(out.output()).not.toMatch(/SYNTHETIC/u);
    expect(await loadSavedLinearKey(env, undefined, repoA)).toBe("SYNTHETIC_FIRST");
    await session.save(async () => {});
    expect(await loadSavedLinearKey(env, undefined, repoA)).toBe("SYNTHETIC_ACME");
    await expect(loadSavedLinearKey(env, undefined, repoB)).rejects.toThrow("timber setup in this repository");
  });
});

test("Linear declining the new key keeps this repository on its previous default", async () => {
  await fixture(async env => {
    await savedLinear(env, { default: "SYNTHETIC_FIRST" });
    const session = createLinearSetupSession(env, undefined, repoA);
    await session.edit(prompt(["add", "acme", "SYNTHETIC_ACME", false, false]), capture().io);
    await session.save(async () => {});
    expect(await loadSavedLinearKey(env, undefined, repoA)).toBe("SYNTHETIC_FIRST");
  });
});

test("Linear machine-default setup adds entries without choosing a repository", async () => {
  await fixture(async env => {
    await savedLinear(env, { default: "SYNTHETIC_FIRST" });
    const session = createLinearSetupSession(env);
    await session.edit(prompt(["add", "acme", "SYNTHETIC_ACME", false]), capture().io);
    await session.save(async () => {});
    const store = await readLinearCredentialStore(env);
    expect(store.labels()).toEqual(["default", "acme"]);
    expect(store.users("acme")).toEqual([]);
  });
});

test("Linear selects, replaces, forgets and removes with confirmation for other repositories", async () => {
  await fixture(async env => {
    await savedLinear(env, { acme: "SYNTHETIC_ACME", home: "SYNTHETIC_HOME" }, { [repoA]: "acme" });
    const out = capture(); const menus: string[][] = [];
    const session = createLinearSetupSession(env, undefined, repoB);
    await session.edit(prompt(["keep"], menus), out.io);
    expect(menus[0]).toEqual([
      "Keep (no personal API key selected for this repository)",
      'Use "acme" for this repository', 'Use "home" for this repository',
      "Add another personal API key",
      'Replace "acme"', 'Replace "home"',
      'Remove "acme" (selected by 1 other repository)', 'Remove "home"',
    ]);
    await session.edit(prompt(["use:home", false]), out.io);
    await session.edit(prompt(["replace:home", "SYNTHETIC_HOME_2", false]), out.io);
    await session.edit(prompt(["remove:acme", false]), out.io);
    await session.save(async () => {});
    expect(await loadSavedLinearKey(env, undefined, repoA)).toBe("SYNTHETIC_ACME");
    expect(await loadSavedLinearKey(env, undefined, repoB)).toBe("SYNTHETIC_HOME_2");

    const forget = createLinearSetupSession(env, undefined, repoB);
    await forget.edit(prompt(["forget"]), out.io);
    await forget.save(async () => {});
    await expect(loadSavedLinearKey(env, undefined, repoB)).rejects.toThrow("none is selected");
    expect(await loadSavedLinearKey(env, undefined, repoA)).toBe("SYNTHETIC_ACME");

    const remove = createLinearSetupSession(env, undefined, repoB);
    await remove.edit(prompt(["remove:acme", true]), out.io);
    await remove.save(async () => {});
    expect(out.output()).toContain('"home" is now used by every repository');
    expect(await loadSavedLinearKey(env, undefined, repoA)).toBe("SYNTHETIC_HOME_2");
    expect(out.output()).not.toMatch(/SYNTHETIC/u);
  });
});

test("Linear cancellation during a new entry preserves saved keys and associations", async () => {
  await fixture(async env => {
    await savedLinear(env, { acme: "SYNTHETIC_ACME", home: "SYNTHETIC_HOME" }, { [repoA]: "acme" });
    const store = await readLinearCredentialStore(env); const before = await readFile(store.path);
    const session = createLinearSetupSession(env, undefined, repoA);
    await expect(session.edit(prompt(["add", "work", null]), capture().io)).rejects.toThrow(/cancel/iu);
    const other = createLinearSetupSession(env, undefined, repoB);
    await expect(other.edit(prompt(["remove:acme", null]), capture().io)).rejects.toThrow(/cancel/iu);
    await other.save(async () => {});
    expect(await readFile(store.path)).toEqual(before);
  });
});

test("Jira setup distinguishes logins by label and email without showing tokens", async () => {
  await fixture(async env => {
    const site = { siteUrl: "https://example.atlassian.net" };
    const store = await readCredentialStore(env);
    store.set(site, { email: "personal@example.invalid", token: "SYNTHETIC_PERSONAL" });
    await withCredentialSave(store, async () => {});
    const out = capture(); const menus: string[][] = [];
    const session = createJiraSetupSession(env, undefined, repoA);
    await session.edit(site, prompt(["add", "work", "work@example.invalid", "SYNTHETIC_WORK", true, false], menus), out.io);
    await session.edit(site, prompt(["keep", false], menus), out.io);
    expect(menus[1]).toContain('Keep: this repository uses "work" (work@example.invalid)');
    expect(menus[1]).toContain('Use "default" (personal@example.invalid) for this repository');
    session.review(out.io);
    expect(out.output()).toContain('save/replace "work" for https://example.atlassian.net (unscoped)');
    expect(out.output()).not.toMatch(/SYNTHETIC/u);
    await session.save(async () => {});
    expect(await loadSavedCredentials(site, env, repoA)).toEqual({ email: "work@example.invalid", token: "SYNTHETIC_WORK" });
    await expect(loadSavedCredentials(site, env, repoB)).rejects.toThrow("JIRA_EMAIL and JIRA_API_TOKEN");
  });
});
