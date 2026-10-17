import { execa } from "execa";
import type {
  Branch, GitReadOptions, RemoteBranch, RepositoryConfig, RepositoryContext, Resolution, ValidatedBase,
} from "../types";

type RefRow = { ref: string; symbolic: string; upstream: string };

async function git(
  repository: RepositoryContext, args: readonly string[], action: string, options?: GitReadOptions & { unattended?: boolean },
): Promise<string> {
  let result;
  try {
    result = await execa("git", [...args], {
      cwd: repository.primaryWorktreeRoot, reject: false, env: { GIT_OPTIONAL_LOCKS: "0", ...(options?.unattended ? { GIT_TERMINAL_PROMPT: "0" } : {}) },
      ...(options?.unattended ? { stdin: "ignore" as const, timeout: 10_000 } : {}),
      ...(options?.signal === undefined ? {} : { cancelSignal: options.signal, forceKillAfterDelay: 250 }),
    });
  } catch {
    throw new Error(`Could not ${action}: Git is unavailable.`);
  }
  if (result.exitCode !== 0) throw new Error(`Could not ${action} with Git.`);
  return result.stdout;
}

async function refs(repository: RepositoryContext, options?: GitReadOptions): Promise<readonly RefRow[]> {
  const output = await git(repository, [
    "for-each-ref", "--format=%(refname)%00%(symref)%00%(upstream)", "refs/heads", "refs/remotes",
  ], "read branches", options);
  if (!output) return [];
  return output.split("\n").filter(Boolean).map(line => {
    const [ref, symbolic, upstream] = line.split("\0");
    if (ref === undefined || symbolic === undefined || upstream === undefined) {
      throw new Error("Could not parse Git branch refs.");
    }
    return { ref, symbolic, upstream };
  });
}

function remoteFromRef(repository: RepositoryContext, ref: string): RemoteBranch | null {
  const prefix = "refs/remotes/";
  if (!ref.startsWith(prefix)) return null;
  const tail = ref.slice(prefix.length);
  const remote = [...repository.remotes].sort((a, b) => b.name.length - a.name.length)
    .find(value => tail.startsWith(`${value.name}/`));
  if (!remote) return null;
  const name = tail.slice(remote.name.length + 1);
  if (!name || name === "HEAD") return null;
  return { kind: "remote", remote: remote.name, name, ref };
}

function branchRows(repository: RepositoryContext, rows: readonly RefRow[]): Branch[] {
  return rows.flatMap<Branch>(row => {
    if (row.symbolic) return [];
    if (row.ref.startsWith("refs/heads/")) {
      const upstream = row.upstream ? remoteFromRef(repository, row.upstream) : null;
      return [{ kind: "local" as const, name: row.ref.slice("refs/heads/".length), ref: row.ref, upstream }];
    }
    const remote = remoteFromRef(repository, row.ref);
    return remote ? [remote] : [];
  });
}

/** Read local and remote-tracking branches without fetching or selecting one. */
export async function listBranches(repository: RepositoryContext, options?: GitReadOptions): Promise<readonly Branch[]> {
  return branchRows(repository, await refs(repository, options));
}

export interface LiveRemoteHead { branch: RemoteBranch; commit: string }

/** Read advertised remote heads without fetching objects or changing any refs. */
export async function listLiveRemoteHeads(
  repository: RepositoryContext, input: string, config: RepositoryConfig,
): Promise<readonly LiveRemoteHead[]> {
  const explicit = [...repository.remotes].sort((a, b) => b.name.length - a.name.length)
    .find(remote => input.startsWith(`${remote.name}/`));
  const selected = explicit?.name ?? config.remote;
  if (selected !== null && !repository.remotes.some(remote => remote.name === selected)) {
    throw new Error("Configured remote does not exist in this repository.");
  }
  const heads: LiveRemoteHead[] = [];
  for (const remote of repository.remotes.filter(remote => selected === null || remote.name === selected)) {
    let result;
    try {
      result = await execa("git", ["ls-remote", "--heads", "--", remote.name], {
        cwd: repository.primaryWorktreeRoot, reject: false, timeout: 10_000,
        env: { GIT_TERMINAL_PROMPT: "0" }, stdin: "ignore",
      });
    } catch {
      throw new Error("Could not check existing remote branches; no workspace was created.");
    }
    if (result.exitCode !== 0) throw new Error("Could not check existing remote branches; no workspace was created.");
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const match = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/(.+)$/u.exec(line);
      if (!match) throw new Error("Could not parse remote branches; no workspace was created.");
      const name = match[2]!;
      heads.push({commit: match[1]!, branch: { kind: "remote", remote: remote.name, name, ref: `refs/remotes/${remote.name}/${name}` }});
    }
  }
  return heads;
}

