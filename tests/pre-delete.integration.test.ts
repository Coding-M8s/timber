import { expect, test } from "bun:test";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const exists = (path: string) => access(path).then(() => true, () => false);
const cli = (cwd: string, path: string, flags: string[] = [], env: NodeJS.ProcessEnv = {}) =>
  execa(process.execPath, [entry, "done", ...flags, "--", path], {
    cwd, reject: false, timeout: 10_000, env: { CI: "true", ...env },
  });

async function configure(primary: string, hooks: string[]) {
  await writeFile(join(primary, ".timber.toml"),
    `base_branch = "trunk"\n[hooks]\npost_create = ["exit 98"]\npre_delete = ${JSON.stringify(hooks)}\n`);
}

async function target(primary: string, directory: string, hooks: string[],
  branch = "TIM-63-cleanup", name = "linked worktree") {
  await configure(primary, hooks);
  const path = join(directory, name);
  await git(primary, "worktree", "add", "-b", branch, path);
  return path;
}

async function snapshot(primary: string) {
  return {
    refs: await git(primary, "for-each-ref", "--format=%(refname)%00%(objectname)"),
    trees: await git(primary, "worktree", "list", "--porcelain", "-z"),
    tracked: await readFile(join(primary, "tracked.txt"), "utf8"),
  };
}

