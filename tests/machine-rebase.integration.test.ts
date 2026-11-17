import { expect, test } from "bun:test";
import { access, appendFile, chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, args: string[], env: Record<string, string> = {}) => execa(process.execPath, ["--no-env-file", entry, ...args], {
  cwd, reject: false, timeout: 10_000, env: { CI: "true", GIT_EDITOR: "false", GIT_SEQUENCE_EDITOR: "false", ...env },
});
const record = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const exists = (path: string) => access(path).then(() => true, () => false);

async function commit(cwd: string, name: string, contents: string) {
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
  const publisher = join(directory, "publisher");
  await git(directory, "clone", "--branch", "main", remote, publisher);
  const target = join(directory, "feature 'worktree");
  await git(primary, "worktree", "add", "-b", "TIM-134-feature", target);
  await writeFile(join(primary, ".timber.toml"), 'base_branch = "main"\n');
  await appendFile(join(primary, ".git/info/exclude"), "\n.timber.toml\n");
  return { remote, publisher, target, output: join(directory, "rebase result.json") };
}

async function advance(publisher: string, name = "incoming.txt", contents = "new base\n") {
  const oid = await commit(publisher, name, contents);
  await git(publisher, "push", "origin", "main");
  return oid;
}

const gitDir = (target: string) => git(target, "rev-parse", "--absolute-git-dir");
const paused = async (target: string) => exists(join(await gitDir(target), "rebase-merge", "head-name"));
const savedBase = async (target: string) => {
  const file = join(await gitDir(target), "timber", "base.json");
  return await exists(file) ? JSON.parse(await readFile(file, "utf8")).ref as unknown : null;
};

async function gitWrapper(directory: string, body: string) {
  const real = (await execa("which", ["git"])).stdout;
  const bin = join(directory, "wrapper"); await mkdir(bin);
  await writeFile(join(bin, "git"), "#!/bin/sh\n" + body + '\nexec "$TIMBER_TEST_GIT" "$@"\n');
  await chmod(join(bin, "git"), 0o755);
  return { PATH: bin + ":" + process.env.PATH, TIMBER_TEST_GIT: real };
}

test("a completed rebase records the base, pinned commit and original tip, then an up-to-date rerun", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target, output } = await fixture(primary, directory);
    const original = await commit(target, "feature.txt", "feature\n");
    const incoming = await advance(publisher);
    const result = await cli(primary, ["rebase", "TIM-134", "--result-file", output]);
    expect(result.exitCode).toBe(0);
    // Human output is unchanged and is not the machine record.
    expect(result.stdout).toContain("Rebase completed");
    expect(result.stdout).toContain(incoming);
    const data = await record(output);
    expect(data).toMatchObject({ schemaVersion: 1, command: "rebase", outcome: "succeeded", exitCode: 0,
      materialized: false, diagnostic: null,
      repository: { primaryWorktreeRoot: primary },
      worktree: { path: target, canonicalPath: await realpath(target), status: { kind: "known" }, branch: "TIM-134-feature",
        head: original, base: { kind: "assigned", ref: "refs/remotes/origin/main" } },
      rebase: { result: "rebased", base: "refs/remotes/origin/main", baseCommit: incoming, originalTip: original,
        conflicts: [], baseSaved: true } });
    expect(data).not.toHaveProperty("worktrees");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(await git(target, "rev-parse", "HEAD^")).toBe(incoming);
    expect(await savedBase(target)).toBe("refs/remotes/origin/main");

    const rebased = await git(target, "rev-parse", "HEAD");
    const again = join(directory, "again.json");
    const rerun = await cli(primary, ["rebase", target, "--result-file", again]);
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout).toContain("Already up to date.");
    expect(await record(again)).toMatchObject({ outcome: "succeeded", exitCode: 0, diagnostic: null,
      worktree: { head: rebased },
      rebase: { result: "up-to-date", base: "refs/remotes/origin/main", baseCommit: incoming, originalTip: rebased,
        conflicts: [], baseSaved: true } });
    expect(await git(target, "rev-parse", "HEAD")).toBe(rebased);
  });
});

test("an explicit local base is recorded as its canonical ref", async () => {
  await withRepository(async (primary, directory) => {
    const { target, output } = await fixture(primary, directory);
    const original = await git(target, "rev-parse", "HEAD");
    const tip = await git(primary, "rev-parse", "trunk");
    const result = await cli(primary, ["rebase", target, "--base", "refs/heads/trunk", "--result-file", output]);
    expect(result.exitCode).toBe(0);
    expect(await record(output)).toMatchObject({ outcome: "succeeded",
      worktree: { base: { kind: "assigned", ref: "refs/heads/trunk" } },
      rebase: { result: "up-to-date", base: "refs/heads/trunk", baseCommit: tip, originalTip: original, baseSaved: true } });
  });
});

