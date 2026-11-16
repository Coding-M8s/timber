import { repositoryCredentialKey } from "../credential-selection";
import { loadSavedLinearKey, validLinearKey } from "./credentials";

/**
 * `commonGitDir` identifies the repository whose saved-key association applies;
 * without one, only a sole saved key can be used.
 */
export async function readLinearKey(env: NodeJS.ProcessEnv = process.env,
  saved: (env: NodeJS.ProcessEnv, signal?: AbortSignal, repository?: string | null) => Promise<string | null> = loadSavedLinearKey,
  signal?: AbortSignal, commonGitDir?: string): Promise<string> {
  signal?.throwIfAborted();
  if (env.LINEAR_API_KEY !== undefined) {
    if (!validLinearKey(env.LINEAR_API_KEY)) throw new Error("Invalid LINEAR_API_KEY; supply a nonblank personal API key without whitespace or control characters. No saved-key fallback was used.");
    return env.LINEAR_API_KEY;
  }
  const repository = commonGitDir === undefined ? null : await repositoryCredentialKey(commonGitDir);
  signal?.throwIfAborted();
  const key = await saved(env, signal, repository);
  signal?.throwIfAborted();
  if (key === null) throw new Error("Linear credentials are missing. Run timber setup to save a personal API key, or supply LINEAR_API_KEY.");
  if (!validLinearKey(key)) throw new Error("Invalid saved Linear personal API key. Run timber setup to replace it.");
  return key;
}
