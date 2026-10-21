import { expect, test } from "bun:test";
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, ...args: string[]) => execa(process.execPath, ["--no-env-file", entry, ...args], {
  cwd, reject: false, timeout: 10_000, env: { CI: "true", GIT_EDITOR: "false", GIT_SEQUENCE_EDITOR: "false" },
});

async function commit(cwd: string, name: string, contents: string | Uint8Array) {
  await writeFile(join(cwd, name), contents);
  await git(cwd, "add", "-f", "--", name);
  await git(cwd, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "test change");
  return git(cwd, "rev-parse", "HEAD");
}

async function fixture(primary: string, directory: string) {
  await git(primary, "config", "user.name", "Timber Test");
  await git(primary, "config", "user.email", "test@example.invalid");
  const remote = join(directory, "remote.git");
  await git(directory, "init", "--bare", remote);
  await git(primary, "remote", "add", "origin", remote);
  await git(primary, "push", "origin", "trunk:main");
  await git(primary, "branch", "main");
  const publisher = join(directory, "publisher");
  await git(directory, "clone", "--branch", "main", remote, publisher);
  const target = join(directory, "feature 'worktree");
  await git(primary, "worktree", "add", "-b", "TIM-28-feature", target);
  await writeFile(join(primary, ".timber.toml"), 'base_branch = "main"\n');
  await appendFile(join(primary, ".git/info/exclude"), '\n.timber.toml\n');
  return { remote, publisher, target };
}

async function advance(publisher: string, name = "incoming.txt", contents: string | Uint8Array = "new base\n") {
  const oid = await commit(publisher, name, contents);
  await git(publisher, "push", "origin", "main");
  return oid;
}

async function paused(target: string) {
  const path = await git(target, "rev-parse", "--git-path", "rebase-merge");
  return Bun.file(join(path, "head-name")).exists();
}

// A stale cache must never let rebase silently use the previous remote base.
test("rebase fetches fresh remote base, rewrites only selected branch, and supports up-to-date rerun", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const original = await commit(target, "feature.txt", "feature\n");
    await git(primary, "branch", "same-tip", original);
    await git(primary, "config", "rebase.updateRefs", "true");
    await git(primary, "config", "rebase.autoStash", "true");
    const localMain = await git(primary, "rev-parse", "main");
    const stale = await git(primary, "rev-parse", "origin/main");
    const incoming = await advance(publisher);
    expect(incoming).not.toBe(stale);
    await writeFile(join(primary, "tracked.txt"), "unrelated dirty\n");
    await writeFile(join(primary, "untracked.txt"), "untracked\n");
    await writeFile(join(target, ".env"), "preserve ignored\n");
    const result = await cli(primary, "rebase", "TIM-28");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(incoming);
    expect(result.stdout).toContain("origin/main");
    expect(result.stdout).toContain(target);
    expect(await git(target, "rev-parse", "HEAD^")).toBe(incoming);
    expect(await git(primary, "rev-parse", "main")).toBe(localMain);
    expect(await git(primary, "rev-parse", "same-tip")).toBe(original);
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("unrelated dirty\n");
    expect(await readFile(join(primary, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(await readFile(join(target, ".env"), "utf8")).toBe("preserve ignored\n");
    const rebased = await git(target, "rev-parse", "HEAD");
    expect((await cli(primary, "rebase", target)).exitCode).toBe(0);
    expect(await git(target, "rev-parse", "HEAD")).toBe(rebased);
  });
});

test.each(["staged", "unstaged", "untracked", "detached", "missing", "merge", "cherry-pick", "revert", "am", "sequencer"])("rebase refuses %s targets before fetching", async scenario => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const before = await git(primary, "show-ref");
    const initial = await git(target, "rev-parse", "HEAD");
    const gitDir = await git(target, "rev-parse", "--absolute-git-dir");
    if (["staged", "unstaged", "untracked"].includes(scenario)) {
      await writeFile(join(target, scenario === "untracked" ? "new.txt" : "tracked.txt"), "preserve me\n");
      if (scenario === "staged") await git(target, "add", "tracked.txt");
    } else if (scenario === "detached") await git(target, "checkout", "--detach");
    else if (scenario === "missing") await rm(target, { recursive: true });
    else if (scenario === "am" || scenario === "sequencer") await mkdir(join(gitDir, scenario === "am" ? "rebase-apply" : "sequencer"));
    else await writeFile(join(gitDir, ({ merge: "MERGE_HEAD", "cherry-pick": "CHERRY_PICK_HEAD", revert: "REVERT_HEAD" } as Record<string, string>)[scenario]!), initial + "\n");
    await advance(publisher);
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(["staged", "unstaged", "untracked"].includes(scenario)
      ? /clean index/ : scenario === "detached" ? /detached/ : scenario === "missing" ? /missing|stale/ : /in progress/);
    expect(await git(primary, "show-ref")).toBe(before);
    if (["staged", "unstaged", "untracked"].includes(scenario)) {
      expect(await readFile(join(target, scenario === "untracked" ? "new.txt" : "tracked.txt"), "utf8")).toBe("preserve me\n");
      expect(await git(target, "rev-parse", "HEAD")).toBe(initial);
    }
  });
});

