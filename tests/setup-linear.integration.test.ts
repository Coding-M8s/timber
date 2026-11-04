import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSetupHandler } from "../src/commands/setup";
import { createLinearSetupSession } from "../src/setup/linear";
import { createJiraSetupSession } from "../src/setup/jira";
import { loadSavedLinearKey, readLinearCredentialStore, withLinearCredentialSave } from "../src/linear/credentials";
import { loadSavedCredentials, readCredentialStore, withCredentialSave } from "../src/jira/credentials";
import { inspectSetupTarget, saveSetupConfig } from "../src/setup/storage";
import { SetupVisibilityError } from "../src/setup/types";
import type { SetupPrompt } from "../src/setup/types";
import { git, withRepository } from "./helpers/git";

const site = { siteUrl: "https://example.atlassian.net" };
const oldJira = { email: "person@example.invalid", token: "OLD_JIRA" };
function scripted(answers: (string | boolean | null)[]): SetupPrompt {
  const next = async () => { if (!answers.length) throw new Error("Unexpected question"); return answers.shift()!; };
  return { select: next as SetupPrompt["select"], text: next as SetupPrompt["text"], secret: next as NonNullable<SetupPrompt["secret"]>,
    confirm: next as SetupPrompt["confirm"], close() {} };
}

for (const scope of ["repository", "global"] as const) {
  for (const outcome of ["save", "cancel", "failed-config", "failed-linear"] as const) {
    test(`${scope} combined Linear/Jira drafts ${outcome} retain Git state and only publish on Save`, async () => {
      await withRepository(async (primary, root) => {
        const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config") };
        const initialJira = await readCredentialStore(env); initialJira.set(site, oldJira); await withCredentialSave(initialJira, async () => {});
        const initialLinear = await readLinearCredentialStore(env); initialLinear.set("OLD_LINEAR"); await withLinearCredentialSave(initialLinear, async () => {});
        const jiraBytes = await readFile(initialJira.path); const linearBytes = await readFile(initialLinear.path);
        await writeFile(join(primary, "tracked.txt"), "dirty\n"); await writeFile(join(primary, "untracked.txt"), "private\n");
        const refs = await git(primary, "show-ref"); const trees = await git(primary, "worktree", "list", "--porcelain"); const index = await readFile(join(primary, ".git/index"));
        let output = ""; let checked = false;
        const prompt = scripted(["jira", "configure", site.siteUrl, false, "replace", oldJira.email, "NEW_JIRA", false,
          "linear", "replace", "NEW_LINEAR", true, outcome === "cancel" ? "cancel" : "save"]);
        const handler = createSetupHandler({ inspectTarget: (global, cwd) => inspectSetupTarget(global, cwd, env), prompt: () => prompt, checkExecutable: async () => true,
          jira: () => createJiraSetupSession(env), linear: () => createLinearSetupSession(env, async key => {
            expect(key).toBe("NEW_LINEAR"); checked = true;
            expect(await readFile(initialLinear.path)).toEqual(linearBytes); expect(await readFile(initialJira.path)).toEqual(jiraBytes);
            if (outcome === "failed-linear") await writeFile(join(dirname(initialLinear.path), ".linear.lock"), "OTHER_SETUP");
          }),
          save: async (target, source, approved, signal) => {
            if (outcome === "failed-config") throw new Error("safe publication failure");
            await saveSetupConfig(target, source, approved, signal);
          },
        });
        const run = handler({ global: scope === "global" }, { cwd: scope === "global" ? root : primary, interactive: true,
          io: { stdout: text => { output += text; }, stderr: text => { output += text; } } });
        if (outcome.startsWith("failed")) await expect(run).rejects.toThrow(outcome === "failed-linear" ? "locked" : "safe publication failure");
        else await run;
        expect(checked).toBe(true);
        const configPath = scope === "global" ? join(root, "config/timber/config.toml") : join(primary, ".timber.toml");
        if (outcome === "save") {
          expect(await loadSavedLinearKey(env)).toBe("NEW_LINEAR"); expect(await loadSavedCredentials(site, env)).toEqual({ ...oldJira, token: "NEW_JIRA" });
          expect(await readFile(configPath, "utf8")).not.toMatch(/LINEAR|NEW_JIRA|OLD_JIRA/u);
        } else {
          expect(await readFile(initialLinear.path)).toEqual(linearBytes); expect(await readFile(initialJira.path)).toEqual(jiraBytes);
          expect(await Bun.file(configPath).exists()).toBe(false);
        }
        expect(output).not.toMatch(/NEW_LINEAR|OLD_LINEAR|NEW_JIRA|OLD_JIRA/u);
        expect(await git(primary, "show-ref")).toBe(refs); expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
        expect(await readFile(join(primary, ".git/index"))).toEqual(index);
        expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("dirty\n"); expect(await readFile(join(primary, "untracked.txt"), "utf8")).toBe("private\n");
      });
    });
  }
}

test("setup visibility scope switch discards the Linear draft before configuring machine defaults", async () => {
  await withRepository(async (primary, root) => {
    const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config") }; let sessions = 0;
    const handler = createSetupHandler({ inspectTarget: (global, cwd) => inspectSetupTarget(global, cwd, env),
      prompt: () => scripted(["linear", "replace", "DISCARDED_DRAFT", false, "save", "global", "save"]), checkExecutable: async () => true,
      linear: () => { sessions++; return createLinearSetupSession(env); },
      save: async (target, source, approved, signal) => {
        if (target.scope === "repository") throw new SetupVisibilityError("choose machine defaults");
        await saveSetupConfig(target, source, approved, signal);
      },
    });
    await handler({ global: false }, { cwd: primary, interactive: true, io: { stdout() {}, stderr() {} } });
    expect(sessions).toBe(2); expect(await loadSavedLinearKey(env)).toBeNull();
  });
});
