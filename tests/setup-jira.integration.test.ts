import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSetupHandler } from "../src/commands/setup";
import { createJiraSetupSession } from "../src/setup/jira";
import { inspectSetupTarget, saveSetupConfig } from "../src/setup/storage";
import { loadSavedCredentials, readCredentialStore } from "../src/jira/credentials";
import { parseConfigSource } from "../src/config";
import type { SetupPrompt } from "../src/setup/types";
import { git, withRepository } from "./helpers/git";
const config = { siteUrl: "https://example.atlassian.net" };
const pair = { email: "person@example.invalid", token: "SYNTHETIC_TOKEN" };
function scripted(answers: (string | boolean | null)[]): SetupPrompt {
  const next = async () => { if (!answers.length) throw new Error("Unexpected question"); return answers.shift()!; };
  return { select: next as SetupPrompt["select"], text: next as SetupPrompt["text"], secret: next as NonNullable<SetupPrompt["secret"]>,
    confirm: next as SetupPrompt["confirm"], close() {} };
}

for (const scope of ["repository", "global"] as const) {
  for (const outcome of ["save", "cancel", "failed-save"] as const) {
    test(`${scope} Jira setup ${outcome} keeps Git/user files intact and credentials out of TOML`, async () => {
      await withRepository(async (primary, directory) => {
        const env = { HOME: directory, XDG_CONFIG_HOME: join(directory, "config") };
        await writeFile(join(primary, "tracked.txt"), "dirty tracked work\n");
        await writeFile(join(primary, "untracked.txt"), "private work\n");
        const refs = await git(primary, "show-ref");
        const trees = await git(primary, "worktree", "list", "--porcelain");
        const index = await readFile(join(primary, ".git/index"));
        const exclusion = await readFile(join(primary, ".git/info/exclude"));
        let output = ""; let closed = false;
        const prompt = scripted(["keep", "keep", "configure", config.siteUrl + "/", false,
          "replace", pair.email, pair.token, true, false, outcome === "cancel" ? "cancel" : "save"]);
        prompt.close = () => { closed = true; };
        const handler = createSetupHandler({ inspectTarget: (global, cwd) => inspectSetupTarget(global, cwd, env),
          prompt: () => prompt, checkExecutable: async () => true,
          jira: () => createJiraSetupSession(env, async () => {
            expect(await git(primary, "show-ref")).toBe(refs);
            expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
            expect(await readFile(join(primary, ".git/index"))).toEqual(index);
            expect(await loadSavedCredentials(config, env)).toBeNull();
          }),
          save: (target, source, approved, signal) => saveSetupConfig(target, source, approved, signal,
            outcome === "failed-save" ? { link: async () => { throw new Error("SYNTHETIC_PRIVATE_WRITE_FAILURE"); } } : {}),
        });
        const execution = handler({ global: scope === "global" }, { cwd: scope === "global" ? directory : primary,
          interactive: true, io: { stdout(text) { output += text; }, stderr(text) { output += text; } } });
        if (outcome === "failed-save") await expect(execution).rejects.toThrow(/preserved/);
        else await execution;
        const path = scope === "global" ? join(directory, "config/timber/config.toml") : join(primary, ".timber.toml");
        if (outcome === "save") {
          expect(parseConfigSource(await readFile(path, "utf8"), path)).toEqual({ jira: { site_url: config.siteUrl } });
          expect(await loadSavedCredentials(config, env)).toEqual(pair);
          expect(await readFile(path, "utf8")).not.toContain(pair.token);
          expect(await readFile(path, "utf8")).not.toContain(pair.email);
        } else {
          expect(await Bun.file(path).exists()).toBe(false);
          expect(await Bun.file((await readCredentialStore(env)).path).exists()).toBe(false);
          expect(await readFile(join(primary, ".git/info/exclude"))).toEqual(exclusion);
        }
        expect(closed).toBe(true); expect(output).not.toContain(pair.token);
        expect(output).not.toContain("SYNTHETIC_PRIVATE_WRITE_FAILURE");
        expect(await git(primary, "show-ref")).toBe(refs);
        expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
        expect(await readFile(join(primary, ".git/index"))).toEqual(index);
        expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("dirty tracked work\n");
        expect(await readFile(join(primary, "untracked.txt"), "utf8")).toBe("private work\n");
      });
    });
  }
}
