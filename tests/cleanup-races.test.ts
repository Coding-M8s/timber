import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { cleanupWorktree, inspectCleanup } from "../src/git/cleanup";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import type { CleanupOptions, RepositoryConfig, RepositoryContext, Worktree } from "../src/types";
import { git, withRepository } from "./helpers/git";

const config = (baseBranch: string | null = "trunk"): RepositoryConfig => ({
  baseBranch, remote: null, worktreeDir: null, editor: null, agent: null,
});
const noDiscard: CleanupOptions = { keepBranch: false, discardIgnored: false };
const keepBranch: CleanupOptions = { keepBranch: true, discardIgnored: false };
const runnerPath = fileURLToPath(new URL("./fixtures/cleanup-runner.ts", import.meta.url));

const wrapperSource = [
  "#!/bin/sh",
  'if [ "$1" = ls-remote ] && [ ! -e "$TIMBER_RACE_MARKER" ]; then',
  '  case "$TIMBER_RACE_ACTION" in',
  '    add-ignored) printf "race ignored bytes\\n" > "$TIMBER_RACE_TARGET/.env" ;;',
  '    lock-target) "$TIMBER_REAL_GIT" worktree lock --reason race "$TIMBER_RACE_TARGET" ;;',
  '    advance-target) "$TIMBER_REAL_GIT" -C "$TIMBER_RACE_TARGET" -c user.name="Timber Test" -c user.email=test@example.invalid commit --allow-empty -m race ;;',
  '    rewind-base) "$TIMBER_REAL_GIT" update-ref refs/heads/trunk "$TIMBER_RACE_BASE_OID" ;;',
  '    rewrite-remote-during-final-status) ;;',
  '  esac',
  '  case "$TIMBER_RACE_ACTION" in',
  '    add-ignored|lock-target|advance-target|rewind-base|rewrite-remote-during-final-status) : > "$TIMBER_RACE_MARKER" ;;',
  '  esac',
  'fi',
  'case " $* " in',
  '  *" status "*)',
  '    if [ "$TIMBER_RACE_ACTION" = rewrite-remote-during-final-status ] && [ -e "$TIMBER_RACE_MARKER" ] && [ ! -e "$TIMBER_RACE_STATUS_MARKER" ]; then',
  '      "$TIMBER_REAL_GIT" -C "$TIMBER_RACE_REMOTE" update-ref "refs/heads/$TIMBER_RACE_REMOTE_BRANCH" "$TIMBER_RACE_REMOTE_OID"',
  '      : > "$TIMBER_RACE_STATUS_MARKER"',
  '    fi ;;',
  'esac',
  'if [ "$1" = worktree ] && [ "$2" = remove ]; then',
  '  case "$TIMBER_RACE_ACTION" in',
  '    rewrite-remote-after-remove|delete-remote-after-remove)',
  '      "$TIMBER_REAL_GIT" "$@"',
  '      remove_status=$?',
  '      if [ "$remove_status" -eq 0 ]; then',
  '        if [ "$TIMBER_RACE_ACTION" = rewrite-remote-after-remove ]; then',
  '          "$TIMBER_REAL_GIT" -C "$TIMBER_RACE_REMOTE" update-ref "refs/heads/$TIMBER_RACE_REMOTE_BRANCH" "$TIMBER_RACE_REMOTE_OID"',
  '        else',
  '          "$TIMBER_REAL_GIT" -C "$TIMBER_RACE_REMOTE" update-ref -d "refs/heads/$TIMBER_RACE_REMOTE_BRANCH"',
  '        fi',
  '      fi',
  '      exit "$remove_status" ;;',
  '    fail-remove-before) printf "RAW_WRAPPER_DIAGNOSTIC\\n" >&2; exit 17 ;;',
  '    fail-remove-after) "$TIMBER_REAL_GIT" "$@"; exit 17 ;;',
  '    dirty-at-remove) printf "raced untracked bytes\\n" > "$TIMBER_RACE_TARGET/raced.txt"; exec "$TIMBER_REAL_GIT" "$@" ;;',
  '    add-worktree-after-remove)',
  '      "$TIMBER_REAL_GIT" "$@"',
  '      remove_status=$?',
  '      if [ "$remove_status" -eq 0 ]; then "$TIMBER_REAL_GIT" worktree add "$TIMBER_RACE_NEW_PATH" "$TIMBER_RACE_BRANCH"; fi',
  '      exit "$remove_status" ;;',
  '  esac',
  'fi',
  'if [ "$1" = update-ref ] && [ "$2" = --no-deref ] && [ "$3" = -d ]; then',
  '  case "$TIMBER_RACE_ACTION" in',
  '    fail-ref-delete) printf "RAW_WRAPPER_DIAGNOSTIC\\n" >&2; exit 19 ;;',
  '    checkout-before-delete)',
  '      "$TIMBER_REAL_GIT" worktree add "$TIMBER_RACE_NEW_PATH" "$TIMBER_RACE_BRANCH" ;;',
  '    advance-ref-before-delete)',
  '      "$TIMBER_REAL_GIT" update-ref "refs/heads/$TIMBER_RACE_BRANCH" "$TIMBER_RACE_NEW_OID" "$TIMBER_RACE_EXPECTED_OID"',
  '      if [ "$?" -ne 0 ]; then exit 20; fi ;;',
  '  esac',
  'fi',
  'exec "$TIMBER_REAL_GIT" "$@"',
  "",
].join("\n");

