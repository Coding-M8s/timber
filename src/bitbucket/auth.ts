import { loadSavedBitbucketLogin, validBitbucketLogin } from "./credentials";
import type { BitbucketLogin } from "./credentials";

/**
 * The Bitbucket login, never prompted for. A supplied BITBUCKET_EMAIL or
 * BITBUCKET_API_TOKEN must form a complete valid pair and wins over the saved
 * login; otherwise the pair saved by timber setup is used.
 */
export async function readBitbucketLogin(env: NodeJS.ProcessEnv = process.env,
  saved: (env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<BitbucketLogin | null> = loadSavedBitbucketLogin,
  signal?: AbortSignal): Promise<BitbucketLogin> {
  signal?.throwIfAborted();
  if (env.BITBUCKET_EMAIL !== undefined || env.BITBUCKET_API_TOKEN !== undefined) {
    const login = { email: env.BITBUCKET_EMAIL ?? "", token: env.BITBUCKET_API_TOKEN ?? "" };
    if (!validBitbucketLogin(login)) {
      throw new Error("BITBUCKET_EMAIL and BITBUCKET_API_TOKEN must both be set, to an Atlassian account email and a nonblank API token without whitespace. No saved login was used.");
    }
    return login;
  }
  const login = await saved(env, signal);
  signal?.throwIfAborted();
  if (login === null) {
    throw new Error("Bitbucket login is missing. Run timber setup to save an Atlassian email and Bitbucket API token, or supply BITBUCKET_EMAIL and BITBUCKET_API_TOKEN.");
  }
  if (!validBitbucketLogin(login)) throw new Error("Invalid saved Bitbucket login. Run timber setup to replace it.");
  return login;
}
