import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { absent, cli, commit, entry, removed, retained, snapshot, target, upstream } from "./helpers/done";

test.each(["deleted-upstream", "base-advanced"])("done removes a content-integrated branch and ignored files with no flags: %s", async scenario => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const oid = await commit(path);
    const remote = await upstream(primary, directory, path);
    await git(primary, "merge", "--squash", "feature/one");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "squash integration");
    if (scenario === "base-advanced") await commit(primary, "later.txt", "later unrelated base change");
    const ancestor = await execa("git", ["merge-base", "--is-ancestor", oid, "trunk"], { cwd: primary, reject: false });
    expect(ancestor.exitCode).toBe(1);
    if (scenario === "deleted-upstream") await git(remote, "update-ref", "-d", "refs/heads/feature/one");
    const remoteRefs = await git(remote, "for-each-ref", "--format=%(refname)%00%(objectname)");
    await writeFile(join(path, ".env"), "synthetic ignored bytes\n");
    const result = await cli(primary, path);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Deleted local branch feature/one");
    expect(result.stdout).not.toContain("synthetic ignored bytes");
    await removed(primary, path, "feature/one", true);
    expect(await git(remote, "for-each-ref", "--format=%(refname)%00%(objectname)")).toBe(remoteRefs);
    expect(await readFile(join(primary, "feature.txt"), "utf8")).toBe("feature bytes\n");
    if (scenario === "base-advanced") expect(await readFile(join(primary, "later.txt"), "utf8")).toBe("feature bytes\n");
  });
});

test.each(["integrated", "reverted", "unrelated-history", "history-failure", "history-malformed"])("done checks historical squash integration after a base rewrite: %s", async scenario => {
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
        cwd: primary, reject: false, timeout: 30_000,
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
        cwd: primary, reject: false, timeout: 30_000,
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
      cwd: primary, reject: false, timeout: 30_000,
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