/** Compatibility view for ordinary open; arena also needs each advertised commit. */
export async function listLiveRemoteBranches(repository: RepositoryContext, input: string, config: RepositoryConfig): Promise<readonly RemoteBranch[]> {
  return (await listLiveRemoteHeads(repository, input, config)).map(head => head.branch);
}

function result(candidates: readonly Branch[]): Resolution<Branch> {
  if (candidates.length === 0) return { kind: "not-found" };
  if (candidates.length === 1) return { kind: "found", value: candidates[0]! };
  return { kind: "ambiguous", candidates: [...candidates].sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0) };
}

const ticketId = /^[A-Z][A-Z0-9]*-\d+$/;
const delimiters = new Set(["-", "_", ".", "/"]);

function ticketMatch(name: string, input: string): boolean {
  return ticketId.test(input) && name.startsWith(input) && delimiters.has(name[input.length] ?? "");
}

/** Read local and remote-tracking refs; no network call or branch mutation. */
export async function resolveBranch(
  repository: RepositoryContext, input: string, config: RepositoryConfig,
  availableBranches?: readonly Branch[],
): Promise<Resolution<Branch>> {
  if (config.remote !== null && !repository.remotes.some(remote => remote.name === config.remote)) {
    throw new Error(`Configured remote ${config.remote} does not exist in this repository.`);
  }
  if (!input) return { kind: "not-found" };
  const branches = availableBranches ?? await listBranches(repository);
  const local = branches.filter((branch): branch is Extract<Branch, { kind: "local" }> => branch.kind === "local");
  const remote = branches.filter((branch): branch is RemoteBranch => branch.kind === "remote");
  const explicit = [...repository.remotes].sort((a, b) => b.name.length - a.name.length)
    .find(value => input.startsWith(`${value.name}/`));
  const exactLocal = explicit ? undefined : local.find(branch => branch.name === input);
  if (exactLocal) return { kind: "found", value: exactLocal };
  const remoteName = explicit?.name ?? (config.remote ?? (repository.remotes.length === 1 ? repository.remotes[0]!.name : null));
  const name = explicit ? input.slice(explicit.name.length + 1) : input;
  const eligibleRemote = remote.filter(branch => remoteName === null || branch.remote === remoteName);
  const exactRemote = eligibleRemote.filter(branch => branch.name === name);
  if (exactRemote.length) return result(exactRemote);

  const matchingLocal = explicit ? [] : local.filter(branch => ticketMatch(branch.name, name));
  const matchingRemote = eligibleRemote.filter(branch => ticketMatch(branch.name, name));
  return result([...matchingLocal, ...matchingRemote]);
}

/** Check a proposed branch name with installed Git before TIM-3 creates it. */
export async function validateNewBranchName(repository: RepositoryContext, name: string): Promise<void> {
  // `check-ref-format --branch` has no `--` terminator. Reject option-shaped
  // names before passing a single literal argument to Git.
  if (!name || name.startsWith("-")) throw new Error(`Invalid branch name: ${name}`);
  try {
    const checked = await git(repository, ["check-ref-format", "--branch", name], "validate branch name");
    if (checked !== name) throw new Error("Git expanded branch shorthand.");
  } catch {
    throw new Error(`Invalid branch name: ${name}`);
  }
}

