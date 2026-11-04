import { execa } from "execa";

interface AuthRuntime {
  env: NodeJS.ProcessEnv;
  run?: (args: readonly string[], signal: AbortSignal, env: NodeJS.ProcessEnv) => Promise<string>;
}

function validToken(value: string): boolean {
  return value.length > 0 && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function githubEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, GH_DEBUG: undefined, DEBUG: undefined, GH_PROMPT_DISABLED: "1",
    GH_HOST: "github.com", GH_PAGER: "", PAGER: "", GH_ACCESSIBLE_PROMPTER: "0" };
}

export async function readGithubToken(signal: AbortSignal, runtime: AuthRuntime = { env: process.env }): Promise<string> {
  const { env } = runtime;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN"] as const) {
    if (env[key] !== undefined) {
      if (!validToken(env[key])) throw new Error(`${key} must be a nonblank token without whitespace; unset it to use GitHub CLI login.`);
      return env[key];
    }
  }
  try {
    signal.throwIfAborted();
    const run = runtime.run ?? (async (args, cancelSignal, childEnv) => (await execa("gh", [...args], {
      env: childEnv, stdin: "ignore", cancelSignal, forceKillAfterDelay: 250,
      timeout: 10_000, maxBuffer: 16_384,
    })).stdout);
    const token = (await run(["auth", "token", "--hostname", "github.com"], signal, githubEnvironment(env))).replace(/\r?\n$/u, "");
    signal.throwIfAborted();
    if (!validToken(token)) throw new Error("Invalid credential output.");
    return token;
  } catch {
    throw new Error("GitHub CLI login is unavailable. Install gh and run timber setup to check or sign in to github.com.");
  }
}
