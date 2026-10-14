import { expect, test } from "bun:test";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { listCompletionTargets, createCompletionTargetService } from "../src/completion/targets";
import { discoverRepository } from "../src/git/repository";
import { resolveOpenTarget } from "../src/git/open-target";
import type { Branch, GitReadOptions, RepositoryContext, WorktreeInventory } from "../src/types";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

async function addRemoteRef(repository: string, remote: string, branch: string, commit: string): Promise<void> {
  await git(repository, "update-ref", `refs/remotes/${remote}/${branch}`, commit);
}

function completionQuery(line: string, cword: number, words: readonly string[]): string[] {
  return [
    "completion", "__query", "--", String(cword), String(Array.from(line).length), line,
    " \t\n'\"@><=;|&(:", ...words,
  ];
}

test("open and done expose only safe selectors from a fresh offline Git snapshot", async () => {
  await withRepository(async (primary, directory) => {
    const linkedRoot = join(directory, "primary repo-worktrees");
    const linked = join(linkedRoot, "locked dirty feature");
    const detached = join(directory, "detached fixture");
    const stale = join(directory, "stale registered fixture");
    const collision = join(directory, "remote name collision");
    await mkdir(linkedRoot);
    await git(primary, "worktree", "add", "-b", "TIM-23-feature-one", linked);
    await git(primary, "worktree", "add", "--detach", detached);
    await git(primary, "worktree", "add", "-b", "stale-registered", stale);
    await git(primary, "worktree", "add", "-b", "origin/topic", collision);
    await git(primary, "worktree", "lock", linked, "--reason", "fixture lock");
    await rm(stale, { recursive: true });
    await writeFile(join(linked, "tracked.txt"), "dirty but preserved\n");
    await writeFile(join(linked, "untracked fixture.txt"), "preserve me\n");
    await writeFile(join(linked, ".env"), "fixture only\n");

    await git(primary, "branch", "unchecked-local");
    await git(primary, "branch", "TIM-23-feature-two");
    await git(primary, "branch", "origin/local-only");
    await git(primary, "remote", "add", "origin", join(directory, "origin.git"));
    await git(primary, "remote", "add", "upstream", join(directory, "upstream.git"));
    const head = await git(primary, "rev-parse", "HEAD");
    await addRemoteRef(primary, "origin", "topic", head);
    await addRemoteRef(primary, "origin", "remote-only", head);
    await addRemoteRef(primary, "upstream", "topic", head);
    await git(primary, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic");
    await git(primary, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/topic");

    const linkedGitDir = await git(linked, "rev-parse", "--absolute-git-dir");
    const before = {
      refs: await git(primary, "show-ref"),
      inventory: await git(primary, "worktree", "list", "--porcelain", "-z"),
      primaryIndex: await readFile(join(primary, ".git", "index")),
      linkedIndex: await readFile(join(linkedGitDir, "index")),
      tracked: await readFile(join(linked, "tracked.txt")),
      untracked: await readFile(join(linked, "untracked fixture.txt")),
      ignored: await readFile(join(linked, ".env")),
    };

    const open = await listCompletionTargets("open", linked);
    const done = await listCompletionTargets("done", primary);
    expect(open).toContain(primary);
    expect(open).toContain("trunk");
    expect(open).toContain(linked);
    expect(open).toContain("TIM-23-feature-one");
    expect(open).toContain("TIM-23-feature-two");
    expect(open).toContain(detached);
    expect(open).toContain(stale);
    expect(open).toContain("unchecked-local");
    expect(open).toContain(collision);
    expect(open.filter(value => value === "origin/topic")).toHaveLength(1);
    expect(open).toContain("origin/remote-only");
    expect(open).toContain("upstream/topic");
    expect(open).not.toContain("origin/HEAD");
    expect(open).not.toContain("upstream/HEAD");
    expect(open).not.toContain("origin/local-only");

    expect(done).toContain(linked);
    expect(done).toContain("TIM-23-feature-one");
    expect(done).toContain(detached);
    expect(done).toContain(stale);
    expect(done).toContain("stale-registered");
    expect(done).toContain(collision);
    expect(done).not.toContain(primary);
    expect(done).not.toContain("trunk");
    expect(done).not.toContain("unchecked-local");
    expect(done).not.toContain("TIM-23-feature-two");
    expect(done).not.toContain("origin/topic");
    expect(done).not.toContain("origin/remote-only");
    expect(done).not.toContain("upstream/topic");

    const resolution = await resolveOpenTarget(await discoverRepository(primary), "origin/topic", {
      baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null,
    }, { assertOpenable: false });
    expect(resolution).toMatchObject({
      kind: "found", value: { kind: "branch", branch: { kind: "remote", remote: "origin", name: "topic" } },
    });

    expect({
      refs: await git(primary, "show-ref"),
      inventory: await git(primary, "worktree", "list", "--porcelain", "-z"),
      primaryIndex: await readFile(join(primary, ".git", "index")),
      linkedIndex: await readFile(join(linkedGitDir, "index")),
      tracked: await readFile(join(linked, "tracked.txt")),
      untracked: await readFile(join(linked, "untracked fixture.txt")),
      ignored: await readFile(join(linked, ".env")),
    }).toEqual(before);
  });
});

test("target lookup is fresh and discovers the same repository from primary, nested, and linked cwd", async () => {
  await withRepository(async (primary, directory) => {
    const nestedPrimary = join(primary, "nested cwd");
    const linked = join(directory, "nested linked tree");
    const nestedLinked = join(linked, "child directory");
    await mkdir(nestedPrimary);
    await mkdir(linked);
    await git(primary, "worktree", "add", "-b", "fresh-target", linked);
    await mkdir(nestedLinked);

    const primaryTargets = await listCompletionTargets("done", primary);
    const nestedTargets = await listCompletionTargets("done", nestedPrimary);
    const linkedTargets = await listCompletionTargets("done", nestedLinked);
    expect(primaryTargets).toContain("fresh-target");
    expect(nestedTargets).toEqual(primaryTargets);
    expect(linkedTargets).toEqual(primaryTargets);

    await git(primary, "worktree", "remove", linked);
    const afterRemoval = await listCompletionTargets("done", primary);
    expect(afterRemoval).not.toContain("fresh-target");
    expect(afterRemoval).not.toContain(linked);
  });
});

test("completion target lookup handles unborn repositories, nonrepositories, and missing directories", async () => {
  await withRepository(async (_primary, directory) => {
    const unborn = join(directory, "unborn repository");
    await mkdir(unborn);
    await git(unborn, "init", "-b", "waiting");
    expect(await listCompletionTargets("open", unborn)).toEqual([unborn, "waiting"]);

    const outside = join(directory, "outside repository");
    await mkdir(outside);
    await expect(listCompletionTargets("open", outside)).rejects.toThrow(/not a Git repository/i);
    await expect(listCompletionTargets("done", join(directory, "missing"))).rejects.toThrow(/cannot access directory/i);

    const line = "timber open t";
    const quietQuery = await execa(process.execPath, [entry, ...completionQuery(line, 2, ["timber", "open", "t"])], {
      cwd: outside, env: { CI: "true", HOME: directory }, reject: false, timeout: 5000,
    });
    expect(quietQuery.exitCode).toBe(0);
    expect(quietQuery.stdout).toBe("");
    expect(quietQuery.stderr).toBe("");
  });
});

test("target service shares one abort signal and fails closed at each read boundary", async () => {
  const repository: RepositoryContext = {
    currentWorktreeRoot: "/repo", primaryWorktreeRoot: "/repo", commonGitDir: "/repo/.git",
    currentBranch: "main", remotes: [],
  };
  const inventory: readonly WorktreeInventory[] = [];
  const branches: readonly Branch[] = [];
  const seen: AbortSignal[] = [];
  const service = createCompletionTargetService({
    discoverRepository: async (_cwd: string, options?: GitReadOptions) => { seen.push(options!.signal!); return repository; },
    listWorktreeInventory: async (_repository, options?: GitReadOptions) => { seen.push(options!.signal!); return inventory; },
    listBranches: async (_repository, options?: GitReadOptions) => { seen.push(options!.signal!); return branches; },
  });
  expect(await service("open", "/repo")).toEqual([]);
  expect(seen).toHaveLength(3);
  expect(seen[0]).toBe(seen[1]);
  expect(seen[1]).toBe(seen[2]);

  const discoveryFailure = createCompletionTargetService({
    discoverRepository: async () => { throw new Error("discovery denied"); },
    listWorktreeInventory: async () => { throw new Error("must not run"); },
    listBranches: async () => { throw new Error("must not run"); },
  });
  await expect(discoveryFailure("done", "/repo")).rejects.toThrow("discovery denied");

  const inventoryFailure = createCompletionTargetService({
    discoverRepository: async () => repository,
    listWorktreeInventory: async () => { throw new Error("inventory denied"); },
    listBranches: async () => { throw new Error("must not run for done"); },
  });
  await expect(inventoryFailure("done", "/repo")).rejects.toThrow("inventory denied");

  const branchFailure = createCompletionTargetService({
    discoverRepository: async () => repository,
    listWorktreeInventory: async () => inventory,
    listBranches: async () => { throw new Error("branch read denied"); },
  });
  await expect(branchFailure("open", "/repo")).rejects.toThrow("branch read denied");
});

test("the executable query stays quiet when Git is unavailable", async () => {
  await withRepository(async (primary, directory) => {
    const noGitPath = join(directory, "empty path");
    await mkdir(noGitPath);
    const line = "timber open t";
    const result = await execa(process.execPath, [entry, ...completionQuery(line, 2, ["timber", "open", "t"])], {
      cwd: primary, env: { CI: "true", HOME: directory, PATH: noGitPath }, reject: false, timeout: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

test("Git reads are allowlisted, lock-free, argument based, and bounded by one deadline", async () => {
  await withRepository(async (primary, directory) => {
    const bin = join(directory, "git audit bin");
    const log = join(directory, "git audit args");
    const badLocks = join(directory, "bad locks");
    await mkdir(bin);
    const realGit = (await execa("which", ["git"])).stdout;
    const wrapper = join(bin, "git");
    await writeFile(wrapper, [
      "#!/bin/sh",
      "if [ \"${GIT_OPTIONAL_LOCKS-}\" != 0 ]; then printf bad > \"$TEST_BAD_LOCKS\"; exit 95; fi",
      "case \"$1:$2\" in",
      "  rev-parse:--is-inside-work-tree|rev-parse:--show-toplevel|rev-parse:--path-format=absolute|symbolic-ref:--quiet|remote:|worktree:list|for-each-ref:--format=*) ;;",
      "  *) exit 96 ;;",
      "esac",
      "printf '%s\\t' \"$@\" >> \"$TEST_GIT_LOG\"",
      "printf '\\n' >> \"$TEST_GIT_LOG\"",
      "exec \"$TEST_REAL_GIT\" \"$@\"",
      "",
    ].join("\n"), { mode: 0o755 });

    const line = "timber open t";
    const allowed = await execa(process.execPath, [entry, ...completionQuery(line, 2, ["timber", "open", "t"])], {
      cwd: primary,
      env: { CI: "true", HOME: directory, PATH: bin, TEST_REAL_GIT: realGit, TEST_GIT_LOG: log, TEST_BAD_LOCKS: badLocks },
      reject: false, timeout: 5000,
    });
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout).toBe("trunk\0");
    expect(allowed.stderr).toBe("");
    await expect(access(badLocks)).rejects.toThrow();
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(row => row.split("\t"));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(args => ["rev-parse", "worktree", "symbolic-ref", "remote", "for-each-ref"].includes(args[0]!))).toBe(true);
    expect(calls.some(args => args[0] === "for-each-ref")).toBe(true);
    expect(calls.some(args => ["status", "fetch", "ls-remote"].includes(args[0]!))).toBe(false);

    const stallBin = join(directory, "git stall bin");
    const stallPid = join(directory, "stalled child pid");
    const stallProgram = join(directory, "ignore-term.ts");
    await mkdir(stallBin);
    await writeFile(stallProgram, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.TEST_STALL_PID!, `${process.pid}\\n`);",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await writeFile(join(stallBin, "git"), [
      "#!/bin/sh",
      "if [ \"$1\" = for-each-ref ]; then exec \"$TEST_STALL_BUN\" \"$TEST_STALL_PROGRAM\"; fi",
      "exec \"$TEST_REAL_GIT\" \"$@\"",
      "",
    ].join("\n"), { mode: 0o755 });
    const started = Date.now();
    const stalled = await execa(process.execPath, [entry, ...completionQuery(line, 2, ["timber", "open", "t"])], {
      cwd: primary,
      env: {
        CI: "true", HOME: directory, PATH: stallBin, TEST_REAL_GIT: realGit,
        TEST_STALL_BUN: process.execPath, TEST_STALL_PROGRAM: stallProgram, TEST_STALL_PID: stallPid,
      },
      reject: false, timeout: 5000,
    });
    const elapsed = Date.now() - started;
    expect(stalled.exitCode).toBe(0);
    expect(stalled.stdout).toBe("");
    expect(stalled.stderr).toBe("");
    expect(elapsed).toBeLessThan(3000);
    const pid = Number(await readFile(stallPid, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

test("a dirty completion candidate still requires normal done cleanup checks", async () => {
  await withRepository(async (primary, directory) => {
    const branch = "TIM-23-dirty-candidate";
    const linked = join(directory, "dirty completion candidate");
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n');
    await git(primary, "worktree", "add", "-b", branch, linked);
    await writeFile(join(linked, "tracked.txt"), "modified tracked bytes\n");
    await writeFile(join(linked, "untracked.txt"), "untracked bytes\n");
    await writeFile(join(linked, ".env"), "ignored bytes\n");
    const linkedGitDir = await git(linked, "rev-parse", "--absolute-git-dir");
    const snapshot = async () => ({
      refs: await git(primary, "show-ref"),
      worktrees: await git(primary, "worktree", "list", "--porcelain", "-z"),
      primaryIndex: await readFile(join(primary, ".git", "index")),
      linkedIndex: await readFile(join(linkedGitDir, "index")),
      tracked: await readFile(join(linked, "tracked.txt")),
      untracked: await readFile(join(linked, "untracked.txt")),
      ignored: await readFile(join(linked, ".env")),
    });
    const before = await snapshot();

    expect(await listCompletionTargets("done", primary)).toContain(branch);
    expect(await listCompletionTargets("done", primary)).toContain(linked);
    expect(await snapshot()).toEqual(before);

    const result = await execa(process.execPath, ["--no-env-file", entry, "done", branch], {
      cwd: primary,
      env: { CI: "true", HOME: join(directory, "normal done home") },
      reject: false,
      timeout: 5000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/modified|untracked|dirty/i);
    expect(await snapshot()).toEqual(before);
  });
});
