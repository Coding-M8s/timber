import { execa } from "execa";
import type { RepositoryContext, ValidatedBase } from "../types";
import { gitCommand } from "../platform/git-command";

/** Refresh only the selected cleanup base, without following refs into local branches. */
export async function refreshCleanupBase(
  repository: RepositoryContext, base: ValidatedBase | null,
): Promise<ValidatedBase | null> {
  if (base?.source === "remote-default" && !base.ref.startsWith("refs/remotes/")) {
    throw new Error("Cannot refresh the selected remote cleanup base: its default ref resolves to a local branch. Repair the remote default ref and retry; the worktree and branch are retained.");
  }
  if (base === null || !base.ref.startsWith("refs/remotes/")) return base;
  const remote = [...repository.remotes].sort((a, b) => b.name.length - a.name.length)
    .find(candidate => base.ref.startsWith(`refs/remotes/${candidate.name}/`));
  if (!remote) throw new Error("Cannot refresh the selected remote cleanup base: unknown remote.");
  const name = base.ref.slice(`refs/remotes/${remote.name}/`.length);
  const remoteRef = `refs/heads/${name}`;
  const run = (args: readonly string[]) => execa(gitCommand(), [...args], {
    cwd: repository.primaryWorktreeRoot, reject: false, stdin: "ignore", timeout: 10_000,
    env: {
      GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "false", SSH_ASKPASS: "false", GCM_INTERACTIVE: "Never",
    },
  });
  try {
    const checked = await run(["check-ref-format", remoteRef]);
    const symbolic = await run(["symbolic-ref", "--quiet", base.ref]);
    if (checked.exitCode !== 0 || symbolic.exitCode !== 1) throw new Error("Invalid or symbolic base ref.");
    const advertised = await run(["ls-remote", "--exit-code", "--refs", "--", remote.name, remoteRef]);
    const lines = advertised.stdout.split("\n").filter(Boolean);
    const [commit, ref] = (lines[0] ?? "").split("\t");
    if (advertised.exitCode !== 0 || lines.length !== 1 || ref !== remoteRef ||
        !commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error("Unverified remote base.");
    const fetched = await run([
      "fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--no-recurse-submodules", "--refmap=",
      "--", remote.name, remoteRef,
    ]);
    if (fetched.exitCode !== 0) throw new Error("Fetch failed.");
    const head = await run(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    if (head.exitCode !== 0 || head.stdout !== commit) throw new Error("Remote base moved during fetch.");
    // No destination ref in fetch; conditionally update only this tracking ref.
    // --no-deref prevents even a concurrent symbolic ref from redirecting the write.
    const updated = await run(["update-ref", "--no-deref", base.ref, commit, base.commit]);
    if (updated.exitCode !== 0) throw new Error("Cached base changed during fetch.");
    const direct = await run(["symbolic-ref", "--quiet", base.ref]);
    if (direct.exitCode !== 1) throw new Error("Cached base is no longer a direct ref.");
    return { ...base, commit };
  } catch {
    throw new Error("Could not refresh the selected remote cleanup base. Check branch existence, authentication and network access, then retry. No cached fallback was used; the worktree and local branch are retained.");
  }
}