test.each([false, true])("pre_delete runs in order with literal context before removal; keepBranch=%s", async keepBranch => {
  await withRepository(async (primary, directory) => {
    const branch = "TIM-63-'literal;$value";
    const path = await target(primary, directory, [
      'printf "%s\\0" "$PWD" "$TIMBER_REPO" "$TIMBER_WORKTREE" "$TIMBER_BRANCH" "$TIMBER_TASK_ID" "${TIMBER_WORKFLOW-unset}" > "$TIMBER_TEST_REPORT"; printf "hook one\\n"',
      'test -s "$TIMBER_TEST_REPORT" || exit 88; if read value; then exit 89; fi; printf "hook two\\n"; printf "hook stderr\\n" >&2',
    ], branch, "linked ' $(touch injected) `touch injected` !\n\u001b\u009b\u2028");
    // A linked config is ignored and never read, even when invoking from that worktree.
    await writeFile(join(primary, ".git/info/exclude"), ".timber.toml\n");
    await writeFile(join(path, ".timber.toml"), "invalid [ config");
    const original = await git(primary, "rev-parse", branch);
    const report = join(directory, "context");
    const result = await cli(path, path, keepBranch ? ["--keep-branch"] : [], {
      TIMBER_TEST_REPORT: report, TIMBER_WORKFLOW: "stale", TIMBER_TASK_ID: "stale",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("hook one\nhook two\nRemoved worktree");
    expect(result.stderr).toBe("hook stderr");
    expect((await readFile(report, "utf8")).split("\0"))
      .toEqual([path, primary, path, branch, "TIM-63", "unset", ""]);
    expect(await exists(path)).toBe(false);
    expect(await exists(join(directory, "injected"))).toBe(false);
    expect(await exists(join(primary, "injected"))).toBe(false);
    const ref = await execa("git", ["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: primary, reject: false });
    expect(ref.exitCode).toBe(keepBranch ? 0 : 128);
    if (keepBranch) expect(ref.stdout).toBe(original);
  });
});

test.each(["exit 7", "kill -TERM $$"])("failed deletion hook stops later steps and retains files/refs: %s", async source => {
  await withRepository(async (primary, directory) => {
    const report = join(directory, "ran");
    const path = await target(primary, directory, [
      'printf first >> "$TIMBER_TEST_REPORT"', `${source} # SECRET_HOOK_SOURCE`,
      'printf later >> "$TIMBER_TEST_REPORT"',
    ], "no-ticket", "linked ' $(touch injected) !\n\u001b\u009b\u2028");
    const before = await snapshot(primary);
    const result = await cli(primary, path, ["--keep-branch", "--keep-ignored"], { TIMBER_TEST_REPORT: report });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("pre_delete step 2");
    expect(result.stderr).toContain(source === "exit 7" ? "exit code 7" : "signal SIGTERM");
    expect(result.stderr).not.toContain("SECRET_HOOK_SOURCE");
    expect(await readFile(report, "utf8")).toBe("first");
    expect(await snapshot(primary)).toEqual(before);
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("original\n");
    const retry = result.stderr.split("retry all pre-deletion steps with: ")[1]?.trim();
    expect(retry).toBeDefined();
    expect(retry).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    const capture = await execa("/bin/bash", ["-c", 'timber() { printf "%s\\0" "$@"; }; ' + retry], { cwd: directory });
    expect(capture.stdout.split("\0")).toEqual(["done", "--keep-branch", "--keep-ignored", "--", path, ""]);
    expect(await exists(join(directory, "injected"))).toBe(false);
    // An explicit retry begins at step one; nothing retries automatically.
    await cli(primary, path, ["--keep-branch", "--keep-ignored"], { TIMBER_TEST_REPORT: report });
    expect(await readFile(report, "utf8")).toBe("firstfirst");
  });
});

test.each(["modified", "untracked", "ignored", "unpublished", "locked", "primary"])(
  "initial %s refusal runs no deletion hooks and preserves work", async scenario => {
    await withRepository(async (primary, directory) => {
      const report = join(directory, "must not run");
      const path = await target(primary, directory, ['printf ran > "$TIMBER_TEST_REPORT"']);
      if (scenario === "modified") await writeFile(join(path, "tracked.txt"), "dirty\n");
      if (scenario === "untracked") await writeFile(join(path, "new.txt"), "untracked\n");
      if (scenario === "ignored") await writeFile(join(path, ".env"), "synthetic ignored\n");
      if (scenario === "unpublished") {
        await writeFile(join(path, "tracked.txt"), "unpublished content\n");
        await git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-am", "unpublished");
      }
      if (scenario === "locked") await git(primary, "worktree", "lock", path);
      const before = await snapshot(primary);
      const status = await git(path, "status", "--porcelain", "--ignored");
      const result = await cli(primary, scenario === "primary" ? primary : path,
        ["--keep-ignored"], { TIMBER_TEST_REPORT: report });
      expect(result.exitCode).toBe(1);
      expect(await exists(report)).toBe(false);
      expect(await snapshot(primary)).toEqual(before);
      expect(await git(path, "status", "--porcelain", "--ignored")).toBe(status);
      expect(await exists(path)).toBe(true);
    });
  });

const mutations = {
  modified: 'printf changed > tracked.txt',
  untracked: 'printf new > new.txt',
  ignored: 'printf synthetic > .env',
  head: 'git -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -m hook; git rev-parse HEAD > "$TIMBER_TEST_REPORT"',
  base: 'git -C "$TIMBER_REPO" -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -m hook; git rev-parse trunk > "$TIMBER_TEST_REPORT"',
  branch: 'git checkout -b different-branch',
  registration: 'git worktree lock "$TIMBER_WORKTREE"',
  identity: 'printf "gitdir: /missing-timber-test-metadata\\n" > .git',
};

for (const [scenario, source] of Object.entries(mutations)) {
  test(`successful hook changing ${scenario} refuses cleanup and retains hook side effects`, async () => {
    await withRepository(async (primary, directory) => {
      const path = await target(primary, directory, [source]);
      const before = await snapshot(primary);
      const report = join(directory, "changed tip");
      const result = await cli(primary, path, scenario === "ignored" ? ["--keep-ignored"] : [], { TIMBER_TEST_REPORT: report });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain("Removed worktree");
      expect(await exists(path)).toBe(true);
      expect(await git(primary, "worktree", "list", "--porcelain")).toContain(path);
      if (scenario === "head" || scenario === "base") {
        expect(await git(primary, "rev-parse", scenario === "head" ? "TIM-63-cleanup" : "trunk"))
          .toBe((await readFile(report, "utf8")).trim());
        expect((await snapshot(primary)).refs).not.toBe(before.refs);
      } else if (scenario === "branch") {
        expect(await git(path, "branch", "--show-current")).toBe("different-branch");
      } else {
        expect((await snapshot(primary)).refs).toBe(before.refs);
      }
      if (scenario === "modified") expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("changed");
      if (scenario === "untracked") expect(await readFile(join(path, "new.txt"), "utf8")).toBe("new");
      if (scenario === "ignored") expect(await readFile(join(path, ".env"), "utf8")).toBe("synthetic");
      if (scenario === "identity") expect(await readFile(join(path, ".git"), "utf8")).toContain("/missing-timber-test-metadata");
    });
  });
}

test.each(["identity", "lost-publication", "published-tip", "url", "refspec"])("hook changes live publication %s without authorizing removal", async scenario => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory, []);
    await writeFile(join(path, "feature.txt"), "feature\n");
    await git(path, "add", "feature.txt");
    await git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "feature");
    const oid = await git(path, "rev-parse", "HEAD");
    const remote = join(directory, "upstream.git");
    await git(directory, "init", "--bare", remote);
    await git(primary, "remote", "add", "backup", remote);
    await git(path, "push", "--set-upstream", "backup", "TIM-63-cleanup");
    await git(path, "push", "backup", "HEAD:refs/heads/alternative");
    const replacementRemote = join(directory, "replacement.git");
    if (scenario === "url") await git(directory, "clone", "--bare", remote, replacementRemote);
    let replacement = await git(primary, "rev-parse", "trunk");
    if (scenario === "published-tip") {
      replacement = (await execa("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "remote advances"], { cwd: path })).stdout;
      await git(path, "push", "backup", `${replacement}:refs/heads/advanced`);
    }
    await configure(primary, [scenario === "identity"
      ? 'git branch --set-upstream-to=backup/alternative'
      : scenario === "url" ? 'git remote set-url backup "$TIMBER_TEST_REMOTE"'
      : scenario === "refspec" ? 'git config branch.TIM-63-cleanup.merge refs/heads/alternative; git config --replace-all remote.backup.fetch +refs/heads/alternative:refs/remotes/backup/TIM-63-cleanup'
      : 'git --git-dir="$TIMBER_TEST_REMOTE" update-ref refs/heads/TIM-63-cleanup "$TIMBER_TEST_REPLACEMENT"']);
    const before = await snapshot(primary);
    const result = await cli(primary, path, [], { TIMBER_TEST_REMOTE: scenario === "url" ? replacementRemote : remote,
      TIMBER_TEST_REPLACEMENT: replacement });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("pre_delete step");
    expect(result.stdout).not.toContain("Removed worktree");
    expect(await snapshot(primary)).toEqual(before);
    expect(await readFile(join(path, "feature.txt"), "utf8")).toBe("feature\n");
    expect(await git(path, "rev-parse", "HEAD")).toBe(oid);
    if (scenario === "identity") expect(await git(path, "rev-parse", "--symbolic-full-name", "@{upstream}"))
      .toBe("refs/remotes/backup/alternative");
    else if (scenario === "url") expect(await git(path, "remote", "get-url", "backup")).toBe(replacementRemote);
    else if (scenario === "refspec") {
      expect(await git(path, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe("refs/remotes/backup/TIM-63-cleanup");
      expect(await git(path, "config", "branch.TIM-63-cleanup.merge")).toBe("refs/heads/alternative");
    } else expect(await git(remote, "rev-parse", "TIM-63-cleanup")).toBe(replacement);
  });
});