test("a paused rebase records every unmerged path, exits nonzero and leaves Git paused", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target, output } = await fixture(primary, directory);
    const odd = "odd \n'\tname";
    await writeFile(join(target, "tracked.txt"), "feature\n");
    await writeFile(join(target, odd), "feature\n");
    await git(target, "add", "-A");
    await git(target, "commit", "-m", "feature");
    const original = await git(target, "rev-parse", "HEAD");
    await commit(publisher, "tracked.txt", "incoming\n");
    const incoming = await advance(publisher, odd, "incoming\n");
    const result = await cli(primary, ["rebase", target, "--result-file", output]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Rebase paused with conflicts");
    expect(result.stderr).toContain("rebase --continue");
    const data = await record(output);
    expect(data).toMatchObject({ command: "rebase", outcome: "failed", exitCode: result.exitCode, materialized: false,
      worktree: { path: target, branch: "TIM-134-feature", head: original, base: { kind: "assigned", ref: "refs/remotes/origin/main" } },
      rebase: { result: "conflicts", base: "refs/remotes/origin/main", baseCommit: incoming, originalTip: original, baseSaved: true } });
    expect(data.rebase.conflicts.sort()).toEqual([odd, "tracked.txt"].sort());
    expect(data.diagnostic).toContain("conflicts");
    expect(await savedBase(target)).toBe("refs/remotes/origin/main");
    // Git's paused state is untouched: native abort restores the original branch.
    expect(await paused(target)).toBe(true);
    expect((await git(target, "diff", "--name-only", "--diff-filter=U", "-z")).split("\0").filter(Boolean).sort())
      .toEqual([odd, "tracked.txt"].sort());
    await git(target, "rebase", "--abort");
    expect(await git(target, "rev-parse", "TIM-134-feature")).toBe(original);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("feature\n");
  });
});

test.each(["modified", "staged", "untracked", "operation", "detached"])("a %s target is refused with a diagnostic and nothing changes", async scenario => {
  await withRepository(async (primary, directory) => {
    const { publisher, target, output } = await fixture(primary, directory);
    await commit(target, "feature.txt", "feature\n");
    if (scenario === "detached") await git(target, "checkout", "--detach");
    await advance(publisher);
    const file = scenario === "untracked" ? "new.txt" : "tracked.txt";
    if (["modified", "staged", "untracked"].includes(scenario)) await writeFile(join(target, file), "preserve me\n");
    if (scenario === "staged") await git(target, "add", "tracked.txt");
    if (scenario === "operation") await writeFile(join(await gitDir(target), "MERGE_HEAD"), await git(target, "rev-parse", "HEAD") + "\n");
    const refs = await git(primary, "show-ref");
    const head = await git(target, "rev-parse", "HEAD");
    const status = await git(target, "status", "--porcelain=v1", "--ignored");
    const result = await cli(primary, ["rebase", target, "--result-file", output]);
    expect(result.exitCode).toBe(1);
    const data = await record(output);
    expect(data).toMatchObject({ command: "rebase", outcome: "failed", exitCode: 1, materialized: false,
      worktree: { path: target, base: { kind: "unassigned" } },
      rebase: { result: "refused", base: null, baseCommit: null, originalTip: null, conflicts: [], baseSaved: false } });
    expect(data.diagnostic).toMatch(scenario === "operation" ? /in progress/ : scenario === "detached" ? /detached/ : /clean index/);
    expect(result.stderr).toContain(data.diagnostic.split("\\n")[0]);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(target, "rev-parse", "HEAD")).toBe(head);
    expect(await git(target, "status", "--porcelain=v1", "--ignored")).toBe(status);
    expect(await readFile(join(target, "feature.txt"), "utf8")).toBe("feature\n");
    if (file === "new.txt" || scenario !== "untracked") {
      expect(await readFile(join(target, file), "utf8")).toBe(["modified", "staged", "untracked"].includes(scenario) ? "preserve me\n" : "original\n");
    }
    expect(await savedBase(target)).toBeNull();
    expect(await paused(target)).toBe(false);
  });
});