async function addTarget(primary: string, path: string, branch: string): Promise<void> {
  await git(primary, "worktree", "add", "-b", branch, path);
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

async function branchOid(primary: string, branch: string): Promise<string | null> {
  const result = await execa("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { cwd: primary, reject: false });
  return result.exitCode === 0 ? result.stdout : null;
}

async function isAbsent(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

async function assertStillRegistered(primary: string, path: string, branch: string, oid: string, refsBefore: string): Promise<void> {
  expect(await branchOid(primary, branch)).toBe(oid);
  expect(await refs(primary)).toBe(refsBefore);
  const repository = await discoverRepository(primary);
  expect((await listWorktrees(repository)).some(tree => tree.path === path)).toBe(true);
}

async function configureRemote(primary: string, directory: string, path: string, branch: string, name = "upstream"): Promise<string> {
  const bare = join(directory, `${name}.git`);
  await git(directory, "init", "--bare", bare);
  await git(primary, "remote", "add", name, bare);
  await git(path, "push", "--set-upstream", name, branch);
  return bare;
}

async function commitFile(path: string, name: string, body: string, message: string): Promise<string> {
  await writeFile(join(path, name), body);
  await git(path, "add", "--", name);
  await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(path, "rev-parse", "HEAD");
}

async function runWithGitRace(
  primary: string, directory: string, repository: RepositoryContext, worktree: Worktree,
  action: string, extra: Record<string, string> = {}, options: CleanupOptions = noDiscard,
) {
  const wrapperDirectory = join(directory, `git wrapper ${action}`);
  await mkdir(wrapperDirectory);
  const realGit = (await execa("which", ["git"])).stdout;
  const wrapper = join(wrapperDirectory, "git");
  await writeFile(wrapper, wrapperSource);
  await chmod(wrapper, 0o755);
  const inputPath = join(directory, `cleanup request ${action}.json`);
  await writeFile(inputPath, JSON.stringify({ repository, worktree, config: config(), options }));
  return execa(process.execPath, [runnerPath, inputPath], {
    cwd: primary,
    reject: false,
    env: {
      ...process.env,
      PATH: `${wrapperDirectory}:${process.env.PATH ?? ""}`,
      TIMBER_REAL_GIT: realGit,
      TIMBER_RACE_ACTION: action,
      TIMBER_RACE_TARGET: worktree.path,
      TIMBER_RACE_MARKER: join(directory, `race marker ${action}`),
      ...extra,
    },
  });
}

test("inspection is not deletion authority after file, branch, lock, or path changes", async () => {
  await withRepository(async (primary, directory) => {
    for (const action of ["modified", "untracked", "ignored", "commit", "switch", "lock", "replace"] as const) {
      const path = join(directory, `stale ${action}`);
      const branch = `feature/stale-${action}`;
      await addTarget(primary, path, branch);
      const repository = await discoverRepository(primary);
      const selection = await selectedTree(primary, path);
      expect((await inspectCleanup(repository, selection, config())).ancestry.kind).toBe("contained");
      const original = await readFile(join(path, "tracked.txt"), "utf8");

      if (action === "modified") await writeFile(join(path, "tracked.txt"), "stale modified bytes\n");
      else if (action === "untracked") await writeFile(join(path, "stale.txt"), "stale untracked bytes\n");
      else if (action === "ignored") await writeFile(join(path, ".env"), "stale ignored bytes\n");
      else if (action === "commit") await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "new unpublished commit");
      else if (action === "switch") await git(path, "switch", "-c", "feature/switched-after-inspection");
      else if (action === "lock") await git(primary, "worktree", "lock", "--reason", "after inspection", path);
      else {
        await rm(path, { recursive: true, force: true });
        await mkdir(path);
        await git(path, "init", "-b", "main");
        await writeFile(join(path, "replacement.txt"), "replacement bytes\n");
        await git(path, "add", ".");
        await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "replacement repository");
      }

      const refsBefore = await refs(primary);
      const oid = (await branchOid(primary, branch))!;
      let replacementRefs = "";
      if (action === "replace") replacementRefs = await refs(path);
      await expect(cleanupWorktree(repository, selection, config(), noDiscard)).rejects.toThrow();
      expect(await branchOid(primary, branch)).toBe(oid);
      expect(await refs(primary)).toBe(refsBefore);
      if (action === "replace") {
        expect(await refs(path)).toBe(replacementRefs);
        expect(await readFile(join(path, "replacement.txt"), "utf8")).toBe("replacement bytes\n");
      } else {
        const current = (await listWorktrees(await discoverRepository(primary))).find(tree => tree.path === path);
        expect(current).toBeDefined();
        if (action === "modified") expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("stale modified bytes\n");
        else if (action === "untracked") expect(await readFile(join(path, "stale.txt"), "utf8")).toBe("stale untracked bytes\n");
        else if (action === "ignored") expect(await readFile(join(path, ".env"), "utf8")).toBe("stale ignored bytes\n");
        else if (action === "commit") expect(await git(path, "rev-parse", "HEAD")).toBe(oid);
        else if (action === "switch") expect(current?.branch).toBe("feature/switched-after-inspection");
        else if (action === "lock") expect(current?.locked).not.toBeNull();
        else expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe(original);
      }
      expect(await isAbsent(path)).toBe(false);
    }
  });
});

test("cleanup rejects a now-stale validated base after inspection", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "stale base linked");
    await addTarget(primary, path, "feature/stale-base");
    const repository = await discoverRepository(primary);
    const selection = await selectedTree(primary, path);
    expect((await inspectCleanup(repository, selection, config())).ancestry.kind).toBe("contained");
    const baseTree = await git(primary, "rev-parse", "refs/heads/trunk^{tree}");
    const unrelatedCommit = await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit-tree", baseTree, "-m", "unrelated replacement base");
    await git(primary, "update-ref", "refs/heads/trunk", unrelatedCommit);
    const refsBefore = await refs(primary);
    const oid = (await branchOid(primary, "feature/stale-base"))!;
    await expect(cleanupWorktree(repository, selection, config(), noDiscard)).rejects.toThrow(/base|ancestry|contained|publication/i);
    await assertStillRegistered(primary, path, "feature/stale-base", oid, refsBefore);
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("cleanup rechecks a remotely rewritten upstream after inspection", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "rewritten remote linked");
    await addTarget(primary, path, "feature/rewritten");
    const feature = await commitFile(path, "feature.txt", "published before rewrite\n", "published feature");
    const remote = await configureRemote(primary, directory, path, "feature/rewritten", "rewritten");
    const repository = await discoverRepository(primary);
    const selection = await selectedTree(primary, path);
    const before = await inspectCleanup(repository, selection, config());
    expect(before.publication.kind).toBe("published");
    expect(before.ancestry.kind).toBe("not-contained");
    const base = await git(primary, "rev-parse", "refs/heads/trunk");
    await git(remote, "update-ref", "refs/heads/feature/rewritten", base);
    const refsBefore = await refs(primary);
    await expect(cleanupWorktree(repository, selection, config(), keepBranch)).rejects.toThrow(/publication|unpublished|upstream/i);
    await assertStillRegistered(primary, path, "feature/rewritten", feature, refsBefore);
    expect(await git(remote, "rev-parse", "refs/heads/feature/rewritten")).toBe(base);
    expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("published before rewrite\n");
  });
});

