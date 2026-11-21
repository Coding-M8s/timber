import { execa } from "execa";

const fullHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const shortHash = /^[0-9a-f]{7,63}$/iu;

/** A full SHA-1 or SHA-256 object name; the only commit form a base accepts. */
export function isFullCommitHash(input: string): boolean {
  return fullHash.test(input);
}

/**
 * Hex-only input of 7 or more characters that is not a full hash. Unless a branch has exactly
 * that name, it is refused rather than resolved as a commit.
 */
export function isAbbreviatedCommitHash(input: string): boolean {
  return shortHash.test(input) && !fullHash.test(input);
}

function abbreviatedHashError(flag: string): Error {
  return new Error(`Abbreviated commit hashes are not accepted as a base; give the full commit hash with ${flag}.`);
}

/**
 * Verify offline that `input` is a full hash naming an existing commit object in this repository,
 * and return it in lowercase. Tags and other objects are refused, never peeled.
 */
export async function verifyCommitBase(cwd: string, input: string, flag: string): Promise<string> {
  if (!isFullCommitHash(input)) throw abbreviatedHashError(flag);
  const hash = input.toLowerCase();
  let commit: string | null = null;
  try {
    const result = await execa("git", ["rev-parse", "--verify", "--quiet", `${hash}^{commit}`], {
      cwd, reject: false, stdin: "ignore", env: { GIT_OPTIONAL_LOCKS: "0" },
    });
    if (result.exitCode === 0) commit = result.stdout.trim();
  } catch {
    throw new Error("Could not run Git to verify the commit base.");
  }
  if (commit !== hash) {
    throw new Error(`Commit ${hash} is not a commit in this repository; give the full hash of an existing commit with ${flag}.`);
  }
  return hash;
}

/** True when an existing local or remote-tracking branch is named exactly `input`. */
async function namesBranch(cwd: string, input: string): Promise<boolean> {
  try {
    const result = await execa("git", ["for-each-ref", "--count=1", "--format=%(refname)", `refs/heads/${input}`, `refs/remotes/*/${input}`], {
      cwd, reject: false, stdin: "ignore", env: { GIT_OPTIONAL_LOCKS: "0" },
    });
    return result.exitCode === 0 && result.stdout.trim() !== "";
  } catch {
    return false;
  }
}

/** Refuse a short hex input as an abbreviated hash unless a branch already has exactly that name. */
export async function refuseAbbreviatedHash(cwd: string, input: string, flag: string): Promise<void> {
  if (isAbbreviatedCommitHash(input) && !await namesBranch(cwd, input)) throw abbreviatedHashError(flag);
}
