import { expect, test } from "bun:test";
import { appendFile, chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { writeBaseAssociation } from "../src/git/base-metadata";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, "done", ...args], {
  cwd, reject: false, timeout: 5_000, env: { CI: "true" },
});

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function snapshot(primary: string) {
  return {
    refs: await git(primary, "for-each-ref", "--format=%(refname)%00%(objectname)"),
    trees: await git(primary, "worktree", "list", "--porcelain", "-z"),
    primaryFile: await readFile(join(primary, "tracked.txt"), "utf8"),
  };
}

async function target(primary: string, directory: string, branch = "feature/one") {
  await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n');
  const path = join(directory, `manual ${branch.replaceAll("/", "-")}`);
  await git(primary, "worktree", "add", "-b", branch, path);
  return path;
}

async function commit(path: string, name = "feature.txt", message = "feature commit") {
  await writeFile(join(path, name), "feature bytes\n");
  await git(path, "add", "--", name);
  await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(path, "rev-parse", "HEAD");
}

async function upstream(primary: string, directory: string, path: string, branch = "feature/one") {
  const remote = join(directory, "upstream.git");
  await git(directory, "init", "--bare", remote);
  await git(primary, "remote", "add", "backup", remote);
  await git(path, "push", "--set-upstream", "backup", branch);
  return remote;
}

async function retained(primary: string, path: string, before: Awaited<ReturnType<typeof snapshot>>) {
  expect(await absent(path)).toBe(false);
  expect(await snapshot(primary)).toEqual(before);
}

