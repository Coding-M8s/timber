import { execa } from "execa";
import {
  listBranches,
  listLiveRemoteHeads,
  resolveBase,
  refreshRemoteBranch,
} from "../git/branches";
import type { LiveRemoteHead } from "../git/branches";
import type {
  Branch,
  RepositoryConfig,
  RepositoryContext,
  Resolution,
  ValidatedBase,
} from "../types";
import type { ArenaSourceProvenance, ArenaSourceSelection } from "./types";
import { validateArenaName } from "./participants";
import { gitCommand } from "../platform/git-command";

export function arenaIdentity(
  input: string,
  override?: string,
): { name: string; ticket?: string } {
  const ticket = /^[A-Z][A-Z0-9]*-[0-9]+$/u.test(input) ? input : undefined;
  const name = override ?? (ticket ? ticket.toLowerCase() : input);
  validateArenaName(name);
  return { name, ...(ticket === undefined ? {} : { ticket }) };
}
function ticketMatch(branch: string, ticket: string): boolean {
  return branch
    .split("/")
    .some(
      (segment) =>
        segment === ticket ||
        (segment.startsWith(ticket) &&
          /[-_.]/u.test(segment[ticket.length] ?? "")),
    );
}
function resolution(
  candidates: readonly ArenaSourceSelection[],
): Resolution<ArenaSourceSelection> {
  if (!candidates.length) return { kind: "not-found" };
  if (candidates.length === 1) return { kind: "found", value: candidates[0]! };
  return {
    kind: "ambiguous",
    candidates: [...candidates].sort((a, b) =>
      a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0,
    ),
  };
}
/** Source discovery never fetches, creates worktrees, or requires a source checkout. */
export async function resolveArenaSource(
  repository: RepositoryContext,
  config: RepositoryConfig,
  input: { base?: string; ticket?: string },
): Promise<Resolution<ArenaSourceSelection>> {
  if (
    config.remote !== null &&
    !repository.remotes.some((r) => r.name === config.remote)
  )
    throw new Error("Configured remote does not exist in this repository.");
  const branches = await listBranches(repository);
  const cachedNames = branches
    .filter((b) => b.kind === "remote")
    .map((b) => b.name);
  const heads: LiveRemoteHead[] = [];
  const discoveredRemotes = new Set<string>();
  const live = async (selector = "") => {
    const explicit = [...repository.remotes]
      .sort((a, b) => b.name.length - a.name.length)
      .find((r) => selector.startsWith(r.name + "/"));
    const selected = explicit?.name ?? config.remote;
    const remotes = repository.remotes.filter(
      (r) => selected === null || r.name === selected,
    );
    for (const remote of remotes) {
      if (discoveredRemotes.has(remote.name)) continue;
      heads.push(
        ...(await listLiveRemoteHeads(repository, remote.name + "/", config)),
      );
      discoveredRemotes.add(remote.name);
    }
    return heads.filter((h) => remotes.some((r) => r.name === h.branch.remote));
  };
  const known = () => [
    ...new Set([...cachedNames, ...heads.map((h) => h.branch.name)]),
  ];
  const local = async (
    branch: Extract<Branch, { kind: "local" }>,
    provenance: ArenaSourceProvenance,
    missing = false,
  ): Promise<ArenaSourceSelection> => ({
    kind: "local",
    selector: branch.ref,
    base: await resolveBase(repository, config, branch.ref),
    provenance,
    knownRemoteBranches: known(),
    ticketBranchMissing: missing,
  });
  const remote = (
    head: LiveRemoteHead,
    provenance: ArenaSourceProvenance,
    missing = false,
  ): ArenaSourceSelection => ({
    kind: "remote",
    selector: head.branch.ref,
    branch: head.branch,
    advertisedCommit: head.commit,
    provenance,
    knownRemoteBranches: known(),
    ticketBranchMissing: missing,
  });
  const exact = async (
    selector: string,
    provenance: ArenaSourceProvenance,
    missing = false,
  ): Promise<Resolution<ArenaSourceSelection>> => {
    const remoteTail = selector.startsWith("refs/remotes/")
      ? selector.slice("refs/remotes/".length)
      : selector;
    const explicit = [...repository.remotes]
      .sort((a, b) => b.name.length - a.name.length)
      .find((r) => remoteTail.startsWith(r.name + "/"));
    if (!explicit) {
      const found = branches.find(
        (b): b is Extract<Branch, { kind: "local" }> =>
          b.kind === "local" && (b.ref === selector || b.name === selector),
      );
      if (found)
        return {
          kind: "found",
          value: await local(found, provenance, missing),
        };
      if (selector.startsWith("refs/heads/"))
        throw new Error(
          "Selected arena base branch is missing; no workspaces were created.",
        );
    }
    const advertised = await live(explicit ? remoteTail : "");
    const name = explicit
      ? remoteTail.slice(explicit.name.length + 1)
      : selector;
    const matches = advertised.filter(
      (h) =>
        h.branch.name === name &&
        (!explicit || h.branch.remote === explicit.name),
    );
    if (!matches.length)
      throw new Error(
        "Selected arena base branch is missing; choose an existing local or remote branch.",
      );
    return resolution(matches.map((h) => remote(h, provenance, missing)));
  };
  if (input.base !== undefined) return exact(input.base, "explicit");
  if (input.ticket) {
    const locals = branches.filter(
      (b): b is Extract<Branch, { kind: "local" }> =>
        b.kind === "local" && ticketMatch(b.name, input.ticket!),
    );
    if (locals.length)
      return resolution(
        await Promise.all(locals.map((b) => local(b, "ticket"))),
      );
    const advertised = await live();
    const matching = advertised.filter((h) =>
      ticketMatch(h.branch.name, input.ticket!),
    );
    if (matching.length)
      return resolution(matching.map((h) => remote(h, "ticket")));
  }
  const missing = input.ticket !== undefined;
  if (config.baseBranch !== null)
    return exact(config.baseBranch, "config", missing);
  const selected =
    config.remote ??
    (repository.remotes.length === 1 ? repository.remotes[0]!.name : null);
  if (selected !== null) {
    const remoteConfig = repository.remotes.find((r) => r.name === selected)!;
    const advertised = await live(selected + "/");
    let name = remoteConfig.defaultBranchRef?.slice(
      `refs/remotes/${selected}/`.length,
    );
    if (!name) {
      let result;
      try {
        result = await execa(
          gitCommand(),
          ["ls-remote", "--symref", "--", selected, "HEAD"],
          {
            cwd: repository.primaryWorktreeRoot,
            reject: false,
            timeout: 10000,
            stdin: "ignore",
            env: { GIT_TERMINAL_PROMPT: "0" },
          },
        );
      } catch {
        throw new Error(
          "Could not discover remote default branch; no workspace was created.",
        );
      }
      if (result.exitCode !== 0)
        throw new Error(
          "Could not discover remote default branch; no workspace was created.",
        );
      name = /^ref: refs\/heads\/(.+)\tHEAD$/mu.exec(result.stdout)?.[1];
    }
    if (name) {
      const head = advertised.find(
        (h) => h.branch.remote === selected && h.branch.name === name,
      );
      if (!head)
        throw new Error(
          "Selected remote default branch is missing; use --base.",
        );
      return { kind: "found", value: remote(head, "remote-default", missing) };
    }
  }
  const base = await resolveBase(repository, config);
  const branch = branches.find(
    (b): b is Extract<Branch, { kind: "local" }> =>
      b.kind === "local" && b.ref === base.ref,
  );
  if (!branch)
    throw new Error("Cannot resolve local fallback base; use --base.");
  return {
    kind: "found",
    value: {
      kind: "local",
      selector: base.ref,
      base,
      provenance: "fallback",
      knownRemoteBranches: known(),
      ticketBranchMissing: missing,
    },
  };
}

/** Call only after review/confirmation. Refresh changes cached refs, never a source checkout. */
export async function finalizeArenaSource(
  repository: RepositoryContext,
  config: RepositoryConfig,
  source: ArenaSourceSelection,
): Promise<ValidatedBase> {
  const origin =
    source.provenance === "ticket" ? "explicit" : source.provenance;
  if (source.kind === "local") return { ...source.base, source: origin };
  try {
    await refreshRemoteBranch(repository, source.branch, { unattended: true });
    const base = await resolveBase(repository, config, source.branch.ref);
    if (base.commit !== source.advertisedCommit) throw new Error("moved");
    return { ...base, source: origin };
  } catch {
    throw new Error(
      "Remote source refresh failed or its commit changed after review. Cached refs may have been refreshed; no arena worktrees were created. Rerun and review the current remote source.",
    );
  }
}
