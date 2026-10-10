import { expect, test } from "bun:test";
import { appendFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { cleanupWorktree, inspectCleanup } from "../src/git/cleanup";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import type { CleanupOptions, RepositoryConfig, Worktree } from "../src/types";
import type { CommandServices } from "../src/services";
import { git, withRepository } from "./helpers/git";

const config = (baseBranch: string | null = "trunk"): RepositoryConfig => ({
  baseBranch, remote: null, worktreeDir: null, editor: null, agent: null,
});
const noDiscard: CleanupOptions = { keepBranch: false, discardIgnored: false };
const keepBranch: CleanupOptions = { keepBranch: true, discardIgnored: false };
const cleanupServices: Pick<CommandServices, "inspectCleanup" | "cleanupWorktree"> = { inspectCleanup, cleanupWorktree };
void cleanupServices;

async function addTarget(primary: string, path: string, branch: string, detached = false): Promise<void> {
  if (detached) await git(primary, "worktree", "add", "--detach", path, "HEAD");
  else await git(primary, "worktree", "add", "-b", branch, path);
}

async function selectedTree(primary: string, path: string): Promise<Worktree> {
  const repository = await discoverRepository(primary);
  const tree = (await listWorktrees(repository)).find(candidate => candidate.path === path);
  if (!tree) throw new Error("fixture worktree was not listed by Git");
  return tree;
}

async function refs(primary: string): Promise<string> {
  return git(primary, "for-each-ref", "--format=%(refname)%00%(objectname)");
}

async function isAbsent(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

async function branchOid(primary: string, branch: string): Promise<string | null> {
  const result = await execa("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { cwd: primary, reject: false });
  return result.exitCode === 0 ? result.stdout : null;
}

async function assertRegistered(primary: string, path: string, present: boolean): Promise<void> {
  const repository = await discoverRepository(primary);
  expect((await listWorktrees(repository)).some(tree => tree.path === path)).toBe(present);
}

async function assertRetained(primary: string, path: string, branch: string, oid: string, refsBefore: string): Promise<void> {
  expect(await isAbsent(path)).toBe(false);
  expect(await branchOid(primary, branch)).toBe(oid);
  expect(await refs(primary)).toBe(refsBefore);
  await assertRegistered(primary, path, true);
}

async function commitFile(path: string, name: string, body: string, message: string): Promise<string> {
  await writeFile(join(path, name), body);
  await git(path, "add", "--", name);
  await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(path, "rev-parse", "HEAD");
}

async function configureBareUpstream(
  primary: string, directory: string, path: string, branch: string, remote = "backup",
): Promise<string> {
  const bare = join(directory, `${remote}.git`);
  await git(directory, "init", "--bare", bare);
  await git(primary, "remote", "add", remote, bare);
  await git(path, "push", "--set-upstream", remote, branch);
  return bare;
}

async function cleanup(primary: string, path: string, options: CleanupOptions = noDiscard) {
  const repository = await discoverRepository(primary);
  return cleanupWorktree(repository, await selectedTree(primary, path), config(), options);
}

test("default cleanup removes only a merged linked worktree and local branch", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "manual linked\nwith spaces");
    const unrelatedPath = join(directory, "unrelated linked");
    await addTarget(primary, path, "feature/remove-me");
    await addTarget(primary, unrelatedPath, "feature/leave-me");
    const remote = await configureBareUpstream(primary, directory, path, "feature/remove-me", "mirror");
    const targetOid = await branchOid(primary, "feature/remove-me");
    const unrelatedOid = await branchOid(primary, "feature/leave-me");
    const primaryBefore = await readFile(join(primary, "tracked.txt"), "utf8");
    const unrelatedBefore = await readFile(join(unrelatedPath, "tracked.txt"), "utf8");
    const remoteBefore = await git(remote, "rev-parse", "refs/heads/feature/remove-me");

    const result = await cleanup(primary, path);

    expect(result).toEqual({
      removedWorktreePath: path,
      deletedLocalBranch: "feature/remove-me",
      retainedLocalBranch: null,
    });
    expect(await isAbsent(path)).toBe(true);
    expect(await branchOid(primary, "feature/remove-me")).toBeNull();
    expect(await branchOid(primary, "feature/leave-me")).toBe(unrelatedOid);
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe(primaryBefore);
    expect(await readFile(join(unrelatedPath, "tracked.txt"), "utf8")).toBe(unrelatedBefore);
    expect(await git(remote, "rev-parse", "refs/heads/feature/remove-me")).toBe(remoteBefore);
    await assertRegistered(primary, path, false);
    await assertRegistered(primary, unrelatedPath, true);
    expect(targetOid).not.toBeNull();
  });
});