test("ambiguous, missing and unregistered targets are refused without a chooser or a guessed worktree", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    await git(primary, "worktree", "add", "-b", "TIM-134-second", join(directory, "second"));
    await git(primary, "branch", "unchecked");
    await advance(publisher);
    const refs = await git(primary, "show-ref");
    for (const [index, input] of ["TIM-134", "absent", "unchecked"].entries()) {
      const output = join(directory, `selection-${index}.json`);
      const result = await cli(primary, ["rebase", input, "--result-file", output]);
      expect(result.exitCode).toBe(1);
      const data = await record(output);
      expect(data).toMatchObject({ outcome: "failed", exitCode: 1, worktree: null, materialized: false,
        repository: { primaryWorktreeRoot: primary },
        rebase: { result: "refused", base: null, baseCommit: null, originalTip: null, conflicts: [], baseSaved: false } });
      expect(data.diagnostic).not.toBeNull();
      if (input === "TIM-134") expect(result.stderr).toContain("Use an exact branch or absolute path");
    }
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test.each(["fetch", "hook", "interrupt"])("a %s failure is recorded as failed and keeps the branch and files", async scenario => {
  await withRepository(async (primary, directory) => {
    const { publisher, target, output } = await fixture(primary, directory);
    const original = await commit(target, "feature.txt", "feature\n");
    const incoming = await advance(publisher);
    let env: Record<string, string> = {};
    if (scenario === "fetch") env = await gitWrapper(directory, 'if [ "$1" = fetch ]; then exit 19; fi');
    if (scenario === "interrupt") env = await gitWrapper(directory, 'case " $* " in\n  *" rebase "*) kill -TERM $$ ;;\nesac');
    if (scenario === "hook") {
      const hook = join(primary, ".git/hooks/pre-rebase");
      await writeFile(hook, "#!/bin/sh\nprintf 'RAW_PRIVATE_HOOK' >&2\nexit 1\n"); await chmod(hook, 0o755);
    }
    const refs = await git(primary, "show-ref");
    const result = await cli(primary, ["rebase", target, "--result-file", output], env);
    expect(result.exitCode).toBeGreaterThan(0);
    if (scenario === "interrupt") expect(result.exitCode).toBe(143);
    const data = await record(output);
    expect(data).toMatchObject({ command: "rebase", outcome: "failed", exitCode: result.exitCode, materialized: false,
      worktree: { path: target, head: original, base: { kind: "unassigned" } },
      rebase: { result: "failed", base: "refs/remotes/origin/main", originalTip: original, conflicts: [], baseSaved: false,
        baseCommit: scenario === "fetch" ? null : incoming } });
    expect(data.diagnostic).not.toBeNull();
    expect(JSON.stringify(data)).not.toContain("RAW_PRIVATE_HOOK");
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(target, "rev-parse", "HEAD")).toBe(original);
    expect(await git(target, "status", "--porcelain=v1")).toBe("");
    expect(await readFile(join(target, "feature.txt"), "utf8")).toBe("feature\n");
    expect(await savedBase(target)).toBeNull();
    expect(await paused(target)).toBe(false);
  });
});

test.each(["completed", "conflicts"])("baseSaved is false when the association cannot be written after a %s rebase", async scenario => {
  if (process.getuid?.() === 0) return; // root ignores directory modes
  await withRepository(async (primary, directory) => {
    const { publisher, target, output } = await fixture(primary, directory);
    const name = scenario === "conflicts" ? "tracked.txt" : "feature.txt";
    const original = await commit(target, name, "feature\n");
    const incoming = await advance(publisher, scenario === "conflicts" ? "tracked.txt" : "incoming.txt");
    const metadata = join(await gitDir(target), "timber");
    await mkdir(metadata, { mode: 0o500 });
    try {
      const result = await cli(primary, ["rebase", target, "--result-file", output]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("base association could not be saved");
      const data = await record(output);
      expect(data).toMatchObject({ outcome: "failed", exitCode: 1, worktree: { base: { kind: "unassigned" } },
        rebase: { result: scenario === "conflicts" ? "conflicts" : "failed", base: "refs/remotes/origin/main",
          baseCommit: incoming, originalTip: original, conflicts: scenario === "conflicts" ? ["tracked.txt"] : [], baseSaved: false } });
      expect(data.diagnostic).toContain("base association could not be saved");
      expect(await savedBase(target)).toBeNull();
      // Git's own outcome is kept: no reset or abort follows the metadata failure.
      expect(await paused(target)).toBe(scenario === "conflicts");
      if (scenario === "completed") expect(await git(target, "rev-parse", "HEAD^")).toBe(incoming);
    } finally {
      await chmod(metadata, 0o700);
    }
  });
});

test("an unusable result file stops before any rebase work, and no record means no launch flags are needed", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target, output } = await fixture(primary, directory);
    const original = await commit(target, "feature.txt", "feature\n");
    await advance(publisher);
    await writeFile(output, "do not overwrite");
    const refs = await git(primary, "show-ref");
    const fetchHead = join(await gitDir(target), "FETCH_HEAD");
    for (const destination of [output, join(directory, "absent parent", "result.json")]) {
      expect((await cli(primary, ["rebase", target, "--result-file", destination])).exitCode).toBe(1);
    }
    expect(await readFile(output, "utf8")).toBe("do not overwrite");
    expect(await exists(fetchHead)).toBe(false);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(target, "rev-parse", "HEAD")).toBe(original);
    const unknown = join(directory, "unknown.json");
    expect((await cli(primary, ["rebase", target, "--unknown", "--result-file", unknown])).exitCode).toBe(1);
    expect(await exists(unknown)).toBe(false);
  });
});