async function removed(primary: string, path: string, branch: string | null, deleted: boolean) {
  expect(await absent(path)).toBe(true);
  expect(await git(primary, "worktree", "list", "--porcelain")).not.toContain(`worktree ${path}\n`);
  if (branch !== null) {
    const ref = await execa("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: primary, reject: false });
    expect(ref.exitCode).toBe(deleted ? 1 : 0);
  }
  expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("original\n");
}

async function saveBase(primary: string, path: string, ref: string) {
  const repository = await discoverRepository(primary);
  const tree = (await listWorktrees(repository)).find(tree => tree.path === path)!;
  await writeBaseAssociation(repository, tree, ref);
  return join(await git(path, "rev-parse", "--absolute-git-dir"), "timber", "base.json");
}

test.each(["branch", "path", "ticket", "remote"])("done selects a merged manual worktree by %s and preserves unrelated work and remote refs", async selector => {
  await withRepository(async (primary, directory) => {
    const branch = "TIM-42-complete";
    const path = await target(primary, directory, branch);
    const pushedOid = await git(path, "rev-parse", "HEAD");
    const other = await target(primary, directory, "TIM-420-unrelated");
    await writeFile(join(other, "tracked.txt"), "unrelated dirty bytes\n");
    const remote = await upstream(primary, directory, path, branch);
    const remoteRefs = await git(remote, "show-ref");
    const otherOid = await git(other, "rev-parse", "HEAD");
    const nested = join(primary, "nested");
    await mkdir(nested);
    const input = selector === "branch" ? branch : selector === "path" ? path
      : selector === "ticket" ? "TIM-42" : `backup/${branch}`;

    const result = await cli(nested, input);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Removed worktree at ${path}`);
    expect(result.stdout).toContain(`Deleted local branch ${branch}`);
    await removed(primary, path, branch, true);
    expect(await readFile(join(other, "tracked.txt"), "utf8")).toBe("unrelated dirty bytes\n");
    expect(await git(other, "rev-parse", "HEAD")).toBe(otherOid);
    expect(await git(remote, "show-ref")).toBe(remoteRefs);
    expect(await git(primary, "rev-parse", "refs/remotes/backup/TIM-42-complete")).toBe(pushedOid);
  });
});

test("done from its own nested worktree uses primary config and keeps the branch explicitly", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const nested = join(path, "nested");
    await mkdir(nested);
    await writeFile(join(path, ".timber.toml"), "invalid [ toml");
    await git(primary, "config", "--add", "core.excludesFile", join(directory, "excludes"));
    await writeFile(join(directory, "excludes"), ".timber.toml\n");
    const refs = (await snapshot(primary)).refs;

    const result = await cli(nested, "feature/one", "--keep-branch", "--discard-ignored");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Retained local branch feature/one");
    expect(result.stdout).not.toContain("Deleted");
    await removed(primary, path, "feature/one", false);
    expect((await snapshot(primary)).refs).toBe(refs);
  });
});

test.each(["staged", "unstaged", "rename", "deleted", "untracked", "untracked-directory", "submodule"])("done preserves %s work even with both cleanup options", async scenario => {
  await withRepository(async (primary, directory) => {
    if (scenario === "submodule") {
      const source = join(directory, "submodule source");
      await mkdir(source);
      await git(source, "init", "-b", "main");
      await writeFile(join(source, "module.txt"), "module baseline\n");
      await git(source, "add", ".");
      await git(source, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "submodule baseline");
      await git(primary, "-c", "protocol.file.allow=always", "submodule", "add", source, "vendor/module");
      await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-am", "add submodule");
      const path = await target(primary, directory, "feature/submodule");
      await git(path, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
      await writeFile(join(path, "vendor/module", "module.txt"), "dirty module bytes\n");
      const before = await snapshot(primary);
      const result = await cli(primary, "feature/submodule", "--keep-branch", "--discard-ignored");
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/modified|untracked|dirty/i);
      expect(result.stderr).not.toContain("Cannot open");
      await retained(primary, path, before);
      expect(await readFile(join(path, "vendor/module", "module.txt"), "utf8")).toBe("dirty module bytes\n");
      return;
    }

    const path = await target(primary, directory);
    let file = "tracked.txt";
    if (scenario === "rename") {
      await git(path, "mv", "old name.txt", "renamed name.txt");
      file = "renamed name.txt";
    } else if (scenario === "deleted") {
      await rm(join(path, file));
    } else {
      if (scenario === "untracked") file = "untracked.txt";
      if (scenario === "untracked-directory") {
        await mkdir(join(path, "untracked directory"));
        file = "untracked directory/nested.txt";
      }
      await writeFile(join(path, file), "preserve bytes\n");
      if (scenario === "staged") await git(path, "add", "--", file);
    }
    const bytes = scenario === "deleted" ? null : await readFile(join(path, file));
    await writeFile(join(path, ".env"), "ignored bytes\n");
    const status = await git(path, "status", "--porcelain=v1", "-z");
    const before = await snapshot(primary);
    const result = await cli(primary, "feature/one", "--keep-branch", "--discard-ignored");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/modified|untracked/);
    expect(result.stderr).toContain(scenario === "untracked-directory" ? "untracked directory" : file);
    await retained(primary, path, before);
    expect(await readFile(join(path, ".env"), "utf8")).toBe("ignored bytes\n");
    expect(await git(path, "status", "--porcelain=v1", "-z")).toBe(status);
    if (bytes !== null) expect(await readFile(join(path, file))).toEqual(bytes);
    else expect(await absent(join(path, file))).toBe(true);
  });
});

test("done keeps ignored files in place with keep-ignored and discards them by default", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    await writeFile(join(path, ".env"), "synthetic private bytes\n");
    await appendFile(join(primary, ".git", "info", "exclude"), "cache/\n");
    await mkdir(join(path, "cache"));
    await writeFile(join(path, "cache", "ignored.txt"), "cache bytes\n");
    const before = await snapshot(primary);
    for (const options of [["--keep-ignored"], ["--keep-branch", "--keep-ignored"]]) {
      const refused = await cli(primary, path, ...options);
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("--keep-ignored");
      expect(refused.stderr).toContain(".env");
      expect(refused.stderr).not.toContain("synthetic private bytes");
      await retained(primary, path, before);
      expect(await readFile(join(path, ".env"), "utf8")).toBe("synthetic private bytes\n");
      expect(await readFile(join(path, "cache", "ignored.txt"), "utf8")).toBe("cache bytes\n");
    }
    const completed = await cli(primary, path);
    expect(completed.exitCode).toBe(0);
    expect(completed.stderr).toBe("");
    await removed(primary, path, "feature/one", true);
  });
});

test.each(["unmerged", "unknown-base"])("done removes published %s review work and its local branch while preserving the remote", async scenario => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const oid = await commit(path);
    const remote = await upstream(primary, directory, path);
    if (scenario === "unknown-base") await writeFile(join(primary, ".timber.toml"), 'base_branch = "absent"\n');
    const remoteRefs = await git(remote, "show-ref");
    const completed = await cli(primary, path);
    expect(completed.exitCode).toBe(0);
    expect(completed.stderr).toBe("");
    expect(completed.stdout).toContain("Deleted local branch feature/one");
    await removed(primary, path, "feature/one", true);
    expect(await git(primary, "for-each-ref", "refs/heads/feature/one")).toBe("");
    expect(await git(remote, "rev-parse", "refs/heads/feature/one")).toBe(oid);
    expect(await git(remote, "show-ref")).toBe(remoteRefs);
  });
});

// Allow fixture Git operations and preservation checks in addition to the CLI's own timeout.
test.each(["unpublished", "no-upstream", "offline", "rewritten-upstream", "ambiguous-base", "self-base"])("done refuses %s unproven work with both options and preserves all refs and bytes", async scenario => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const initial = await git(path, "rev-parse", "HEAD");
    const remote = scenario === "no-upstream" || scenario === "ambiguous-base" || scenario === "self-base"
      ? null : await upstream(primary, directory, path);
    const oid = await commit(path);
    if (scenario === "offline") await git(primary, "remote", "set-url", "backup", join(directory, "unavailable.git"));
    if (scenario === "rewritten-upstream" && remote !== null) {
      await git(path, "push", "backup", "feature/one");
      await git(remote, "update-ref", "refs/heads/feature/one", initial);
    }
    if (scenario === "ambiguous-base") {
      await git(primary, "branch", "main");
      await git(primary, "branch", "master");
      await writeFile(join(primary, ".timber.toml"), "");
    }
    if (scenario === "self-base") await writeFile(join(primary, ".timber.toml"), 'base_branch = "feature/one"\n');
    const before = await snapshot(primary);
    const remoteRefs = remote === null ? null : await git(remote, "show-ref");
    const result = await cli(primary, path, "--keep-branch", "--discard-ignored");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/unpublished|publication|published/);
    expect(result.stderr).toContain(remote !== null && scenario !== "offline" ? oid
      : scenario === "self-base" ? "target branch is the validated base"
        : scenario === "ambiguous-base" ? "validated cleanup base" : "upstream");
    await retained(primary, path, before);
    expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature bytes\n");
    if (remote !== null) expect(await git(remote, "show-ref")).toBe(remoteRefs!);
  });
}, 15_000);

test("done accepts base containment offline, including a contained detached worktree", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const remote = await upstream(primary, directory, path);
    await git(primary, "remote", "set-url", "backup", join(directory, "unavailable.git"));
    const before = await git(remote, "show-ref");
    const completed = await cli(primary, path);
    expect(completed.exitCode).toBe(0);
    expect(completed.stderr).toBe("");
    await removed(primary, path, "feature/one", true);
    expect(await git(remote, "show-ref")).toBe(before);
    const detached = join(directory, "detached");
    await git(primary, "worktree", "add", "--detach", detached, "HEAD");
    const refs = (await snapshot(primary)).refs;
    const result = await cli(primary, detached);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`Removed worktree at ${detached}`);
    await removed(primary, detached, null, false);
    expect((await snapshot(primary)).refs).toBe(refs);
  });
});

test.each([
  "primary-path", "primary-branch", "locked", "missing", "replaced",
  "unknown-status", "detached-unmerged", "invalid-config", "force",
])("done refuses %s targets without erasing files or refs", async scenario => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    let input = path;
    let diagnostic: RegExp;
    if (scenario === "primary-path") { input = primary; diagnostic = /primary/; }
    else if (scenario === "primary-branch") { input = "trunk"; diagnostic = /primary/; }
    else if (scenario === "locked") { await git(primary, "worktree", "lock", path); diagnostic = /locked/; }
    else if (scenario === "missing") { await rm(path, { recursive: true }); diagnostic = /missing|prunable|stale/; }
    else if (scenario === "replaced") {
      await rm(path, { recursive: true });
      await mkdir(path);
      await writeFile(join(path, "unrelated.txt"), "replacement bytes\n");
      diagnostic = /identity|metadata|prunable|stale/;
    } else if (scenario === "unknown-status") {
      const index = await git(path, "rev-parse", "--path-format=absolute", "--git-path", "index");
      await writeFile(index, "invalid index\n");
      diagnostic = /status.*unknown|unknown.*status/;
    } else if (scenario === "detached-unmerged") {
      await git(path, "checkout", "--detach");
      await commit(path);
      diagnostic = /published|publication|base/;
    } else if (scenario === "invalid-config") {
      await writeFile(join(primary, ".timber.toml"), "invalid [ toml");
      diagnostic = /config|\.timber\.toml/;
    } else diagnostic = /unknown option.*--force/;
    const before = await snapshot(primary);
    const result = await cli(primary, input, ...(scenario === "force" ? ["--force"] : ["--keep-branch", "--discard-ignored"]));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(diagnostic);
    expect(result.stderr).not.toContain("Cannot open");
    expect(await snapshot(primary)).toEqual(before);
    expect(await absent(path)).toBe(scenario === "missing");
    if (scenario === "replaced") expect(await readFile(join(path, "unrelated.txt"), "utf8")).toBe("replacement bytes\n");
    else if (scenario !== "missing") expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("done refuses ambiguous prefixes, unchecked branches, and unknown paths without creating or deleting worktrees", async () => {
  await withRepository(async (primary, directory) => {
    const first = await target(primary, directory, "TIM-42-first");
    const second = await target(primary, directory, "TIM-42-second");
    await git(primary, "branch", "unchecked");
    const remote = await upstream(primary, directory, first, "TIM-42-first");
    await git(primary, "push", "backup", "trunk:remote-only");
    const remoteRefs = await git(remote, "show-ref");
    const before = await snapshot(primary);
    for (const [input, diagnostic] of [
      ["TIM-42", /multiple/], ["unchecked", /no registered worktree/],
      ["backup/remote-only", /no registered worktree/],
      ["unknown", /[Nn]o .*matches/], [join(directory, "unregistered"), /[Nn]o .*matches/],
      [" ", /[Pp]rovide/],
    ] as const) {
      const result = await cli(primary, input);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(diagnostic);
      if (input === "TIM-42") {
        expect(result.stderr).toContain(first);
        expect(result.stderr).toContain(second);
        expect(result.stderr).toContain("exact branch name or absolute worktree path");
      }
      await retained(primary, first, before);
      expect(await readFile(join(second, "tracked.txt"), "utf8")).toBe("original\n");
      expect(await git(remote, "show-ref")).toBe(remoteRefs);
    }
  });
});

test.each([false, true])("done ignores a remote-only prefix match while retaining cleanup safeguards (dirty: %s)", async dirty => {
  await withRepository(async (primary, directory) => {
    const branch = "ENG-835-pilot";
    const path = await target(primary, directory, branch);
    const remote = await upstream(primary, directory, path, branch);
    await git(primary, "push", "backup", "trunk:ENG-835-rest");
    if (dirty) await writeFile(join(path, "tracked.txt"), "keep dirty work\n");
    const before = await snapshot(primary);
    const remoteRefs = await git(remote, "show-ref");
    const result = await cli(primary, "ENG-835");
    expect(result.exitCode).toBe(dirty ? 1 : 0);
    if (dirty) {
      await retained(primary, path, before);
      expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("keep dirty work\n");
    } else {
      await removed(primary, path, branch, true);
    }
    expect(await git(remote, "show-ref")).toBe(remoteRefs);
    expect(await git(primary, "rev-parse", "refs/remotes/backup/ENG-835-rest")).toBe(await git(primary, "rev-parse", "trunk"));
  });
});

test("done reports partial removal as failure without claiming branch deletion", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const refs = (await snapshot(primary)).refs;
    const wrapperDir = join(directory, "git wrapper");
    await mkdir(wrapperDir);
    const realGit = (await execa("which", ["git"])).stdout;
    const wrapper = join(wrapperDir, "git");
    await writeFile(wrapper, [
      "#!/bin/sh",
      'if [ "$1" = update-ref ] && [ "$2" = --no-deref ] && [ "$3" = -d ]; then exit 19; fi',
      'exec "$TIMBER_REAL_GIT" "$@"', "",
    ].join("\n"));
    await chmod(wrapper, 0o755);
    const result = await execa(process.execPath, [entry, "done", path], {
      cwd: primary, reject: false, timeout: 5_000,
      env: { CI: "true", PATH: `${wrapperDir}:${process.env.PATH}`, TIMBER_REAL_GIT: realGit },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("worktree was removed");
    expect(result.stderr).toContain("was not deleted");
    expect(result.stderr).toContain("retained");
    await removed(primary, path, "feature/one", false);
    expect((await snapshot(primary)).refs).toBe(refs);
  });
});


test.each(["deleted-upstream", "offline", "no-upstream", "base-advanced", "rebase", "unpublished"])("done removes a content-integrated branch and ignored files with no flags: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const beforeCommitRemote = scenario === "unpublished" ? await upstream(primary, directory, path) : null;
    const oid = await commit(path);
    const remote = scenario === "no-upstream" ? null : beforeCommitRemote ?? await upstream(primary, directory, path);
    if (scenario === "rebase") {
      await commit(primary, "later.txt", "advance base before rebasing");
      await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "cherry-pick", oid);
    } else {
      await git(primary, "merge", "--squash", "feature/one");
      await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "squash integration");
    }
    if (scenario === "base-advanced") await commit(primary, "later.txt", "later unrelated base change");
    const ancestor = await execa("git", ["merge-base", "--is-ancestor", oid, "trunk"], { cwd: primary, reject: false });
    expect(ancestor.exitCode).toBe(1);
    if (scenario === "deleted-upstream" && remote !== null) await git(remote, "update-ref", "-d", "refs/heads/feature/one");
    if (scenario === "offline") await git(primary, "remote", "set-url", "backup", join(directory, "unavailable.git"));
    const remoteRefs = remote === null ? null : await git(remote, "for-each-ref", "--format=%(refname)%00%(objectname)");
    await writeFile(join(path, ".env"), "synthetic ignored bytes\n");
    const result = await cli(primary, path);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Deleted local branch feature/one");
    expect(result.stdout).not.toContain("synthetic ignored bytes");
    await removed(primary, path, "feature/one", true);
    if (remote !== null) expect(await git(remote, "for-each-ref", "--format=%(refname)%00%(objectname)")).toBe(remoteRefs!);
    expect(await readFile(join(primary, "feature.txt"), "utf8")).toBe("feature bytes\n");
    if (scenario === "base-advanced" || scenario === "rebase") expect(await readFile(join(primary, "later.txt"), "utf8")).toBe("feature bytes\n");
  });
});

test.each(["integrated", "reverted", "extra-work", "unrelated-history", "history-failure", "history-malformed"])("done checks historical squash integration after a base rewrite: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const originalBase = await git(primary, "rev-parse", "trunk");
    await commit(path);
    await git(primary, "merge", "--squash", "feature/one");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "squash integration");
    expect(await git(primary, "rev-parse", "HEAD^{tree}")).toBe(await git(path, "rev-parse", "HEAD^{tree}"));
    if (scenario === "unrelated-history") {
      await git(primary, "branch", "unrelated-integration");
      await git(primary, "reset", "--hard", originalBase);
    }
    if (scenario === "reverted") await git(primary, "rm", "feature.txt");
    else {
      await writeFile(join(primary, "feature.txt"), "rewritten base content\n");
      await git(primary, "add", "feature.txt");
    }
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "rewrite integrated content");
    if (scenario === "extra-work") await commit(path, "unmerged.txt");
    const before = await snapshot(primary);
    await writeFile(join(path, ".env"), "ignored content\n");

    let result;
    if (scenario === "history-failure" || scenario === "history-malformed") {
      const wrapperDir = join(directory, "git wrapper");
      await mkdir(wrapperDir);
      const realGit = (await execa("which", ["git"])).stdout;
      const headTree = await git(path, "rev-parse", "HEAD^{tree}");
      const failure = scenario === "history-failure" ? "exit 1" : 'echo invalid-tree; exit 0';
      await writeFile(join(wrapperDir, "git"), `#!/bin/sh\nif [ "$1" = log ]; then echo "$TIMBER_TEST_TREE"; ${failure}; fi\nexec "$TIMBER_REAL_GIT" "$@"\n`);
      await chmod(join(wrapperDir, "git"), 0o755);
      result = await execa(process.execPath, [entry, "done", path], {
        cwd: primary, reject: false, timeout: 5_000,
        env: { CI: "true", PATH: `${wrapperDir}:${process.env.PATH}`, TIMBER_REAL_GIT: realGit, TIMBER_TEST_TREE: headTree },
      });
    } else result = await cli(primary, path);

    if (scenario === "integrated" || scenario === "reverted") {
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      await removed(primary, path, "feature/one", true);
    } else {
      expect(result.exitCode).toBe(1);
      await retained(primary, path, before);
      expect(await readFile(join(path, ".env"), "utf8")).toBe("ignored content\n");
      expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature bytes\n");
      if (scenario === "extra-work") expect(await readFile(join(path, "unmerged.txt"), "utf8")).toBe("feature bytes\n");
    }
    if (scenario === "reverted") expect(await absent(join(primary, "feature.txt"))).toBe(true);
    else expect(await readFile(join(primary, "feature.txt"), "utf8")).toBe("rewritten base content\n");
  });
});

