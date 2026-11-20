/** A bitbucket.org repository: owner is the workspace ID, name the repository slug. */
export interface BitbucketRepository { owner: string; name: string }

/**
 * Accepts the bitbucket.org clone URL forms, including the HTTPS form with a
 * username that Bitbucket shows by default, and the ssh. and altssh. SSH hosts
 * (altssh on port 443). A URL carrying a password is refused.
 */
export function parseBitbucketRemoteUrl(input: string): BitbucketRepository | null {
  const match = /^(?:https:\/\/(?:[A-Za-z0-9_.-]+@)?bitbucket\.org\/|ssh:\/\/git@(?:(?:ssh\.)?bitbucket\.org|altssh\.bitbucket\.org:443)\/|git@(?:ssh\.)?bitbucket\.org:)([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/u.exec(input);
  if (!match) return null;
  const name = match[2]!.replace(/\.git$/u, "");
  if (!name || name === "." || name === "..") return null;
  return { owner: match[1]!, name };
}
