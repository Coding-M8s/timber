import type { CommandIO } from "../services";
import { safeDisplay } from "../display";
import { checkLinearConnection } from "../linear/client";
import { readLinearCredentialStore, validLinearKey, withLinearCredentialSave } from "../linear/credentials";
import type { LinearCredentialStore } from "../linear/credentials";
import { SetupCancelled } from "./types";
import type { SetupPrompt } from "./types";

export interface LinearSetupSession {
  edit(prompt: SetupPrompt, io: CommandIO): Promise<void>;
  review(io: CommandIO): void;
  save(publishConfig: () => Promise<void>, signal?: AbortSignal): Promise<void>;
}
type ConnectionCheck = (key: string, signal?: AbortSignal) => Promise<void>;
const defaultCheck: ConnectionCheck = (key, signal) => checkLinearConnection({
  token: async () => key, fetch: (url, init) => fetch(url, init), timeoutMs: 10_000,
}, signal);

/** Draft credentials are published only when the whole setup is saved. */
export function createLinearSetupSession(env: NodeJS.ProcessEnv = process.env, check: ConnectionCheck = defaultCheck): LinearSetupSession {
  let store: LinearCredentialStore | undefined;
  return {
    async edit(prompt, io) {
      store ??= await readLinearCredentialStore(env, prompt.signal);
      io.stdout(`Personal credentials: ${safeDisplay(store.path)}\n`);
      io.stdout(process.platform === "win32"
        ? "Plaintext storage limited by Windows ACLs to your account, SYSTEM and Administrators, shared across repositories. Changes apply on Save.\n"
        : "Personal plaintext, owner-only storage shared across repositories. Changes apply on Save.\n");
      io.stdout("Create a personal API key under Account > Security & Access: https://linear.app/docs/api-and-webhooks\nUse Read permission and allow the teams whose issues you need. No write permission is required.\n");
      if (env.LINEAR_API_KEY !== undefined) {
        io.stdout("LINEAR_API_KEY overrides the saved key at runtime; a blank or invalid override fails without fallback. Unset it to use saved credentials. This check uses the draft key.\n");
      }
      let key = store.get();
      const choices = [
        { value: "keep", label: key ? "Keep saved personal key (hidden)" : "None" },
        { value: "replace", label: key ? "Replace personal API key" : "Enter personal API key" },
        ...(key ? [{ value: "remove", label: "Remove saved Linear key (shared across repositories)" }] : []),
      ];
      const choice = await prompt.select("Linear personal login", choices, "keep");
      if (choice === null) throw new SetupCancelled();
      if (!choices.some(value => value.value === choice)) throw new Error("Invalid Linear credentials choice; no settings saved.");
      if (choice === "remove") { store.set(null); return; }
      if (choice === "replace") {
        while (true) {
          if (!prompt.secret) throw new Error("Hidden token input is unavailable; use an interactive terminal with timber setup.");
          const entered = await prompt.secret("Linear personal API key (hidden, including pasted input)");
          if (entered === null) throw new SetupCancelled();
          if (!validLinearKey(entered)) {
            io.stderr("Enter a nonblank personal API key without whitespace or control characters. Credentials were not saved.\n");
            continue;
          }
          key = entered; store.set(key); break;
        }
      }
      if (!key) return;
      const checking = await prompt.confirm("Check this draft login with Linear now? No settings will be saved.", false);
      if (checking === null) throw new SetupCancelled();
      if (checking) {
        try {
          await check(key, prompt.signal);
          if (prompt.signal?.aborted) throw new SetupCancelled();
          io.stdout("Linear authentication succeeded; team and issue access was not checked.\n");
        } catch (error) {
          if (error instanceof SetupCancelled || prompt.signal?.aborted
            || (error instanceof Error && error.name === "AbortError")) throw new SetupCancelled();
          io.stderr("Linear connection check failed. Check connectivity, personal API key Read permission and team access. Select Linear to correct the draft or cancel setup; this check saved nothing.\n");
        }
      }
    },
    review(io) {
      if (!store || !store.changes().length) return;
      for (const change of store.changes()) io.stdout(`Linear personal credentials: ${change.action === "save" ? "save/replace" : "remove"} (key hidden); shared across repositories.\n`);
      io.stdout(`Personal credential destination: ${safeDisplay(store.path)} (plaintext; private storage).\n`);
    },
    async save(publishConfig, signal) {
      if (store) await withLinearCredentialSave(store, publishConfig, signal);
      else await publishConfig();
    },
  };
}