test.each(["extra-commit", "conflict", "unsupported-git", "unreadable-merge-config"])("done preserves work that cannot be proven integrated: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    await commit(path);
    await commit(primary, "feature.txt", "equivalent base commit");
    if (scenario === "extra-commit") await commit(path, "extra.txt", "unmerged work");
    if (scenario === "conflict") {
      await writeFile(join(primary, "feature.txt"), "different base bytes\n");
      await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-am", "base diverges");
      await writeFile(join(path, "feature.txt"), "different feature bytes\n");
      await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-am", "feature diverges");
    }
    const before = await snapshot(primary);
    const bytes = await readFile(join(path, "feature.txt"));
    await writeFile(join(path, ".env"), "preserve ignored bytes\n");
    let result;
    if (scenario === "unsupported-git" || scenario === "unreadable-merge-config") {
      const wrapperDir = join(directory, "unsupported git");
      await mkdir(wrapperDir);
      const realGit = (await execa("which", ["git"])).stdout;
      const failure = scenario === "unsupported-git"
        ? 'case " $* " in *" merge-tree "*) exit 129 ;; esac'
        : 'if [ "$1" = config ] && [ "$2" = --get-regexp ]; then exit 128; fi';
      await writeFile(join(wrapperDir, "git"), `#!/bin/sh\n${failure}\nexec "$TIMBER_REAL_GIT" "$@"\n`);
      await chmod(join(wrapperDir, "git"), 0o755);
      result = await execa(process.execPath, [entry, "done", path], {
        cwd: primary, reject: false, timeout: 5_000,
        env: { CI: "true", PATH: `${wrapperDir}:${process.env.PATH}`, TIMBER_REAL_GIT: realGit },
      });
    } else result = await cli(primary, path);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    await retained(primary, path, before);
    expect(await readFile(join(path, "feature.txt"))).toEqual(bytes);
    expect(await readFile(join(path, ".env"), "utf8")).toBe("preserve ignored bytes\n");
    if (scenario === "extra-commit") expect(await readFile(join(path, "extra.txt"), "utf8")).toBe("feature bytes\n");
  });
});