test("keepBranch removes a clean merged worktree and retains its local branch OID", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "keep branch linked");
    await addTarget(primary, path, "feature/keep");
    const before = await branchOid(primary, "feature/keep");
    const result = await cleanup(primary, path, keepBranch);
    expect(result).toEqual({
      removedWorktreePath: path,
      deletedLocalBranch: null,
      retainedLocalBranch: "feature/keep",
    });
    expect(await isAbsent(path)).toBe(true);
    expect(await branchOid(primary, "feature/keep")).toBe(before);
    await assertRegistered(primary, path, false);
  });
});

test("staged and unstaged changes, renames, deletions, and untracked files are preserved", async () => {
  await withRepository(async (primary, directory) => {
    const scenarios = ["staged", "unstaged", "rename", "deleted", "untracked", "untracked-directory"] as const;
    for (const scenario of scenarios) {
      const path = join(directory, `dirty ${scenario}`);
      const branch = `feature/dirty-${scenario}`;
      await addTarget(primary, path, branch);
      if (scenario === "staged") {
        await writeFile(join(path, "tracked.txt"), "staged change\n");
        await git(path, "add", "tracked.txt");
      } else if (scenario === "unstaged") {
        await writeFile(join(path, "tracked.txt"), "unstaged change\n");
      } else if (scenario === "rename") {
        await git(path, "mv", "old name.txt", "renamed name.txt");
      } else if (scenario === "deleted") {
        await rm(join(path, "tracked.txt"));
      } else if (scenario === "untracked") {
        await writeFile(join(path, "new\nfile.txt"), "keep newline name\n");
      } else {
        await mkdir(join(path, "untracked directory"));
        await writeFile(join(path, "untracked directory", "nested.txt"), "keep nested\n");
      }
      const refsBefore = await refs(primary);
      const oid = (await branchOid(primary, branch))!;
      const snapshot = scenario === "rename"
        ? [await readFile(join(path, "renamed name.txt"), "utf8")]
        : scenario === "deleted" ? []
          : scenario === "untracked" ? [await readFile(join(path, "new\nfile.txt"), "utf8")]
            : scenario === "untracked-directory" ? [await readFile(join(path, "untracked directory", "nested.txt"), "utf8")]
              : [await readFile(join(path, "tracked.txt"), "utf8")];

      await expect(cleanup(primary, path, { keepBranch: true, discardIgnored: true }))
        .rejects.toThrow(/modified|untracked|dirty/i);

      await assertRetained(primary, path, branch, oid, refsBefore);
      if (scenario === "rename") expect(await isAbsent(join(path, "renamed name.txt"))).toBe(false);
      else if (scenario === "deleted") expect(await isAbsent(join(path, "tracked.txt"))).toBe(true);
      else if (scenario === "untracked") expect(await readFile(join(path, "new\nfile.txt"), "utf8")).toBe(snapshot[0]!);
      else if (scenario === "untracked-directory") expect(await readFile(join(path, "untracked directory", "nested.txt"), "utf8")).toBe(snapshot[0]!);
      else expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe(snapshot[0]!);
    }
  });
});

