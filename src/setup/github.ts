import { execa } from "execa";
import { checkExecutable } from "./executable";
import { checkGithubConnection } from "../github/client";
import { githubEnvironment } from "../github/auth";
import type { CommandIO } from "../services";
import { SetupCancelled } from "./types";
import type { SetupPrompt } from "./types";

export interface GithubSetupSession { edit(prompt: SetupPrompt, io: CommandIO): Promise<void> }
interface GithubSetupRuntime {
  env: NodeJS.ProcessEnv;
  available: () => Promise<boolean>;
  check: () => Promise<string>;
  login: () => Promise<boolean>;
}

async function login(): Promise<boolean> {
  try {
    const result = await execa("gh", ["auth", "login", "--hostname", "github.com"], {
      stdio: "inherit", reject: false,
      env: { ...githubEnvironment(process.env), GH_PROMPT_DISABLED: undefined },
    });
    if (result.signal || result.exitCode === 130) throw new SetupCancelled();
    return result.exitCode === 0;
  } catch (error) {
    if (error instanceof SetupCancelled) throw error;
    return false;
  }
}

export function createGithubSetupSession(runtime: GithubSetupRuntime = {
  env: process.env, available: () => checkExecutable("gh"), check: () => checkGithubConnection(), login,
}): GithubSetupSession {
  return {
    async edit(prompt, io) {
      io.stdout("GitHub issues use GitHub CLI authentication for github.com. Timber does not store GitHub tokens.\n");
      if (!await runtime.available()) {
        io.stderr("Install GitHub CLI from https://cli.github.com/ and return to timber setup.\n");
        return;
      }
      const check = async (): Promise<boolean> => {
        try {
          const account = await runtime.check();
          if (prompt.signal?.aborted) throw new SetupCancelled();
          io.stdout(`GitHub authenticated as ${account}. Repository and issue access was not checked.\n`);
          return true;
        } catch (error) {
          if (error instanceof SetupCancelled || prompt.signal?.aborted) throw new SetupCancelled();
          io.stderr("GitHub login check failed. Check connectivity, your active github.com account and token permissions.\n");
          return false;
        }
      };
      if (await check()) return;
      if (runtime.env.GH_TOKEN !== undefined || runtime.env.GITHUB_TOKEN !== undefined) {
        io.stderr("GH_TOKEN overrides GITHUB_TOKEN, then saved gh login. Unset environment overrides before signing in to a saved account.\n");
        return;
      }
      io.stdout("Sign in with gh auth login. GitHub CLI manages this login immediately. Cancelling Timber setup afterward does not undo it.\n");
      const confirmed = await prompt.confirm("Run gh auth login for github.com now?", false);
      if (confirmed === null) throw new SetupCancelled();
      if (!confirmed) return;
      if (!prompt.withTerminal) {
        io.stderr("Interactive login handoff is unavailable. Run gh auth login --hostname github.com, then return to setup.\n");
        return;
      }
      const succeeded = await prompt.withTerminal(runtime.login);
      if (prompt.signal?.aborted) throw new SetupCancelled();
      if (!succeeded) { io.stderr("GitHub login did not complete. Select GitHub again to retry or cancel setup.\n"); return; }
      await check();
    },
  };
}
