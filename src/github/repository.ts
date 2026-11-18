import { execa } from "execa";
import { jsonDisplay } from "../display";
import type { RepositoryConfig, RepositoryContext } from "../types";

export interface GithubRepository { owner: string; name: string }
const invalid = () => new Error("Selected issue remote must identify one github.com repository. Check its fetch URL or select --remote <name>.");

export function parseGithubRemoteUrl(input: string): GithubRepository {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)$/u.exec(input);
  if (!match) throw invalid();
  const name = match[2]!.replace(/\.git$/u, "");
  if (!name || name === "." || name === "..") throw invalid();
  return { owner: match[1]!, name };
}

export type RemoteReader = (cwd: string, args: string[]) => Promise<readonly string[]>;
export const readRemote: RemoteReader = async (cwd, args) => {
  try {
    const result = await execa("git", args, { cwd, stdin: "ignore", timeout: 10_000,
      maxBuffer: 16_384, env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
    return result.stdout.split(/\r?\n/u);
  } catch { throw invalid(); }
};

export async function resolveGithubRepository(repository: RepositoryContext, config: RepositoryConfig,
  remote?: string, read: RemoteReader = readRemote): Promise<GithubRepository> {
  const name = remote ?? config.remote ?? (repository.remotes.some(value => value.name === "origin") ? "origin" : null);
  if (!name || !repository.remotes.some(value => value.name === name)) {
    throw new Error("No valid GitHub issue remote selected. Configure remote or pass --remote <name>.");
  }
  return readGithubRemote(repository, name, read);
}

/** The github.com repository a named remote fetches from; throws unless it has exactly one such URL. */
export async function readGithubRemote(repository: RepositoryContext, name: string,
  read: RemoteReader = readRemote): Promise<GithubRepository> {
  const urls = await read(repository.currentWorktreeRoot, ["remote", "get-url", "--all", "--", name]);
  if (urls.length !== 1) throw invalid();
  return parseGithubRemoteUrl(urls[0]!);
}

/**
 * The github.com repository behind one named remote. Read-only; the message
 * names the remote's role so it fits any command. With push, read the URL Git
 * pushes to, which pushurl or pushInsteadOf can point at another repository.
 */
export async function githubRepositoryOfRemote(repository: RepositoryContext, remote: string, role: string,
  push = false, read: RemoteReader = readRemote): Promise<GithubRepository> {
  const unusable = () => new Error(`The ${role} remote ${jsonDisplay(remote)} does not identify one github.com repository; Timber creates pull requests only on github.com.`);
  if (!repository.remotes.some(value => value.name === remote)) throw unusable();
  let urls: readonly string[];
  try { urls = await read(repository.currentWorktreeRoot, ["remote", "get-url", ...(push ? ["--push"] : []), "--all", "--", remote]); }
  catch { throw unusable(); }
  if (urls.length !== 1) throw unusable();
  try { return parseGithubRemoteUrl(urls[0]!); } catch { throw unusable(); }
}