test("final local safety reads catch ignored files, locks, branch advance, and base rewind", async () => {
  await withRepository(async (primary, directory) => {
    for (const action of ["add-ignored", "lock-target", "advance-target", "rewind-base"] as const) {
      if (action === "rewind-base") await commitFile(primary, "base-next.txt", "base now advances\n", "advance the validated base");
      const path = join(directory, `final guard ${action}`);
      const branch = `feature/final-${action}`;
      await addTarget(primary, path, branch);
      const bare = await configureRemote(primary, directory, path, branch, `final-${action}`);
      const repository = await discoverRepository(primary);
      const selection = await selectedTree(primary, path);
      const oidBefore = (await branchOid(primary, branch))!;
      const baseOid = action === "rewind-base" ? await git(primary, "rev-parse", "refs/heads/trunk~1") : "";
      const refsBefore = await refs(primary);
      const result = await runWithGitRace(primary, directory, repository, selection, action, {
        TIMBER_RACE_BASE_OID: baseOid,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toContain("RAW_WRAPPER_DIAGNOSTIC");
      expect(await isAbsent(path)).toBe(false);
      expect(await git(bare, "rev-parse", `refs/heads/${branch}`)).toBe(oidBefore);
      if (action === "advance-target") expect(await branchOid(primary, branch)).not.toBe(oidBefore);
      else expect(await branchOid(primary, branch)).toBe(oidBefore);
      if (action === "rewind-base") expect(await git(primary, "rev-parse", "refs/heads/trunk")).toBe(baseOid);
      if (action === "add-ignored") expect(await readFile(join(path, ".env"), "utf8")).toBe("race ignored bytes\n");
      if (action === "lock-target") expect((await selectedTree(primary, path)).locked).not.toBeNull();
      const refsAfter = await refs(primary);
      if (action !== "advance-target" && action !== "rewind-base") expect(refsAfter).toBe(refsBefore);
      expect(result.stderr).toMatch(action === "add-ignored" ? /ignored|\.env/i
        : action === "lock-target" ? /locked/i
          : action === "advance-target" ? /changed|selection|branch/i
            : /base|ancestry|contained/i);
    }
  });
});

test("Git remove boundary refuses dirt introduced after the final safety read", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "remove boundary linked");
    await addTarget(primary, path, "feature/remove-boundary");
    const repository = await discoverRepository(primary);
    const selection = await selectedTree(primary, path);
    const oid = (await branchOid(primary, "feature/remove-boundary"))!;
    const refsBefore = await refs(primary);
    const result = await runWithGitRace(primary, directory, repository, selection, "dirty-at-remove");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/path still exists|still lists|retained/i);
    expect(await readFile(join(path, "raced.txt"), "utf8")).toBe("raced untracked bytes\n");
    await assertStillRegistered(primary, path, "feature/remove-boundary", oid, refsBefore);
  });
});