/** TIM-3 calls this again immediately before creating from a remote ref. */
export async function refreshRemoteBranch(repository: RepositoryContext, branch: RemoteBranch, options: { unattended?: boolean } = {}): Promise<RemoteBranch> {
  const knownRemote = repository.remotes.some(remote => remote.name === branch.remote);
  const expectedRef = `refs/remotes/${branch.remote}/${branch.name}`;
  if (!knownRemote || branch.ref !== expectedRef) {
    throw new Error(`Cannot refresh remote branch ${branch.remote}/${branch.name}: invalid remote ref.`);
  }
  await validateNewBranchName(repository, branch.name);
  try {
    await git(repository, [
      "fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--refmap=", "--", branch.remote,
      `+refs/heads/${branch.name}:${branch.ref}`,
    ], "refresh remote branch", options);
    await git(repository, ["rev-parse", "--verify", "--quiet", `${branch.ref}^{commit}`], "verify remote branch");
  } catch {
    throw new Error(`Could not refresh remote branch ${branch.remote}/${branch.name}. Check remote availability and branch existence.`);
  }
  return branch;
}

async function validatedBase(
  repository: RepositoryContext, ref: string, source: ValidatedBase["source"],
): Promise<ValidatedBase> {
  let commit: string;
  try {
    commit = await git(repository, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], "verify base branch");
  } catch {
    throw new Error(`Base branch ${ref} does not point to an existing commit.`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`Base branch ${ref} does not point to an existing commit.`);
  return { ref, commit, source };
}

function exactBaseRef(repository: RepositoryContext, branches: readonly Branch[], input: string, selectedRemote: string | null): string | null {
  const byRef = branches.find(branch => branch.ref === input);
  if (byRef) return byRef.ref;
  const explicit = [...repository.remotes].sort((a, b) => b.name.length - a.name.length)
    .find(remote => input.startsWith(`${remote.name}/`));
  if (explicit) {
    return branches.find(branch => branch.kind === "remote" && branch.remote === explicit.name
      && branch.name === input.slice(explicit.name.length + 1))?.ref ?? null;
  }
  const local = branches.find(branch => branch.kind === "local" && branch.name === input);
  if (local) return local.ref;
  const matches = branches.filter(branch => branch.kind === "remote" && branch.name === input
    && (selectedRemote === null || branch.remote === selectedRemote));
  return matches.length === 1 ? matches[0]!.ref : null;
}

/** Select exactly one existing branch and pin its current commit. */
export async function resolveBase(
  repository: RepositoryContext, config: RepositoryConfig, explicitBase?: string,
): Promise<ValidatedBase> {
  if (config.remote !== null && !repository.remotes.some(remote => remote.name === config.remote)) {
    throw new Error(`Configured remote ${config.remote} does not exist in this repository.`);
  }
  const branches = branchRows(repository, await refs(repository));
  const selectedRemote = config.remote ?? (repository.remotes.length === 1 ? repository.remotes[0]!.name : null);
  if (explicitBase !== undefined || config.baseBranch !== null) {
    const input = explicitBase ?? config.baseBranch!;
    const source = explicitBase !== undefined ? "explicit" : "config";
    const ref = exactBaseRef(repository, branches, input, selectedRemote);
    if (!ref) throw new Error(`Base branch ${input} is missing or ambiguous. Select an exact branch.`);
    return validatedBase(repository, ref, source);
  }

  const remote = repository.remotes.find(candidate => candidate.name === selectedRemote);
  if (remote?.defaultBranchRef) {
    return validatedBase(repository, remote.defaultBranchRef, "remote-default");
  }

  const fallbacks = branches.filter(branch => branch.kind === "local" && (branch.name === "main" || branch.name === "master"));
  if (fallbacks.length !== 1) {
    throw new Error(fallbacks.length ? "Base branch is ambiguous: both main and master exist." : "Could not find a base branch. Use --base or configure base_branch.");
  }
  return validatedBase(repository, fallbacks[0]!.ref, "fallback");
}