test("done refuses a custom merge driver that hides unmerged changes", async () => {
  await withRepository(async (primary, directory) => {
    await writeFile(join(primary, ".gitattributes"), "feature.txt merge=ours\n");
    await git(primary, "add", ".gitattributes");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "custom attributes");
    await git(primary, "config", "merge.ours.driver", "true");
    const path = await target(primary, directory);
    await commit(path);
    await writeFile(join(primary, "feature.txt"), "unrelated base content\n");
    await git(primary, "add", "feature.txt");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base change");
    expect(await git(primary, "merge-tree", "--write-tree", "trunk", "feature/one")).toBe(await git(primary, "rev-parse", "trunk^{tree}"));
    const before = await snapshot(primary);
    const result = await cli(primary, path);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    await retained(primary, path, before);
    expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature bytes\n");
  });
});

test.each([2, 3])("done rechecks content integration at proof %i and retains the branch on failure", async failAt => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const oid = await commit(path);
    await commit(primary, "feature.txt", "integrated base commit");
    const wrapperDir = join(directory, "proof failure git");
    await mkdir(wrapperDir);
    const realGit = (await execa("which", ["git"])).stdout;
    await writeFile(join(wrapperDir, "git"), [
      "#!/bin/sh",
      'case " $* " in',
      '  *" merge-tree "*)',
      '    proof_count=0',
      '    if [ -f "$TIMBER_PROOF_COUNT" ]; then read -r proof_count < "$TIMBER_PROOF_COUNT"; fi',
      '    proof_count=$((proof_count + 1))',
      '    printf "%s\\n" "$proof_count" > "$TIMBER_PROOF_COUNT"',
      '    if [ "$proof_count" -eq "$TIMBER_PROOF_FAIL_AT" ]; then exit 129; fi ;;',
      'esac',
      'exec "$TIMBER_REAL_GIT" "$@"', "",
    ].join("\n"));
    await chmod(join(wrapperDir, "git"), 0o755);
    const before = await snapshot(primary);
    const result = await execa(process.execPath, [entry, "done", path], {
      cwd: primary, reject: false, timeout: 5_000,
      env: {
        CI: "true", PATH: `${wrapperDir}:${process.env.PATH}`, TIMBER_REAL_GIT: realGit,
        TIMBER_PROOF_COUNT: join(directory, "proof-count"), TIMBER_PROOF_FAIL_AT: String(failAt),
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(await git(primary, "rev-parse", "refs/heads/feature/one")).toBe(oid);
    if (failAt === 2) {
      await retained(primary, path, before);
      expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature bytes\n");
    } else {
      expect(result.stderr).toContain("worktree was removed");
      expect(result.stderr).toContain("was not deleted");
      await removed(primary, path, "feature/one", false);
    }
  });
});


