import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBitbucketSetupSession } from "../src/setup/bitbucket";
import { loadSavedBitbucketLogin, readBitbucketCredentialStore, withBitbucketCredentialSave } from "../src/bitbucket/credentials";
import { editTrackerConnections } from "../src/setup/trackers";
import type { SetupPrompt } from "../src/setup/types";

function prompt(answers: (string | boolean | null)[]): SetupPrompt {
  const next = async () => { if (!answers.length) throw new Error("Unexpected question"); return answers.shift()!; };
  return { select: next as SetupPrompt["select"], text: next as SetupPrompt["text"],
    secret: next as NonNullable<SetupPrompt["secret"]>, confirm: next as SetupPrompt["confirm"], close() {} };
}
async function fixture(run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "timber-setup-bitbucket-"));
  try { await run({ HOME: root, XDG_CONFIG_HOME: join(root, "config"), BITBUCKET_API_TOKEN: "ENV_SYNTHETIC" }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function capture() {
  let output = "";
  return { io: { stdout(text: string) { output += text; }, stderr(text: string) { output += text; } }, output: () => output };
}

test("Bitbucket setup keeps the draft private until the whole setup is saved, and never shows the token", async () => {
  await fixture(async env => {
    const out = capture();
    const session = createBitbucketSetupSession(env);
    await session.edit(prompt(["replace", "not an email", " dev@example.com ", "a b", "DRAFT_SYNTHETIC"]), out.io);
    session.review(out.io);
    expect(await loadSavedBitbucketLogin(env)).toBeNull();
    expect(out.output()).toContain("bitbucket.json");
    expect(out.output()).toContain("write:pullrequest:bitbucket");
    expect(out.output()).toContain("BITBUCKET_EMAIL and BITBUCKET_API_TOKEN override");
    expect(out.output()).toContain("save/replace");
    expect(out.output()).not.toMatch(/DRAFT_SYNTHETIC|ENV_SYNTHETIC/u);
    await session.save(async () => {});
    expect(await loadSavedBitbucketLogin(env)).toEqual({ email: "dev@example.com", token: "DRAFT_SYNTHETIC" });
  });
});

test("Bitbucket keep, remove and cancel act on the draft and leave saved bytes alone until save", async () => {
  await fixture(async env => {
    const store = await readBitbucketCredentialStore(env);
    store.set({ email: "old@example.com", token: "OLD" });
    await withBitbucketCredentialSave(store, async () => {});
    const before = await readFile(store.path);
    const out = capture();
    const session = createBitbucketSetupSession(env);
    await session.edit(prompt(["keep"]), out.io);
    await expect(session.edit(prompt(["replace", null]), out.io)).rejects.toThrow(/cancel/iu);
    await session.edit(prompt(["remove"]), out.io);
    expect(await readFile(store.path)).toEqual(before);
    await session.save(async () => {});
    expect(await loadSavedBitbucketLogin(env)).toBeNull();

    const noSecret = prompt(["replace", "dev@example.com"]); delete noSecret.secret;
    await expect(createBitbucketSetupSession(env).edit(noSecret, out.io)).rejects.toThrow("Hidden token input is unavailable");
  });
});

test("the connections menu offers the Bitbucket login", async () => {
  const offered: string[] = [];
  let edited = 0;
  const menu: SetupPrompt = { ...prompt([]), select: async (_message, choices) => {
    offered.push(...choices.map(choice => choice.value));
    return offered.filter(value => value === "bitbucket").length > 1 ? "back" : "bitbucket";
  } };
  await editTrackerConnections(menu, capture().io, { bitbucket: { edit: async () => { edited++; }, review() {}, save: async publish => publish() } });
  expect(offered).toContain("bitbucket");
  expect(edited).toBe(1);
});
