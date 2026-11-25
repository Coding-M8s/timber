import type { CommandIO } from "../services";
import { safeDisplay } from "../display";
import { readBitbucketCredentialStore, validBitbucketLogin, withBitbucketCredentialSave } from "../bitbucket/credentials";
import type { BitbucketCredentialStore } from "../bitbucket/credentials";
import { SetupCancelled } from "./types";
import type { SetupPrompt } from "./types";

export interface BitbucketSetupSession {
  edit(prompt: SetupPrompt, io: CommandIO): Promise<void>;
  review(io: CommandIO): void;
  save(publishConfig: () => Promise<void>, signal?: AbortSignal): Promise<void>;
}

const validEmail = (email: string) => validBitbucketLogin({ email, token: "x" });

/** The login timber pr uses for bitbucket.org; draft credentials are published only when the whole setup is saved. */
export function createBitbucketSetupSession(env: NodeJS.ProcessEnv = process.env): BitbucketSetupSession {
  let store: BitbucketCredentialStore | undefined;
  return {
    async edit(prompt, io) {
      store ??= await readBitbucketCredentialStore(env, prompt.signal);
      io.stdout(`Personal credentials: ${safeDisplay(store.path)}\n`);
      io.stdout(process.platform === "win32"
        ? "Plaintext storage limited by Windows ACLs to your account, SYSTEM and Administrators, shared across repositories. Changes apply on Save.\n"
        : "Personal plaintext, owner-only storage shared across repositories. Changes apply on Save.\n");
      io.stdout("timber pr uses this login to open pull requests on bitbucket.org. Create an API token with scopes under Atlassian account settings > Security: https://id.atlassian.com/manage-profile/security/api-tokens\nChoose Bitbucket and the scopes read:pullrequest:bitbucket and write:pullrequest:bitbucket. Add read:workspace:bitbucket and read:user:bitbucket to let apps suggest reviewers. Pushing still uses your Git login.\n");
      if (env.BITBUCKET_EMAIL !== undefined || env.BITBUCKET_API_TOKEN !== undefined) {
        io.stdout("BITBUCKET_EMAIL and BITBUCKET_API_TOKEN override the saved login at runtime; an incomplete or invalid pair fails without fallback. Unset them to use the saved login.\n");
      }
      const login = store.get();
      const choices = [
        { value: "keep", label: login ? `Keep saved login for ${safeDisplay(login.email)} (token hidden)` : "None" },
        { value: "replace", label: login ? "Replace Bitbucket login" : "Enter Bitbucket login" },
        ...(login ? [{ value: "remove", label: "Remove saved Bitbucket login (shared across repositories)" }] : []),
      ];
      const choice = await prompt.select("Bitbucket pull request login", choices, "keep");
      if (choice === null) throw new SetupCancelled();
      if (!choices.some(value => value.value === choice)) throw new Error("Invalid Bitbucket login choice; no settings saved.");
      if (choice === "remove") { store.set(null); return; }
      if (choice !== "replace") return;
      let email: string;
      while (true) {
        const entered = await prompt.text("Atlassian account email", login?.email ?? "");
        if (entered === null) throw new SetupCancelled();
        if (validEmail(entered.trim())) { email = entered.trim(); break; }
        io.stderr("Enter the email address of your Atlassian account. Credentials were not saved.\n");
      }
      while (true) {
        if (!prompt.secret) throw new Error("Hidden token input is unavailable; use an interactive terminal with timber setup.");
        const token = await prompt.secret("Bitbucket API token (hidden, including pasted input)");
        if (token === null) throw new SetupCancelled();
        if (validBitbucketLogin({ email, token })) { store.set({ email, token }); return; }
        io.stderr("Enter a nonblank API token without whitespace or control characters. Credentials were not saved.\n");
      }
    },
    review(io) {
      if (!store || !store.changes().length) return;
      for (const change of store.changes()) io.stdout(`Bitbucket personal login: ${change.action === "save" ? "save/replace" : "remove"} (token hidden); shared across repositories.\n`);
      io.stdout(`Personal credential destination: ${safeDisplay(store.path)} (plaintext; private storage).\n`);
    },
    async save(publishConfig, signal) {
      if (store) await withBitbucketCredentialSave(store, publishConfig, signal);
      else await publishConfig();
    },
  };
}