test("done retains a detached squash-equivalent commit without ancestry", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    await commit(path);
    await commit(primary, "feature.txt", "squash equivalent base");
    await git(path, "checkout", "--detach");
    const before = await snapshot(primary);
    const result = await cli(primary, path);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    await retained(primary, path, before);
    expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature bytes\n");
  });
});

async function mergedIntoParent(primary: string, directory: string, squash = false, rebase = false) {
  await git(primary, "checkout", "-b", "feature/parent");
  await commit(primary, "parent.txt", "parent work absent from trunk");
  const path = await target(primary, directory);
  const child = await commit(path);
  if (rebase) {
    await commit(primary, "parent-next.txt", "advance parent");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "cherry-pick", child);
  } else {
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid",
      "merge", squash ? "--squash" : "--ff-only", "feature/one");
  }
  if (squash) await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "integrate child");
  return { path, child };
}

test.each(["merge", "squash", "rebase", "keep-branch"])("done uses the saved epic base instead of config: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const { path, child } = await mergedIntoParent(primary, directory, scenario === "squash", scenario === "rebase");
    await saveBase(primary, path, "refs/heads/feature/parent");
    const parent = await git(primary, "rev-parse", "feature/parent");
    const trunk = await git(primary, "rev-parse", "trunk");
    const config = await readFile(join(primary, ".timber.toml"));
    const result = await cli(primary, path, ...(scenario === "keep-branch" ? ["--keep-branch"] : []));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    await removed(primary, path, "feature/one", scenario !== "keep-branch");
    if (scenario === "keep-branch") expect(await git(primary, "rev-parse", "feature/one")).toBe(child);
    expect(await git(primary, "rev-parse", "feature/parent")).toBe(parent);
    expect(await git(primary, "rev-parse", "trunk")).toBe(trunk);
    expect(await readFile(join(primary, ".timber.toml"))).toEqual(config);
  });
});