test.each([".env", "ignored-dir", "intermediate"])("rebase preserves ignored collision: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    if (scenario === "ignored-dir") {
      await appendFile(join(primary, ".git/info/exclude"), "ignored-dir/\n");
      await mkdir(join(target, "ignored-dir"));
      await writeFile(join(target, "ignored-dir/local"), "keep\n");
    } else await writeFile(join(target, ".env"), "keep\n");
    if (scenario === "intermediate") {
      await commit(publisher, ".env", "temporary incoming\n");
      await git(publisher, "rm", ".env");
      await git(publisher, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "remove temporary");
      // The base tip doesn't contain .env; only replaying this branch introduces it.
      await git(publisher, "push", "origin", "main:replay");
      await git(primary, "fetch", "origin", "replay");
      await git(target, "update-ref", "refs/heads/TIM-28-feature", await git(publisher, "rev-parse", "HEAD"));
      // Restore a clean index/worktree without touching the ignored file.
      await git(target, "read-tree", "HEAD");
      await git(publisher, "checkout", "-b", "clean-base", "HEAD~2");
      await commit(publisher, "incoming.txt", "separate base change\n");
      await git(publisher, "push", "origin", "clean-base:base");
    } else await advance(publisher, scenario, "incoming\n");
    const before = await git(target, "rev-parse", "HEAD");
    const result = await cli(primary, "rebase", target, "--base", scenario === "intermediate" ? "origin/base" : "origin/main");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ignored|overwrite/i);
    expect(await git(target, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(target, scenario === "ignored-dir" ? "ignored-dir/local" : ".env"), "utf8")).toBe("keep\n");
    expect(await paused(target)).toBe(false);
  });
});

test.each(["text", "binary", "delete", "control"])("rebase leaves %s conflicts paused, refuses restart/cleanup, and supports manual continue", async scenario => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const name = scenario === "control" ? "odd \n'\tname" : "tracked.txt";
    if (scenario === "delete") {
      await git(target, "rm", name);
      await git(target, "commit", "-m", "delete");
    } else await commit(target, name, scenario === "binary" ? new Uint8Array([0, 1, 2]) : "feature\n");
    const original = await git(target, "rev-parse", "HEAD");
    await advance(publisher, name, scenario === "binary" ? new Uint8Array([0, 3, 4]) : "incoming\n");
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("conflict");
    expect(result.stderr).toContain("rebase --continue");
    expect(result.stderr).toContain("rebase --abort");
    expect(result.stderr).toContain(scenario === "control" ? "\\n" : name);
    expect(result.stderr).not.toContain(name === "tracked.txt" ? "RAW_PRIVATE_HOOK" : name);
    expect(await paused(target)).toBe(true);
    expect(await git(target, "diff", "--name-only", "--diff-filter=U", "-z")).toBe(name + "\0");
    expect((await cli(primary, "rebase", target)).stderr).toContain("rebase --continue");
    expect((await cli(primary, "rebase", "TIM-28-feature")).stderr).toContain("rebase --continue");
    await writeFile(join(target, name), "resolved\n");
    await git(target, "add", "--", name);
    const staged = await git(target, "diff", "--cached", "--binary");
    expect((await cli(primary, "done", target, "--keep-branch")).exitCode).toBe(1);
    expect(await paused(target)).toBe(true);
    expect(await git(target, "diff", "--cached", "--binary")).toBe(staged);
    await execa("git", ["rebase", "--continue"], { cwd: target, env: { GIT_EDITOR: "true" } });
    expect(await paused(target)).toBe(false);
    expect(await git(target, "rev-parse", "HEAD")).not.toBe(original);
    expect(await readFile(join(target, name), "utf8")).toBe("resolved\n");
  });
});

test("explicit abort restores original commit and files", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const original = await commit(target, "tracked.txt", "feature\n");
    await advance(publisher, "tracked.txt", "base\n");
    expect((await cli(primary, "rebase", target)).exitCode).toBe(1);
    expect(await paused(target)).toBe(true);
    await git(target, "rebase", "--abort");
    expect(await git(target, "rev-parse", "HEAD")).toBe(original);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("feature\n");
  });
});

