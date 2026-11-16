import type { CommandIO } from "../services";
import { safeDisplay } from "../display";
import { checkLinearConnection } from "../linear/client";
import { readLinearCredentialStore, validLinearKey, withLinearCredentialSave } from "../linear/credentials";
import type { LinearCredentialStore } from "../linear/credentials";
import { SetupCancelled } from "./types";
import { repositoryCredentialKey } from "../credential-selection";
import { chooseEntryAction, chooseNewLabel, confirmRemoval, severalEntriesNotice } from "./credential-entries";
import type { EntryMenu } from "./credential-entries";
import type { SetupPrompt } from "./types";

export interface LinearSetupSession {
  edit(prompt: SetupPrompt, io: CommandIO): Promise<void>;
  review(io: CommandIO): void;
  save(publishConfig: () => Promise<void>, signal?: AbortSignal): Promise<void>;
}
type ConnectionCheck = (key: string, signal?: AbortSignal) => Promise<unknown>;
const defaultCheck: ConnectionCheck = (key, signal) => checkLinearConnection({
  token: async () => key, fetch: (url, init) => fetch(url, init), timeoutMs: 10_000,
}, signal);

/** Draft credentials are published only when the whole setup is saved. */
/** `commonGitDir` is the repository whose selection setup may change; null in machine-default setup. */
export function createLinearSetupSession(env: NodeJS.ProcessEnv = process.env, check: ConnectionCheck = defaultCheck,
  commonGitDir: string | null = null): LinearSetupSession {
  let store: LinearCredentialStore | undefined;
  let current: string | null = null;
  return {
    async edit(prompt, io) {
      store ??= await readLinearCredentialStore(env, prompt.signal);
      io.stdout(`Personal credentials: ${safeDisplay(store.path)}\n`);
      io.stdout(process.platform === "win32"
        ? "Plaintext storage limited by Windows ACLs to your account, SYSTEM and Administrators, shared across repositories. Changes apply on Save.\n"
        : "Personal plaintext, owner-only storage shared across repositories. Changes apply on Save.\n");
      io.stdout("Create a personal API key under Account > Security & Access: https://linear.app/docs/api-and-webhooks\nUse Read permission and allow the teams whose issues you need. Write permission is needed only for timber new --assign.\n");
      if (env.LINEAR_API_KEY !== undefined) {
        io.stdout("LINEAR_API_KEY overrides the saved key at runtime; a blank or invalid override fails without fallback. Unset it to use saved credentials. This check uses the draft key.\n");
      }
      const repository = commonGitDir === null ? null : await repositoryCredentialKey(commonGitDir);
      current = repository;
      const labels = store.labels();
      const menu: EntryMenu = {
        title: "Linear personal login", noun: "personal API key", labels,
        describe: label => `"${label}"`, repository,
        association: repository === null ? null : store.association(repository),
        users: label => store!.users(label),
        single: { keep: "Keep saved personal key (hidden)", enter: "Enter personal API key",
          replace: "Replace personal API key", remove: "Remove saved Linear key (shared across repositories)" },
      };
      const action = await chooseEntryAction(prompt, menu);
      let key: string | null = null;
      if (action.kind === "forget") { store.associate(repository!, null); return; }
      if (action.kind === "remove") {
        if (!await confirmRemoval(prompt, menu, action.label)) return;
        store.set(null, action.label);
        if (store.labels().length === 1) io.stdout(`The remaining saved key "${store.labels()[0]}" is now used by every repository.\n`);
        return;
      }
      if (action.kind === "use") { store.associate(repository!, action.label); key = store.get(action.label); }
      if (action.kind === "keep") {
        const selection = store.select(repository);
        if (selection.kind === "selected") key = store.get(selection.label);
      }
      if (action.kind === "add" || action.kind === "replace") {
        const label = action.kind === "add" ? await chooseNewLabel(prompt, io, labels) : action.label;
        while (true) {
          if (!prompt.secret) throw new Error("Hidden token input is unavailable; use an interactive terminal with timber setup.");
          const entered = await prompt.secret("Linear personal API key (hidden, including pasted input)");
          if (entered === null) throw new SetupCancelled();
          if (!validLinearKey(entered)) {
            io.stderr("Enter a nonblank personal API key without whitespace or control characters. Credentials were not saved.\n");
            continue;
          }
          key = entered; store.set(key, label); break;
        }
        if (action.kind === "add" && labels.length) {
          io.stdout(severalEntriesNotice("Linear", "personal API key"));
          if (repository !== null) {
            const use = await prompt.confirm(`Use "${label}" for this repository?`, true);
            if (use === null) throw new SetupCancelled();
            if (use) store.associate(repository, label);
            else if (menu.association === null && labels.length === 1) store.associate(repository, labels[0]!);
          }
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
      for (const change of store.changes()) {
        if (change.kind === "entry") io.stdout(`Linear personal credentials: ${change.action === "save" ? "save/replace" : "remove"} "${change.label}" (key hidden); shared across repositories.\n`);
        else io.stdout(`Linear repository selection: ${change.label === null ? "clear" : `use "${change.label}"`} for ${change.repository === current ? "this repository" : safeDisplay(change.repository)}.\n`);
      }
      io.stdout(`Personal credential destination: ${safeDisplay(store.path)} (plaintext; private storage).\n`);
    },
    async save(publishConfig, signal) {
      if (store) await withLinearCredentialSave(store, publishConfig, signal);
      else await publishConfig();
    },
  };
}