test("done explicit base overrides the saved choice without rewriting it", async () => {
  await withRepository(async (primary, directory) => {
    const { path } = await mergedIntoParent(primary, directory);
    const file = await saveBase(primary, path, "refs/heads/trunk");
    const record = await readFile(file, "utf8");
    const before = await snapshot(primary);
    expect((await cli(primary, path)).exitCode).toBe(1);
    await retained(primary, path, before);
    expect(await readFile(file, "utf8")).toBe(record);
    const result = await cli(primary, path, "--base", "refs/heads/feature/parent");
    expect(result.exitCode).toBe(0);
    await removed(primary, path, "feature/one", true);
  });
});

test.each(["missing", "missing-local-shadow", "missing-remote-shadow", "self", "malformed", "stale"])("done refuses a %s saved base even with published work", async scenario => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    await upstream(primary, directory, path);
    const file = await saveBase(primary, path, scenario === "self" ? "refs/heads/feature/one" : "refs/heads/trunk");
    if (scenario.startsWith("missing")) {
      const ref = scenario === "missing-remote-shadow" ? "refs/remotes/backup/missing" : "refs/heads/missing";
      if (scenario !== "missing") await git(primary, "branch", ref);
      const record = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...record, ref }));
    } else if (scenario === "malformed") await writeFile(file, "invalid JSON");
    else if (scenario === "stale") {
      const record = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...record, worktreePath: primary }));
    }
    const record = await readFile(file, "utf8");
    const before = await snapshot(primary);
    const result = await cli(primary, path, "--keep-branch");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/base/i);
    await retained(primary, path, before);
    expect(await readFile(file, "utf8")).toBe(record);
    const override = await cli(primary, path, "--base", "refs/heads/trunk");
    expect(override.exitCode).toBe(scenario === "malformed" ? 1 : 0);
    if (scenario === "malformed") await retained(primary, path, before);
    else await removed(primary, path, "feature/one", true);
  });
});

test("done rechecks the saved base association after hooks even when both bases contain the branch", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const file = await saveBase(primary, path, "refs/heads/trunk");
    await git(primary, "branch", "other");
    const hook = join(directory, "change-base.sh");
    // In-place sed flags differ between GNU and BSD, so rewrite through a temporary file.
    await writeFile(hook, 'sed "s@refs/heads/trunk@refs/heads/other@" "$TIMBER_BASE_RECORD" > "$TIMBER_BASE_RECORD.next" && mv "$TIMBER_BASE_RECORD.next" "$TIMBER_BASE_RECORD"\n');
    await writeFile(join(primary, ".timber.toml"), `base_branch = "trunk"\n[hooks]\npre_delete = ['sh "${hook}"']\n`);
    const before = await snapshot(primary);
    const result = await execa(process.execPath, [entry, "done", path], {
      cwd: primary, reject: false, timeout: 5_000, env: { CI: "true", TIMBER_BASE_RECORD: file },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/base.*changed/i);
    await retained(primary, path, before);
  });
});

test.each(["merge", "squash", "rebase", "keep-branch", "remote"])("done uses an explicit non-default base without changing TOML: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const { path, child } = await mergedIntoParent(primary, directory, scenario === "squash", scenario === "rebase");
    const config = await readFile(join(primary, ".timber.toml"));
    const parent = await git(primary, "rev-parse", "feature/parent");
    const trunk = await git(primary, "rev-parse", "trunk");
    const before = await snapshot(primary);
    const refused = await cli(primary, path);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("--base");
    await retained(primary, path, before);
    let base = "feature/parent";
    if (scenario === "remote") {
      await git(directory, "init", "--bare", join(directory, "remote.git"));
      await git(primary, "remote", "add", "backup", join(directory, "remote.git"));
      await git(primary, "push", "backup", "feature/parent");
      base = "backup/feature/parent";
    }
    const result = await cli(primary, path, "--base", base, ...(scenario === "keep-branch" ? ["--keep-branch"] : []));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    await removed(primary, path, "feature/one", scenario !== "keep-branch");
    if (scenario === "keep-branch") expect(await git(primary, "rev-parse", "feature/one")).toBe(child);
    expect(await git(primary, "rev-parse", "feature/parent")).toBe(parent);
    expect(await git(primary, "rev-parse", "trunk")).toBe(trunk);
    expect(await readFile(join(primary, ".timber.toml"))).toEqual(config);
  });
});

test.each(["absent", "--bad", "feature/one", "refs/heads/feature/one", "ambiguous"])("done rejects explicit invalid/self base even with published work: %s", async base => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    await commit(path);
    await upstream(primary, directory, path);
    if (base === "ambiguous") {
      await git(primary, "remote", "add", "second", join(directory, "upstream.git"));
      await git(primary, "update-ref", "refs/remotes/second/ambiguous", "HEAD");
      await git(primary, "update-ref", "refs/remotes/backup/ambiguous", "HEAD");
    }
    const before = await snapshot(primary);
    const result = await cli(primary, path, "--keep-branch", "--base=" + base);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/base/i);
    await retained(primary, path, before);
    expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature bytes\n");
  });
});