test("ignored files and directories require discardIgnored and are removed only with that option", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "ignored linked");
    await addTarget(primary, path, "feature/ignored");
    await appendFile(join(primary, ".git", "info", "exclude"), "cache/\n");
    await mkdir(join(path, "cache"));
    await writeFile(join(path, ".env"), "keep secret file bytes\n");
    await writeFile(join(path, "cache", "ignored.txt"), "keep cache bytes\n");
    const refsBefore = await refs(primary);
    const oid = (await branchOid(primary, "feature/ignored"))!;
    await expect(cleanup(primary, path)).rejects.toThrow(/ignored|\.env|keep-ignored/i);
    await assertRetained(primary, path, "feature/ignored", oid, refsBefore);
    expect(await readFile(join(path, ".env"), "utf8")).toBe("keep secret file bytes\n");
    expect(await readFile(join(path, "cache", "ignored.txt"), "utf8")).toBe("keep cache bytes\n");

    const result = await cleanup(primary, path, { keepBranch: false, discardIgnored: true });
    expect(result.deletedLocalBranch).toBe("feature/ignored");
    expect(result.retainedLocalBranch).toBeNull();
    expect(await isAbsent(path)).toBe(true);
    expect(await branchOid(primary, "feature/ignored")).toBeNull();
  });
});

test("ignored content never conceals dirty or untracked work", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "ignored and dirty linked");
    await addTarget(primary, path, "feature/ignored-dirty");
    await writeFile(join(path, ".env"), "ignored bytes\n");
    await writeFile(join(path, "tracked.txt"), "modified bytes\n");
    await writeFile(join(path, "untracked.txt"), "untracked bytes\n");
    const refsBefore = await refs(primary);
    const oid = (await branchOid(primary, "feature/ignored-dirty"))!;
    await expect(cleanup(primary, path, { keepBranch: true, discardIgnored: true }))
      .rejects.toThrow(/modified|untracked|dirty/i);
    await assertRetained(primary, path, "feature/ignored-dirty", oid, refsBefore);
    expect(await readFile(join(path, ".env"), "utf8")).toBe("ignored bytes\n");
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("modified bytes\n");
    expect(await readFile(join(path, "untracked.txt"), "utf8")).toBe("untracked bytes\n");
  });
});

test("dirty submodule content refuses cleanup even when ignored discard is enabled", async () => {
  await withRepository(async (primary, directory) => {
    const source = join(directory, "submodule source");
    await mkdir(source);
    await git(source, "init", "-b", "main");
    await writeFile(join(source, "module.txt"), "module baseline\n");
    await git(source, "add", ".");
    await git(source, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "submodule baseline");
    await git(primary, "-c", "protocol.file.allow=always", "submodule", "add", source, "vendor/module");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-am", "add submodule");
    const path = join(directory, "dirty submodule linked");
    await addTarget(primary, path, "feature/submodule");
    await git(path, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
    await writeFile(join(path, "vendor/module", "module.txt"), "dirty module bytes\n");
    const refsBefore = await refs(primary);
    const oid = (await branchOid(primary, "feature/submodule"))!;
    await expect(cleanup(primary, path, { keepBranch: true, discardIgnored: true }))
      .rejects.toThrow(/modified|untracked|dirty/i);
    await assertRetained(primary, path, "feature/submodule", oid, refsBefore);
    expect(await readFile(join(path, "vendor/module", "module.txt"), "utf8")).toBe("dirty module bytes\n");
  });
});

test.each([false, true])("unmerged published review cleanup keeps the remote and honors keepBranch=%s", async keep => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "published feature linked");
    await addTarget(primary, path, "feature/published");
    const remote = await configureBareUpstream(primary, directory, path, "feature/published", "release");
    await commitFile(path, "published.txt", "published commit\n", "published feature commit");
    await git(path, "push", "release", "feature/published");
    const localOid = (await branchOid(primary, "feature/published"))!;
    const remoteOid = await git(remote, "rev-parse", "refs/heads/feature/published");
    const result = await cleanup(primary, path, { keepBranch: keep, discardIgnored: false });
    expect(result).toEqual({
      removedWorktreePath: path,
      deletedLocalBranch: keep ? null : "feature/published",
      retainedLocalBranch: keep ? "feature/published" : null,
    });
    expect(await isAbsent(path)).toBe(true);
    expect(await branchOid(primary, "feature/published")).toBe(keep ? localOid : null);
    expect(await git(remote, "rev-parse", "refs/heads/feature/published")).toBe(remoteOid);
  });
});