test.each(["missing", "deleted", "offline", "ambiguous-remote", "ambiguous-base"])("rebase refuses %s remote/base without touching branch", async scenario => {
  await withRepository(async (primary, directory) => {
    const { remote, publisher, target } = await fixture(primary, directory);
    const before = await git(primary, "show-ref");
    const initial = await git(target, "rev-parse", "HEAD");
    if (scenario === "deleted") await git(publisher, "push", "origin", "--delete", "main");
    if (scenario === "offline") await rm(remote, { recursive: true });
    if (scenario === "ambiguous-remote") await git(primary, "remote", "add", "backup", remote);
    if (scenario === "ambiguous-base") {
      await git(publisher, "push", "origin", "main:master");
      await git(primary, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/unknown-default");
      await writeFile(join(primary, ".timber.toml"), "");
    }
    const result = await cli(primary, "rebase", target, ...(scenario === "missing" ? ["--base", "origin/absent"] : []));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("unknown command");
    expect(await git(primary, "show-ref")).toBe(before);
    expect(await git(target, "rev-parse", "HEAD")).toBe(initial);
    expect(await paused(target)).toBe(false);
  });
});

test("explicit remote base overrides configured remote and base; Git hook failure is not a conflict", async () => {
  await withRepository(async (primary, directory) => {
    const { remote, publisher, target } = await fixture(primary, directory);
    await commit(target, "feature.txt", "feature\n");
    const incoming = await advance(publisher);
    await git(primary, "remote", "add", "backup", remote);
    await writeFile(join(primary, ".timber.toml"), 'remote = "missing-configured-remote"\nbase_branch = "absent"\n');
    const hook = join(primary, ".git/hooks/pre-rebase");
    await writeFile(hook, "#!/bin/sh\nprintf 'RAW_PRIVATE_HOOK' >&2\nexit 1\n"); await chmod(hook, 0o755);
    const original = await git(target, "rev-parse", "HEAD");
    const result = await cli(primary, "rebase", target, "--base", "backup/main");
    // Git versions return different statuses when a pre-rebase hook rejects.
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain("Git rebase failed");
    expect(result.stdout).toContain(incoming);
    expect(result.stderr).not.toContain("paused with conflicts");
    expect(result.stderr).not.toContain("RAW_PRIVATE_HOOK");
    expect(await git(target, "rev-parse", "HEAD")).toBe(original);
    expect(await paused(target)).toBe(false);
  });
});

test("cleanup refuses a paused rebase after staging a resolution identical to the base", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    await commit(target, "tracked.txt", "feature\n");
    await advance(publisher, "tracked.txt", "incoming\n");
    expect((await cli(primary, "rebase", target)).exitCode).toBe(1);
    await git(target, "checkout", "--ours", "tracked.txt");
    await git(target, "add", "tracked.txt");
    expect(await git(target, "status", "--porcelain=v1")).toBe("");
    const result = await cli(primary, "done", target, "--keep-branch", "--base", "origin/main");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("in-progress rebase");
    expect(await paused(target)).toBe(true);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("incoming\n");
  });
});

test.each(["configured-remote", "remote-default", "remote-fallback", "explicit-plain", "explicit-qualified"])("rebase base precedence: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const { remote, publisher, target } = await fixture(primary, directory);
    const incoming = await advance(publisher);
    if (scenario === "configured-remote") {
      await git(primary, "remote", "add", "other", remote);
      await writeFile(join(primary, ".timber.toml"), 'remote = "origin"\nbase_branch = "main"\n');
    } else if (scenario === "explicit-qualified") {
      await git(primary, "remote", "add", "backup", remote);
      await writeFile(join(primary, ".timber.toml"), 'remote = "origin"\nbase_branch = "absent"\n');
    } else if (scenario === "remote-default") {
      await git(primary, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
      await writeFile(join(primary, ".timber.toml"), "");
    } else if (scenario === "remote-fallback") await writeFile(join(primary, ".timber.toml"), "");
    else await writeFile(join(primary, ".timber.toml"), 'base_branch = "absent"\n');
    const result = await cli(primary, "rebase", target, ...(scenario === "explicit-plain" ? ["--base", "main"] : scenario === "explicit-qualified" ? ["--base", "backup/main"] : []));
    expect(result.exitCode).toBe(0);
    expect(await git(target, "rev-parse", "HEAD")).toBe(incoming);
  });
});