test("failed or interrupted removal reports observed path, registration, and branch state", async () => {
  await withRepository(async (primary, directory) => {
    for (const action of ["fail-remove-before", "fail-remove-after"] as const) {
      const path = join(directory, `remove failure ${action}`);
      const branch = `feature/${action}`;
      await addTarget(primary, path, branch);
      const repository = await discoverRepository(primary);
      const selection = await selectedTree(primary, path);
      const oid = (await branchOid(primary, branch))!;
      const refsBefore = await refs(primary);
      const result = await runWithGitRace(primary, directory, repository, selection, action);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toContain("RAW_WRAPPER_DIAGNOSTIC");
      expect(result.stderr).toContain(`Local branch ${branch} remains at ${oid}.`);
      expect(await branchOid(primary, branch)).toBe(oid);
      expect(await refs(primary)).toBe(refsBefore);
      if (action === "fail-remove-before") {
        expect(result.stderr).toContain("The worktree path still exists.");
        expect(result.stderr).toContain("Git still lists the worktree.");
        expect(await isAbsent(path)).toBe(false);
        await assertStillRegistered(primary, path, branch, oid, refsBefore);
      } else {
        expect(result.stderr).toContain("The worktree path is absent.");
        expect(result.stderr).toContain("Git no longer lists the worktree.");
        expect(await isAbsent(path)).toBe(true);
      }
    }
  });
});