test.each([false, true])("unpublished or unknown unmerged work stays intact with keepBranch=%s", async keep => {
  await withRepository(async (primary, directory) => {
    for (const kind of ["no-upstream", "ahead"] as const) {
      const path = join(directory, `${kind} unmerged linked`);
      const branch = `feature/${kind}`;
      await addTarget(primary, path, branch);
      if (kind === "ahead") {
        await configureBareUpstream(primary, directory, path, branch, "ahead-remote");
        await commitFile(path, "ahead.txt", "unpublished bytes\n", "unpublished local commit");
      } else {
        await commitFile(path, "local.txt", "unpublished bytes\n", "local only commit");
      }
      const oid = (await branchOid(primary, branch))!;
      const refsBefore = await refs(primary);
      await expect(cleanup(primary, path, { keepBranch: keep, discardIgnored: true }))
        .rejects.toThrow(/publication|upstream|unpublished|base|ancestry/i);
      await assertRetained(primary, path, branch, oid, refsBefore);
      expect(await readFile(join(path, kind === "ahead" ? "ahead.txt" : "local.txt"), "utf8")).toBe("unpublished bytes\n");
    }
  });
});

test("cleanup refuses when the validated base is the target branch with unique commits", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "self base linked");
    await addTarget(primary, path, "feature/as-base");
    const unique = await commitFile(path, "unique.txt", "only on this tip\n", "unique unpublished tip");
    const repository = await discoverRepository(primary);
    const selection = await selectedTree(primary, path);
    const refsBefore = await refs(primary);
    const selfBase = config("feature/as-base");

    const inspection = await inspectCleanup(repository, selection, selfBase);
    expect(inspection.ancestry.kind).toBe("unknown");
    if (inspection.ancestry.kind !== "unknown") throw new Error("expected self-base ancestry to stay unknown");
    expect(inspection.ancestry.reason).toMatch(/validated base|target branch/i);

    await expect(cleanupWorktree(repository, selection, selfBase, noDiscard))
      .rejects.toThrow(/base|ancestry|validated base|publication|upstream/i);
    await assertRetained(primary, path, "feature/as-base", unique, refsBefore);
    expect(await readFile(join(path, "unique.txt"), "utf8")).toBe("only on this tip\n");
    expect(await branchOid(primary, "feature/as-base")).toBe(unique);
  });
});

test("base containment permits clean removal when publication is unknown", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "offline merged linked");
    await addTarget(primary, path, "feature/offline-merged");
    const bare = await configureBareUpstream(primary, directory, path, "feature/offline-merged", "offline");
    await git(primary, "remote", "set-url", "offline", join(directory, "unavailable.git"));
    const localOid = (await branchOid(primary, "feature/offline-merged"))!;
    const remoteOid = await git(bare, "rev-parse", "refs/heads/feature/offline-merged");
    const result = await cleanup(primary, path);
    expect(result.deletedLocalBranch).toBe("feature/offline-merged");
    expect(result.retainedLocalBranch).toBeNull();
    expect(await branchOid(primary, "feature/offline-merged")).toBeNull();
    expect(await git(bare, "rev-parse", "refs/heads/feature/offline-merged")).toBe(remoteOid);
    expect(await isAbsent(path)).toBe(true);
    expect(localOid).toBe(remoteOid);
  });
});