test.each(["wrong-base", "dirty", "untracked", "keep-ignored"])("done explicit base preserves unsafe work: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const { path } = await mergedIntoParent(primary, directory);
    const name = scenario === "dirty" ? "tracked.txt" : scenario === "untracked" ? "untracked.txt" : ".env";
    await writeFile(join(path, name), "preserve bytes\n");
    const before = await snapshot(primary);
    const result = await cli(primary, path, "--base", scenario === "wrong-base" ? "trunk" : "feature/parent",
      ...(scenario === "keep-ignored" ? ["--keep-ignored"] : []));
    expect(result.exitCode).toBe(1);
    await retained(primary, path, before);
    expect(await readFile(join(path, name), "utf8")).toBe("preserve bytes\n");
  });
});

// A moving selected base must be caught even if publication independently permits cleanup.
test.each([
  ["explicit", "hook"], ["explicit", "after-remove"], ["saved", "hook"], ["saved", "after-remove"],
])("done revalidates %s base at %s and preserves the branch", async (selection, phase) => {
  await withRepository(async (primary, directory) => {
    const { path, child } = await mergedIntoParent(primary, directory);
    if (selection === "saved") await saveBase(primary, path, "refs/heads/feature/parent");
    const flags = selection === "explicit" ? ["--base", "feature/parent"] : [];
    await upstream(primary, directory, path);
    const trunk = await git(primary, "rev-parse", "trunk");
    const before = await snapshot(primary);
    let result;
    if (phase === "hook") {
      await writeFile(join(primary, ".timber.toml"), `base_branch = "trunk"\n[hooks]\npre_delete = ['git update-ref refs/heads/feature/parent refs/heads/trunk']\n`);
      result = await cli(primary, path, ...flags);
    } else {
      const wrapperDir = join(directory, "base race git");
      await mkdir(wrapperDir);
      const realGit = (await execa("which", ["git"])).stdout;
      await writeFile(join(wrapperDir, "git"), [
        "#!/bin/sh",
        'if [ "$1" = worktree ] && [ "$2" = remove ]; then',
        '  "$TIMBER_REAL_GIT" "$@" || exit "$?"',
        '  "$TIMBER_REAL_GIT" update-ref refs/heads/feature/parent refs/heads/trunk',
        '  exit "$?"',
        'fi',
        'exec "$TIMBER_REAL_GIT" "$@"', "",
      ].join("\n"));
      await chmod(join(wrapperDir, "git"), 0o755);
      result = await execa(process.execPath, [entry, "done", path, ...flags], {
        cwd: primary, reject: false, timeout: 5_000,
        env: { CI: "true", PATH: `${wrapperDir}:${process.env.PATH}`, TIMBER_REAL_GIT: realGit },
      });
    }
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/base.*changed/i);
    expect(await git(primary, "rev-parse", "feature/one")).toBe(child);
    expect(await git(primary, "rev-parse", "feature/parent")).toBe(trunk);
    expect(await git(primary, "rev-parse", "trunk")).toBe(trunk);
    if (phase === "hook") {
      expect(await absent(path)).toBe(false);
      expect((await snapshot(primary)).trees.replace(/HEAD [0-9a-f]+/gu, "HEAD"))
        .toBe(before.trees.replace(/HEAD [0-9a-f]+/gu, "HEAD"));
      expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature bytes\n");
    } else {
      expect(result.stderr).toContain("worktree was removed");
      await removed(primary, path, "feature/one", false);
    }
  });
});


test.each(["explicit", "saved", "configured", "default"])("done refreshes a stale remote base automatically: %s", async selection => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const remote = join(directory, "base.git");
    await git(directory, "init", "--bare", remote);
    await git(primary, "remote", "add", "backup", remote);
    await git(primary, "push", "backup", "trunk");
    const original = await git(primary, "rev-parse", "trunk");
    const feature = await commit(path);
    // A separate checkout merges on the server without refreshing our cached base.
    const publisher = join(directory, "publisher");
    await git(directory, "clone", "--branch", "feature/one", primary, publisher);
    const tip = await commit(publisher, "later.txt", "later server change");
    await git(publisher, "push", remote, "HEAD:refs/heads/trunk");
    await git(publisher, "tag", "server-only-tag");
    await git(publisher, "push", remote, "refs/tags/server-only-tag");
    expect((await execa("git", ["cat-file", "-e", tip], { cwd: primary, reject: false })).exitCode).not.toBe(0);
    expect(feature).not.toBe(tip);
    expect(await git(primary, "rev-parse", "backup/trunk")).toBe(original);
    await git(primary, "symbolic-ref", "refs/remotes/backup/HEAD", "refs/remotes/backup/trunk");
    const config = selection === "configured" ? 'base_branch = "backup/trunk"\n'
      : selection === "saved" ? 'base_branch = "refs/heads/trunk"\n' : "";
    await writeFile(join(primary, ".timber.toml"), config);
    if (selection === "saved") await saveBase(primary, path, "refs/remotes/backup/trunk");
    const remoteRefs = await git(remote, "show-ref");

    const result = await cli(primary, path, ...(selection === "explicit" ? ["--base", "backup/trunk"] : []));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    await removed(primary, path, "feature/one", true);
    expect(await git(primary, "rev-parse", "backup/trunk")).toBe(tip);
    expect(await git(primary, "rev-parse", "trunk")).toBe(original);
    expect(await git(primary, "tag", "--list")).toBe("");
    expect(await git(remote, "show-ref")).toBe(remoteRefs);
    expect(await readFile(join(primary, ".timber.toml"), "utf8")).toBe(config);
  });
});