test("branch deletion failure reports successful worktree removal and retained local and remote refs", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "branch delete failure linked");
    const unrelated = join(directory, "unrelated branch delete worktree");
    await addTarget(primary, path, "feature/delete-failure");
    await addTarget(primary, unrelated, "feature/unrelated");
    const remote = await configureRemote(primary, directory, path, "feature/delete-failure", "retained-remote");
    const repository = await discoverRepository(primary);
    const selection = await selectedTree(primary, path);
    const oid = (await branchOid(primary, "feature/delete-failure"))!;
    const remoteOid = await git(remote, "rev-parse", "refs/heads/feature/delete-failure");
    const primaryBytes = await readFile(join(primary, "tracked.txt"), "utf8");
    const unrelatedBytes = await readFile(join(unrelated, "tracked.txt"), "utf8");
    const result = await runWithGitRace(primary, directory, repository, selection, "fail-ref-delete");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/worktree was removed/i);
    expect(result.stderr).toMatch(/branch feature\/delete-failure was not deleted/i);
    expect(result.stderr).toContain(`Local branch feature/delete-failure was retained at ${oid}.`);
    expect(result.stderr).not.toContain("changed before its conditional deletion");
    expect(result.stderr).not.toContain("RAW_WRAPPER_DIAGNOSTIC");
    expect(await isAbsent(path)).toBe(true);
    expect(await branchOid(primary, "feature/delete-failure")).toBe(oid);
    expect(await git(remote, "rev-parse", "refs/heads/feature/delete-failure")).toBe(remoteOid);
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe(primaryBytes);
    expect(await readFile(join(unrelated, "tracked.txt"), "utf8")).toBe(unrelatedBytes);
    const trees = await listWorktrees(await discoverRepository(primary));
    expect(trees.some(tree => tree.path === path)).toBe(false);
    expect(trees.some(tree => tree.path === unrelated)).toBe(true);
  });
});

test("expected OID deletion preserves a branch advanced at the update boundary", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "advance before deletion linked");
    await addTarget(primary, path, "feature/advance-before-delete");
    const oid = (await branchOid(primary, "feature/advance-before-delete"))!;
    const newOid = await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit-tree", `${oid}^{tree}`, "-p", oid, "-m", "concurrent branch advance");
    const repository = await discoverRepository(primary);
    const selection = await selectedTree(primary, path);
    const result = await runWithGitRace(primary, directory, repository, selection, "advance-ref-before-delete", {
      TIMBER_RACE_BRANCH: "feature/advance-before-delete",
      TIMBER_RACE_EXPECTED_OID: oid,
      TIMBER_RACE_NEW_OID: newOid,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/worktree was removed/i);
    expect(result.stderr).toMatch(/changed and was retained/i);
    expect(result.stderr).toContain(newOid);
    expect(await isAbsent(path)).toBe(true);
    expect(await branchOid(primary, "feature/advance-before-delete")).toBe(newOid);
  });
});

test("branch checked out in a new worktree during post-removal verification is retained", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "original branch worktree");
    const newPath = join(directory, "concurrent branch worktree");
    await addTarget(primary, path, "feature/reused-branch");
    const oid = (await branchOid(primary, "feature/reused-branch"))!;
    const repository = await discoverRepository(primary);
    const selection = await selectedTree(primary, path);
    const result = await runWithGitRace(primary, directory, repository, selection, "add-worktree-after-remove", {
      TIMBER_RACE_BRANCH: "feature/reused-branch",
      TIMBER_RACE_NEW_PATH: newPath,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/worktree was removed/i);
    expect(result.stderr).toMatch(/checked out in another worktree|retained/i);
    expect(await isAbsent(path)).toBe(true);
    expect(await isAbsent(newPath)).toBe(false);
    expect(await branchOid(primary, "feature/reused-branch")).toBe(oid);
    await assertStillRegistered(primary, newPath, "feature/reused-branch", oid, await refs(primary));
  });
});