test("a published branch selected as the validated base remains protected from deletion", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "published base linked");
    const branch = "feature/published-base";
    await addTarget(primary, path, branch);
    const oid = await commitFile(path, "review.txt", "published base work\n", "review work");
    const remote = await configureBareUpstream(primary, directory, path, branch, "review");
    const repository = await discoverRepository(primary);
    const selection = await selectedTree(primary, path);
    const before = await refs(primary);
    await expect(cleanupWorktree(repository, selection, config(branch), noDiscard)).rejects.toThrow(/validated base/);
    await assertRetained(primary, path, branch, oid, before);
    expect(await git(remote, "rev-parse", `refs/heads/${branch}`)).toBe(oid);
  });
});

test("unmerged work with unavailable publication cannot be removed", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "offline unmerged linked");
    await addTarget(primary, path, "feature/offline-unmerged");
    const bare = await configureBareUpstream(primary, directory, path, "feature/offline-unmerged", "offline-unmerged");
    const localCommit = await commitFile(path, "local-only.txt", "retain me\n", "local-only commit");
    await git(primary, "remote", "set-url", "offline-unmerged", join(directory, "unavailable.git"));
    const refsBefore = await refs(primary);
    const remoteOid = await git(bare, "rev-parse", "refs/heads/feature/offline-unmerged");
    await expect(cleanup(primary, path, keepBranch)).rejects.toThrow(/publication|upstream|base|ancestry/i);
    await assertRetained(primary, path, "feature/offline-unmerged", localCommit, refsBefore);
    expect(await git(bare, "rev-parse", "refs/heads/feature/offline-unmerged")).toBe(remoteOid);
    expect(await readFile(join(path, "local-only.txt"), "utf8")).toBe("retain me\n");
  });
});

test("squash-equivalent base commit permits branch deletion without proving ancestry", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "squash linked");
    await addTarget(primary, path, "feature/squash");
    const bare = await configureBareUpstream(primary, directory, path, "feature/squash", "squash-remote");
    const featureCommit = await commitFile(path, "same content.txt", "same patch\n", "feature commit");
    await git(path, "push", "squash-remote", "feature/squash");
    await commitFile(primary, "same content.txt", "same patch\n", "squash merge on base");
    expect(await git(primary, "merge-base", "--is-ancestor", featureCommit, "refs/heads/trunk").then(() => true, () => false)).toBe(false);
    const result = await cleanup(primary, path);
    expect(result.deletedLocalBranch).toBe("feature/squash");
    expect(result.retainedLocalBranch).toBeNull();
    expect(await isAbsent(path)).toBe(true);
    expect(await branchOid(primary, "feature/squash")).toBeNull();
    expect(await git(bare, "rev-parse", "refs/heads/feature/squash")).toBe(featureCommit);
  });
});

