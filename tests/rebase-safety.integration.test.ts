import { expect, test } from "bun:test";
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:os";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { advance, cli, commit, entry, fixture, gitWrapper, paused } from "./helpers/rebase";

test.each(["staged", "detached", "missing", "merge"])("rebase refuses %s targets before fetching", async scenario => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const before = await git(primary, "show-ref");
    const initial = await git(target, "rev-parse", "HEAD");
    const gitDir = await git(target, "rev-parse", "--absolute-git-dir");
    if (scenario === "staged") {
      await writeFile(join(target, "tracked.txt"), "preserve me\n");
      await git(target, "add", "tracked.txt");
    } else if (scenario === "detached") await git(target, "checkout", "--detach");
    else if (scenario === "missing") await rm(target, { recursive: true });
    else await writeFile(join(gitDir, "MERGE_HEAD"), initial + "\n");
    await advance(publisher);
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(scenario === "staged"
      ? /clean index/ : scenario === "detached" ? /detached/ : scenario === "missing" ? /missing|stale/ : /in progress/);
    expect(await git(primary, "show-ref")).toBe(before);
    if (scenario === "staged") {
      expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("preserve me\n");
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

test.each(["fetch-fails", "branch-moves", "files-change", "git-startup", "interrupt"])("rebase preserves work on boundary failure: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const original = await commit(target, "feature.txt", "feature\n");
    await advance(publisher);
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
      cwd: primary, reject: false, timeout: 30_000, env: { ...env, CI: "true", TIMBER_TEST_TARGET: target },
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
      cwd: primary, reject: false, timeout: 30_000, env: { CI: "true", TIMBER_TEST_STARTED: started, TIMBER_TEST_ESCAPED: escaped, TIMBER_TEST_RELEASE: release },
    });
    try {
      for (let i = 0; i < 200 && !await Bun.file(started).exists(); i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(await Bun.file(started).exists()).toBe(true);
      // Hook startup alone does not prove native signal readiness. Wait until
      // ps reports a caught SIGTERM; do not rely on a fixed startup delay.
      const deadline = Date.now() + 2_000;
      let handlesTermination = false;
      let probe = "not run";
      let probeUnsupported = false;
      while (Date.now() < deadline) {
        const status = await execa("/bin/ps", ["-p", String(child.pid), "-o", "sigcatch="], { reject: false });
        probe = JSON.stringify({ exitCode: status.exitCode, stderr: status.stderr });
        // macOS ps has no caught-signal keyword and rejects the request.
        if (process.platform === "darwin" && status.exitCode !== 0) { probeUnsupported = true; break; }
        const caught = /^[0-9a-f]+$/i.test(status.stdout.trim()) ? status.stdout.trim() : undefined;
        handlesTermination = caught !== undefined && (BigInt(`0x${caught}`) & (1n << BigInt(constants.signals.SIGTERM - 1))) !== 0n;
        if (handlesTermination) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      // Without a probe, the best available readiness signal is a settle delay
      // after the hook has started, which happens after Timber registers its handler.
      if (probeUnsupported) await new Promise(resolve => setTimeout(resolve, 500));
      else expect(handlesTermination, `last ps probe: ${probe}`).toBe(true);
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