async function gitWrapper(directory: string, body: string) {
  const real = (await execa("which", ["git"])).stdout;
  const bin = join(directory, "wrapper"); await mkdir(bin);
  await writeFile(join(bin, "git"), "#!/bin/sh\n" + body + '\nexec "$TIMBER_TEST_GIT" "$@"\n');
  await chmod(join(bin, "git"), 0o755);
  return { PATH: bin + ":" + process.env.PATH, TIMBER_TEST_GIT: real };
}

test.each(["fetch-fails", "branch-moves", "files-change", "git-startup", "interrupt"])("rebase preserves work on boundary failure: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const original = await commit(target, "feature.txt", "feature\n");
    const incoming = await advance(publisher);
    const cached = await git(primary, "rev-parse", "origin/main");
    const body = scenario === "fetch-fails" ? 'if [ "$1" = fetch ]; then exit 19; fi' :
      scenario === "branch-moves" || scenario === "files-change" ? [
        'if [ "$1" = fetch ]; then',
        '  "$TIMBER_TEST_GIT" "$@" || exit $?',
        scenario === "branch-moves" ? '  "$TIMBER_TEST_GIT" -C "$TIMBER_TEST_TARGET" -c user.name="Timber Test" -c user.email=test@example.invalid commit --allow-empty -m concurrent' :
          '  printf "concurrent bytes\\n" > "$TIMBER_TEST_TARGET/new.txt"',
        '  exit 0', 'fi',
      ].join("\n") : [
        'case " $* " in',
        '  *" rebase "*) ' + (scenario === "git-startup" ? 'printf "RAW_PRIVATE_ERROR" >&2; exit 42' : 'kill -TERM $$') + ' ;;',
        'esac',
      ].join("\n");
    const env = await gitWrapper(directory, body);
    const result = await execa(process.execPath, ["--no-env-file", entry, "rebase", target], {
      cwd: primary, reject: false, timeout: 10_000, env: { ...env, CI: "true", TIMBER_TEST_TARGET: target },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain("RAW_PRIVATE_ERROR");
    expect(result.stderr).not.toContain("paused with conflicts");
    expect(await paused(target)).toBe(false);
    if (scenario === "branch-moves") {
      expect(await git(target, "rev-parse", "HEAD^")).toBe(original);
      expect(result.stderr).toContain("changed");
    } else expect(await git(target, "rev-parse", "HEAD")).toBe(original);
    if (scenario === "files-change") expect(await readFile(join(target, "new.txt"), "utf8")).toBe("concurrent bytes\n");
    expect(await git(primary, "rev-parse", "origin/main")).toBe(cached);
    expect(await readFile(join(target, "feature.txt"), "utf8")).toBe("feature\n");
    if (scenario === "interrupt") { expect(result.exitCode).toBe(143); expect(result.stderr).toContain("SIGTERM"); }
    if (scenario === "git-startup") expect(result.exitCode).toBe(42);
  });
});

test("native continuation can stop again at a later conflicting commit", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    await commit(target, "tracked.txt", "feature first\n");
    await commit(target, "tracked.txt", "feature second\n");
    await advance(publisher, "tracked.txt", "base\n");
    expect((await cli(primary, "rebase", target)).exitCode).toBe(1);
    await writeFile(join(target, "tracked.txt"), "first resolution\n"); await git(target, "add", "tracked.txt");
    const continued = await execa("git", ["rebase", "--continue"], { cwd: target, reject: false, env: { GIT_EDITOR: "true" } });
    expect(continued.exitCode).toBe(1);
    expect(await paused(target)).toBe(true);
    expect(await git(target, "diff", "--name-only", "--diff-filter=U", "-z")).toBe("tracked.txt\0");
    await writeFile(join(target, "tracked.txt"), "second resolution\n"); await git(target, "add", "tracked.txt");
    await execa("git", ["rebase", "--continue"], { cwd: target, env: { GIT_EDITOR: "true" } });
    expect(await paused(target)).toBe(false);
  });
});

test("rebase refuses a branch checked out in another worktree even with an exact path", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    await commit(target, "feature.txt", "feature\n");
    const other = join(directory, "duplicate");
    await git(primary, "worktree", "add", "--force", other, "TIM-28-feature");
    await writeFile(join(other, "tracked.txt"), "other work\n");
    await advance(publisher);
    const before = await git(primary, "show-ref");
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("another worktree");
    expect(await git(primary, "show-ref")).toBe(before);
    expect(await readFile(join(other, "tracked.txt"), "utf8")).toBe("other work\n");
  });
});