test("branch checked out in the inventory-to-delete gap is restored and retained", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "gap original worktree");
    const newPath = join(directory, "gap concurrent worktree");
    await addTarget(primary, path, "feature/gap-checkout");
    const oid = (await branchOid(primary, "feature/gap-checkout"))!;
    const repository = await discoverRepository(primary);
    const selection = await selectedTree(primary, path);
    const result = await runWithGitRace(primary, directory, repository, selection, "checkout-before-delete", {
      TIMBER_RACE_BRANCH: "feature/gap-checkout",
      TIMBER_RACE_NEW_PATH: newPath,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/worktree was removed/i);
    expect(result.stderr).toMatch(/checked out in another worktree|retained/i);
    expect(await isAbsent(path)).toBe(true);
    expect(await isAbsent(newPath)).toBe(false);
    expect(await branchOid(primary, "feature/gap-checkout")).toBe(oid);
    expect(await git(newPath, "rev-parse", "HEAD")).toBe(oid);
    expect(await git(newPath, "symbolic-ref", "--quiet", "HEAD")).toBe("refs/heads/feature/gap-checkout");
  });
});

test.each([false, true])("cleanup rechecks live publication after final local safety reads with keepBranch=%s", async keep => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "final publication linked");
    await addTarget(primary, path, "feature/final-publication");
    const feature = await commitFile(path, "feature.txt", "published for final recheck\n", "published feature");
    const remote = await configureRemote(primary, directory, path, "feature/final-publication", "final-publication");
    const repository = await discoverRepository(primary);
    const selection = await selectedTree(primary, path);
    const before = await inspectCleanup(repository, selection, config());
    expect(before.publication.kind).toBe("published");
    expect(before.ancestry.kind).toBe("not-contained");
    const base = await git(primary, "rev-parse", "refs/heads/trunk");
    const refsBefore = await refs(primary);
    const result = await runWithGitRace(primary, directory, repository, selection, "rewrite-remote-during-final-status", {
      TIMBER_RACE_REMOTE: remote,
      TIMBER_RACE_REMOTE_BRANCH: "feature/final-publication",
      TIMBER_RACE_REMOTE_OID: base,
      TIMBER_RACE_STATUS_MARKER: join(directory, "race status marker final-publication"),
    }, keep ? keepBranch : noDiscard);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/publication|unpublished|upstream/i);
    expect(await isAbsent(path)).toBe(false);
    expect(await branchOid(primary, "feature/final-publication")).toBe(feature);
    expect(await refs(primary)).toBe(refsBefore);
    expect(await git(remote, "rev-parse", "refs/heads/feature/final-publication")).toBe(base);
    expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("published for final recheck\n");
  });
});

test.each(["rewrite", "delete"] as const)("review cleanup retains the local branch if the remote changes after removal: %s", async action => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "review linked");
    const branch = "feature/review-race";
    await addTarget(primary, path, branch);
    const oid = await commitFile(path, "review.txt", "published review\n", "review commit");
    const remote = await configureRemote(primary, directory, path, branch, "review");
    const base = await git(primary, "rev-parse", "trunk");
    const beforeRefs = await refs(primary);
    const repository = await discoverRepository(primary);
    const selection = await selectedTree(primary, path);
    const result = await runWithGitRace(primary, directory, repository, selection, `${action}-remote-after-remove`, {
      TIMBER_RACE_REMOTE: remote,
      TIMBER_RACE_REMOTE_BRANCH: branch,
      TIMBER_RACE_REMOTE_OID: base,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("worktree was removed");
    expect(result.stderr).toContain("Live upstream publication could not be reproven");
    expect(result.stderr).toContain(`retained at ${oid}`);
    expect(await isAbsent(path)).toBe(true);
    expect(await branchOid(primary, branch)).toBe(oid);
    expect(await refs(primary)).toBe(beforeRefs);
    expect(await git(primary, "show", `${branch}:review.txt`)).toBe("published review");
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("original\n");
  });
});