test("locked, primary, missing, unregistered, and replaced targets are refused", async () => {
  await withRepository(async (primary, directory) => {
    const lockedPath = join(directory, "locked linked");
    await addTarget(primary, lockedPath, "feature/locked");
    await git(primary, "worktree", "lock", "--reason", "test lock", lockedPath);
    const lockedOid = (await branchOid(primary, "feature/locked"))!;
    const lockedRefs = await refs(primary);
    await expect(cleanup(primary, lockedPath, { keepBranch: true, discardIgnored: true })).rejects.toThrow(/locked/i);
    await assertRetained(primary, lockedPath, "feature/locked", lockedOid, lockedRefs);

    const repository = await discoverRepository(primary);
    const primaryTree = (await listWorktrees(repository)).find(tree => tree.isPrimary)!;
    const forgedPrimary = { ...primaryTree, isPrimary: false };
    await expect(cleanupWorktree(repository, forgedPrimary, config(), { keepBranch: true, discardIgnored: true }))
      .rejects.toThrow(/primary/i);

    const absentPath = join(directory, "missing linked");
    await addTarget(primary, absentPath, "feature/missing");
    const absentTree = await selectedTree(primary, absentPath);
    const absentOid = (await branchOid(primary, "feature/missing"))!;
    const refsWithAbsent = await refs(primary);
    await rm(absentPath, { recursive: true, force: true });
    await expect(cleanupWorktree(repository, absentTree, config(), noDiscard)).rejects.toThrow(/missing|prunable|stale/i);
    expect(await branchOid(primary, "feature/missing")).toBe(absentOid);
    expect(await refs(primary)).toBe(refsWithAbsent);

    const foreign = join(directory, "foreign repo");
    await mkdir(foreign);
    await git(foreign, "init", "-b", "trunk");
    await writeFile(join(foreign, "safe.txt"), "foreign bytes\n");
    await git(foreign, "add", ".");
    await git(foreign, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "foreign");
    const foreignRefs = await refs(foreign);
    const foreignTree = { ...absentTree, path: foreign, branch: "feature/missing" };
    await expect(cleanupWorktree(repository, foreignTree, config(), noDiscard)).rejects.toThrow(/registered|worktree/i);
    expect(await refs(foreign)).toBe(foreignRefs);
    expect(await readFile(join(foreign, "safe.txt"), "utf8")).toBe("foreign bytes\n");

    const replacedPath = join(directory, "replaced linked");
    await addTarget(primary, replacedPath, "feature/replaced");
    const replacedTree = await selectedTree(primary, replacedPath);
    const replacedOid = (await branchOid(primary, "feature/replaced"))!;
    await rm(replacedPath, { recursive: true, force: true });
    await mkdir(replacedPath);
    await git(replacedPath, "init", "-b", "main");
    await writeFile(join(replacedPath, "safe.txt"), "replacement bytes\n");
    await git(replacedPath, "add", ".");
    await git(replacedPath, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "replacement");
    const replacementRefs = await refs(replacedPath);
    await expect(cleanupWorktree(repository, replacedTree, config(), { keepBranch: true, discardIgnored: true }))
      .rejects.toThrow(/prunable|identity|metadata|stale/i);
    expect(await refs(replacedPath)).toBe(replacementRefs);
    expect(await readFile(join(replacedPath, "safe.txt"), "utf8")).toBe("replacement bytes\n");
    expect(await branchOid(primary, "feature/replaced")).toBe(replacedOid);
  });
});

test("detached contained HEAD can be removed while an uncontained detached commit is retained", async () => {
  await withRepository(async (primary, directory) => {
    const containedPath = join(directory, "detached contained");
    await addTarget(primary, containedPath, "unused", true);
    const contained = await cleanup(primary, containedPath);
    expect(contained).toEqual({
      removedWorktreePath: containedPath,
      deletedLocalBranch: null,
      retainedLocalBranch: null,
    });
    expect(await isAbsent(containedPath)).toBe(true);

    const uncontainedPath = join(directory, "detached uncontained");
    await addTarget(primary, uncontainedPath, "unused", true);
    await commitFile(uncontainedPath, "detached-only.txt", "keep detached commit\n", "uncontained detached commit");
    const oid = await git(uncontainedPath, "rev-parse", "HEAD");
    const refsBefore = await refs(primary);
    await expect(cleanup(primary, uncontainedPath, keepBranch)).rejects.toThrow(/publication|upstream|base|ancestry/i);
    expect(await isAbsent(uncontainedPath)).toBe(false);
    expect(await git(uncontainedPath, "rev-parse", "HEAD")).toBe(oid);
    expect(await refs(primary)).toBe(refsBefore);
    await assertRegistered(primary, uncontainedPath, true);
  });
});

test("unknown worktree status blocks removal", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "unknown status linked");
    await addTarget(primary, path, "feature/unknown-status");
    const index = await git(path, "rev-parse", "--path-format=absolute", "--git-path", "index");
    const originalIndex = await readFile(index);
    await writeFile(index, "not a valid git index\n");
    const refsBefore = await refs(primary);
    const oid = (await branchOid(primary, "feature/unknown-status"))!;
    await expect(cleanup(primary, path, { keepBranch: true, discardIgnored: true })).rejects.toThrow(/status|verify|unknown/i);
    await assertRetained(primary, path, "feature/unknown-status", oid, refsBefore);
    expect(await readFile(index, "utf8")).toBe("not a valid git index\n");
    await writeFile(index, originalIndex);
  });
});