test("an already integrated base leaves ignored files at previously tracked paths intact", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await fixture(primary, directory);
    await commit(target, ".env", "old tracked bytes\n");
    await git(target, "rm", ".env"); await git(target, "commit", "-m", "remove tracked env");
    await writeFile(join(target, ".env"), "private local bytes\n");
    const before = await git(target, "rev-parse", "HEAD");
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(0);
    expect(await git(target, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(target, ".env"), "utf8")).toBe("private local bytes\n");
  });
});

test("interrupting Timber stops its owned Git hook descendants without later side effects", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const original = await commit(target, "feature.txt", "feature\n"); await advance(publisher);
    const started = join(directory, "started"), escaped = join(directory, "escaped");
    const release = join(directory, "release");
    const hook = join(primary, ".git/hooks/pre-rebase");
    await writeFile(hook, '#!/bin/sh\nexec >/dev/null 2>&1\n: > "$TIMBER_TEST_STARTED"\nwhile [ ! -e "$TIMBER_TEST_RELEASE" ]; do sleep 0.01; done\n: > "$TIMBER_TEST_ESCAPED"\n');
    await chmod(hook, 0o755);
    const child = execa(process.execPath, ["--no-env-file", entry, "rebase", target], {
      cwd: primary, reject: false, timeout: 8_000, env: { CI: "true", TIMBER_TEST_STARTED: started, TIMBER_TEST_ESCAPED: escaped, TIMBER_TEST_RELEASE: release },
    });
    try {
      for (let i = 0; i < 200 && !await Bun.file(started).exists(); i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(await Bun.file(started).exists()).toBe(true);
      // Hook startup alone does not prove native signal readiness. Wait until
      // Linux reports a caught SIGTERM; do not rely on a fixed startup delay.
      const deadline = Date.now() + 2_000;
      let handlesTermination = false;
      while (Date.now() < deadline) {
        const status = await readFile(`/proc/${child.pid}/status`, "utf8");
        const caught = /^SigCgt:\s*([0-9a-f]+)$/mi.exec(status)?.[1];
        handlesTermination = caught !== undefined && (BigInt(`0x${caught}`) & (1n << BigInt(constants.signals.SIGTERM - 1))) !== 0n;
        if (handlesTermination) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(handlesTermination).toBe(true);
      process.kill(child.pid!, "SIGTERM");
      const result = await child;
      expect(result.exitCode).toBe(143);
      expect(result.stderr).toContain("SIGTERM");
      // A surviving hook would now continue and write escaped. Keep it blocked
      // until Timber exits so runner load cannot let it finish before interruption.
      await writeFile(release, "release\n");
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect(await Bun.file(escaped).exists()).toBe(false);
      expect(await git(target, "rev-parse", "HEAD")).toBe(original);
      expect(await paused(target)).toBe(false);
    } finally {
      // Release a surviving hook even when a readiness or exit assertion fails.
      await writeFile(release, "release\n");
      child.kill("SIGTERM");
      await child;
    }
  });
});

test("a symbolic remote-tracking ref cannot redirect fetch into an unrelated local branch", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const original = await commit(target, "feature.txt", "feature\n");
    await git(primary, "branch", "untouched", original);
    await git(primary, "symbolic-ref", "refs/remotes/origin/main", "refs/heads/untouched");
    await advance(publisher);
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(0);
    expect(await git(primary, "rev-parse", "untouched")).toBe(original);
    expect(await git(primary, "symbolic-ref", "refs/remotes/origin/main")).toBe("refs/heads/untouched");
    expect(await readFile(join(target, "feature.txt"), "utf8")).toBe("feature\n");
  });
});

test("inherited submodule recursion cannot overwrite ignored submodule content", async () => {
  await withRepository(async (primary, directory) => {
    const source = join(directory, "module-source"); await mkdir(source);
    await git(source, "init", "-b", "main");
    await commit(source, ".gitignore", ".env\n");
    await git(primary, "-c", "protocol.file.allow=always", "submodule", "add", source, "vendor");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-am", "add module");
    const { publisher, target } = await fixture(primary, directory);
    await git(target, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
    const modulePath = join(target, "vendor");
    const original = await git(modulePath, "rev-parse", "HEAD");
    const moduleCommit = await commit(source, ".env", "incoming tracked module file\n");
    await git(modulePath, "fetch", "origin");
    await git(publisher, "update-index", "--cacheinfo", `160000,${moduleCommit},vendor`);
    await git(publisher, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "advance module");
    await git(publisher, "push", "origin", "main");
    await git(primary, "config", "submodule.recurse", "true");
    await writeFile(join(modulePath, ".env"), "private module bytes\n");
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(modulePath, ".env"), "utf8")).toBe("private module bytes\n");
    expect(await git(modulePath, "rev-parse", "HEAD")).toBe(original);
  });
});