test.each(["explicit", "saved", "configured", "default"])("done retains integrated work when its remote base cannot refresh: %s", async selection => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const remote = await upstream(primary, directory, path);
    await git(primary, "push", "backup", "trunk");
    await git(primary, "symbolic-ref", "refs/remotes/backup/HEAD", "refs/remotes/backup/trunk");
    const marker = join(directory, "hook-ran");
    const config = selection === "configured" ? 'base_branch = "backup/trunk"\n'
      : selection === "saved" ? 'base_branch = "refs/heads/trunk"\n' : "";
    await writeFile(join(primary, ".timber.toml"), config + `[hooks]\npre_delete = ['touch "${marker}"']\n`);
    if (selection === "saved") await saveBase(primary, path, "refs/remotes/backup/feature/one");
    await git(primary, "remote", "set-url", "backup", join(directory, "unavailable.git"));
    await writeFile(join(path, ".env"), "preserve ignored bytes\n");
    const before = await snapshot(primary);
    const remoteRefs = await git(remote, "show-ref");

    const result = await cli(primary, path, ...(selection === "explicit" ? ["--base", "backup/trunk"] : []));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/refresh|fetch/i);
    await retained(primary, path, before);
    expect(await absent(marker)).toBe(true);
    expect(await readFile(join(path, ".env"), "utf8")).toBe("preserve ignored bytes\n");
    expect(await git(remote, "show-ref")).toBe(remoteRefs);
  });
});


test.each(["deleted", "fetch-fails", "remote-moves", "tracking-moves", "symbolic"])("done preserves local work on remote base refresh failure: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const remote = await upstream(primary, directory, path);
    await git(primary, "push", "backup", "trunk");
    const original = await git(primary, "rev-parse", "trunk");
    const tip = await commit(path);
    const publisher = join(directory, "publisher");
    await git(directory, "clone", "--branch", "feature/one", primary, publisher);
    await git(publisher, "push", remote, "HEAD:refs/heads/trunk");
    // Keep publication independently valid, to ensure it cannot bypass a failed refresh.
    await git(path, "push", "backup", "feature/one");
    await git(primary, "symbolic-ref", "refs/remotes/backup/HEAD", "refs/remotes/backup/trunk");
    const marker = join(directory, "hook-ran");
    await writeFile(join(primary, ".timber.toml"), `[hooks]\npre_delete = ['touch "${marker}"']\n`);
    await writeFile(join(path, ".env"), "preserve ignored bytes\n");
    if (scenario === "deleted") await git(remote, "update-ref", "-d", "refs/heads/trunk");
    if (scenario === "symbolic") await git(primary, "symbolic-ref", "refs/remotes/backup/trunk", "refs/heads/trunk");
    const wrapperDir = join(directory, "refresh git");
    await mkdir(wrapperDir);
    const realGit = (await execa("which", ["git"])).stdout;
    await writeFile(join(wrapperDir, "git"), [
      "#!/bin/sh",
      'if [ "$1" = fetch ]; then',
      scenario === "fetch-fails" ? '  exit 19' :
      scenario === "remote-moves" ? '  "$TIMBER_REAL_GIT" -C "$TIMBER_TEST_REMOTE" update-ref refs/heads/trunk "$TIMBER_TEST_OLD"' : "  :",
      '  "$TIMBER_REAL_GIT" "$@" || exit "$?"',
      scenario === "tracking-moves" ? '  "$TIMBER_REAL_GIT" update-ref refs/remotes/backup/trunk "$TIMBER_TEST_TIP"' : "  :",
      '  exit 0', 'fi', 'exec "$TIMBER_REAL_GIT" "$@"', "",
    ].join("\n"));
    await chmod(join(wrapperDir, "git"), 0o755);
    const before = await snapshot(primary);
    const result = await execa(process.execPath, [entry, "done", path], {
      cwd: primary, reject: false, timeout: 5_000,
      env: { CI: "true", PATH: `${wrapperDir}:${process.env.PATH}`, TIMBER_REAL_GIT: realGit,
        TIMBER_TEST_REMOTE: remote, TIMBER_TEST_OLD: original, TIMBER_TEST_TIP: tip },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/refresh/i);
    expect(await absent(path)).toBe(false);
    expect((await snapshot(primary)).trees).toBe(before.trees);
    if (scenario !== "tracking-moves") expect((await snapshot(primary)).refs).toBe(before.refs);
    else expect(await git(primary, "rev-parse", "backup/trunk")).toBe(tip);
    expect(await git(primary, "rev-parse", "trunk")).toBe(original);
    expect(await git(path, "rev-parse", "HEAD")).toBe(tip);
    expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature bytes\n");
    expect(await readFile(join(path, ".env"), "utf8")).toBe("preserve ignored bytes\n");
    expect(await absent(marker)).toBe(true);
  });
});

for (const answer of ["2\n", "\n", "q\n", "\u0003"]) test(`interactive done discard handles ${JSON.stringify(answer)}`, async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    await commit(path);
    await writeFile(join(path, "tracked.txt"), "local edit\n");
    await writeFile(join(path, "scratch.txt"), "local scratch\n");
    const before = await snapshot(primary);
    const payload = join(directory, "done terminal.json");
    await writeFile(payload, JSON.stringify({
      cwd: primary, command: [process.execPath, entry, "done", "feature/one"],
      sendAt: "Choose 1-2, or q to cancel:", input: answer,
      env: { XDG_CONFIG_HOME: join(directory, "isolated config") },
    }));
    const child = await execa("python3", [fileURLToPath(new URL("./helpers/pty-runner.py", import.meta.url)), payload]);
    const result = JSON.parse(child.stdout) as { exitCode: number; output: string };
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Delete anyway?");
    expect(result.output).toContain("modified and untracked files");
    expect(result.output).toContain("default");
    if (answer === "2\n") {
      await removed(primary, path, "feature/one", true);
      expect(result.output).toContain("Deleted local branch feature/one");
    } else {
      await retained(primary, path, before);
      expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("local edit\n");
      expect(await readFile(join(path, "scratch.txt"), "utf8")).toBe("local scratch\n");
      expect(result.output).toContain("Cancelled.");
    }
  });
});
