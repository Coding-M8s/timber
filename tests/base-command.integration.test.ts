import { expect, test } from "bun:test";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { commit, entry, fixture } from "./helpers/rebase";

const cli = (cwd: string, ...args: string[]) => execa(process.execPath, ["--no-env-file", entry, ...args], {
  cwd, reject: false, timeout: 30_000, stdin: "ignore",
  env: { CI: "true", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
});
const branch = "TIM-28-feature";
const metadata = async (path: string) => join(await git(path, "rev-parse", "--absolute-git-dir"), "timber", "base.json");
const savedRef = async (path: string) => JSON.parse(await readFile(await metadata(path), "utf8")).ref as string;
const record = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const listed = async (primary: string, target: string) => {
  const result = await cli(primary, "ls", "--json");
  expect(result.exitCode).toBe(0);
  return (JSON.parse(result.stdout).worktrees as { path: string; base: unknown }[]).find(tree => tree.path === target)!.base;
};
/** Path, size and mtime of every regular file under `directory`, skipping Timber's own metadata. */
async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(directory, item.name);
    if (item.isDirectory()) { if (item.name !== "timber") found.push(...await files(full)); continue; }
    const info = await stat(full);
    found.push(`${full} ${info.size} ${info.mtimeMs}`);
  }
  return found;
}
/**
 * The target's index bytes, then every Git directory file (refs, FETCH_HEAD, HEAD, config) and the
 * worktree's own files. Raw reads only, so no Git command can refresh the index inside the window.
 */
async function gitState(primary: string, target: string) {
  const index = await readFile(join(await git(target, "rev-parse", "--absolute-git-dir"), "index"));
  return [index.toString("base64"), ...await files(join(primary, ".git")), ...await files(target).then(list => list.filter(line => !line.includes("/.git ")))].join("\n");
}
/** Snapshot immediately around one command, with the index read last before and first after. */
async function unchanged(primary: string, target: string, run: () => Promise<void>) {
  const before = await gitState(primary, target);
  await run();
  expect(await gitState(primary, target)).toBe(before);
}
/** Staged, unstaged and untracked work, so any index or file change is visible. */
async function dirty(target: string) {
  await commit(target, "unstaged.txt", "committed\n");
  await writeFile(join(target, "unstaged.txt"), "edited\n");
  await writeFile(join(target, "staged.txt"), "staged\n");
  await git(target, "add", "--", "staged.txt");
  await writeFile(join(target, "untracked.txt"), "untracked\n");
}

test("sets a base on a dirty worktree with none, replaces it, and clears it without touching Git state", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await fixture(primary, directory);
    await dirty(target);
    await git(target, "status");
    expect(await listed(primary, target)).toEqual({ kind: "unassigned" });

    let set!: Awaited<ReturnType<typeof cli>>;
    await unchanged(primary, target, async () => { set = await cli(primary, "base", branch, "--set", "origin/main"); });
    expect(set.stderr).toBe("");
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain("Saved base origin/main");
    expect(set.stdout).toContain("(was none)");
    expect(await savedRef(target)).toBe("refs/remotes/origin/main");
    expect(await listed(primary, target)).toEqual({ kind: "assigned", ref: "refs/remotes/origin/main" });

    let replaced!: Awaited<ReturnType<typeof cli>>;
    await unchanged(primary, target, async () => { replaced = await cli(primary, "base", target, "--set", "refs/heads/trunk"); });
    expect(replaced.exitCode).toBe(0);
    expect(replaced.stdout).toContain("(was origin/main)");
    expect(await listed(primary, target)).toEqual({ kind: "assigned", ref: "refs/heads/trunk" });

    let cleared!: Awaited<ReturnType<typeof cli>>;
    await unchanged(primary, target, async () => { cleared = await cli(primary, "base", branch, "--clear"); });
    expect(cleared.exitCode).toBe(0);
    expect(cleared.stdout).toContain("(was refs/heads/trunk)");
    expect(await listed(primary, target)).toEqual({ kind: "unassigned" });
    expect((await cli(primary, "base", branch, "--clear")).exitCode).toBe(0);
    const record = join(directory, "record.json");
    await unchanged(primary, target, async () => {
      expect((await cli(primary, "base", branch, "--set", "main", "--result-file", record)).exitCode).toBe(0);
    });
  });
});

test("accepts every rebase --base form and saves its canonical ref", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await fixture(primary, directory);
    for (const [input, ref] of [
      ["main", "refs/remotes/origin/main"],
      ["origin/main", "refs/remotes/origin/main"],
      ["refs/remotes/origin/main", "refs/remotes/origin/main"],
      ["refs/heads/main", "refs/heads/main"],
    ] as const) {
      const result = await cli(primary, "base", branch, "--set", input);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(await savedRef(target)).toBe(ref);
    }
  });
});

test("refuses unknown and invalid bases with a reason and keeps the saved base and Git state", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await fixture(primary, directory);
    await dirty(target);
    expect((await cli(primary, "base", branch, "--set", "origin/main")).exitCode).toBe(0);
    const saved = await readFile(await metadata(target), "utf8");
    await git(target, "status");
    const before = await gitState(primary, target);
    for (const [input, reason] of [
      ["origin/absent", "Remote base is missing or ambiguous; use --set <remote/branch>."],
      ["refs/heads/absent", "Local base is missing or invalid; choose a replacement with --set refs/heads/<branch>."],
      ["HEAD", "Invalid remote base branch"],
      ["bad..name", "Invalid remote base branch"],
      ["refs/heads/bad..name", "Local base must be a valid direct branch ref"],
      [`refs/heads/${branch}`, "Cannot use the worktree's own branch as its base"],
      ["nowhere/main", "Remote base is missing or ambiguous"],
    ] as const) {
      const result = await cli(primary, "base", branch, "--set", input);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(reason);
      expect(await readFile(await metadata(target), "utf8")).toBe(saved);
    }
    expect(await gitState(primary, target)).toBe(before);
  });
});

test("--result-file reports the old and new base and ls --json shows the new one at once", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await fixture(primary, directory);
    const first = join(directory, "first.json");
    expect((await cli(primary, "base", branch, "--set", "origin/main", "--result-file", first)).exitCode).toBe(0);
    const set = await record(first);
    expect(set).toMatchObject({
      schemaVersion: 1, command: "base", outcome: "succeeded", exitCode: 0, diagnostic: null,
      baseChange: { action: "set", result: "set", previous: { kind: "unassigned" },
        current: { kind: "assigned", ref: "refs/remotes/origin/main" } },
    });
    expect(set.worktree.base).toEqual({ kind: "assigned", ref: "refs/remotes/origin/main" });
    expect(set.worktree.status.kind).toBe("known");
    expect(set.worktree.canonicalPath).toBe(await realpath(target));
    expect(await listed(primary, target)).toEqual({ kind: "assigned", ref: "refs/remotes/origin/main" });

    const second = join(directory, "second.json");
    expect((await cli(primary, "base", branch, "--set", "refs/heads/trunk", "--result-file", second)).exitCode).toBe(0);
    expect((await record(second)).baseChange).toEqual({ action: "set", result: "set",
      previous: { kind: "assigned", ref: "refs/remotes/origin/main" }, current: { kind: "assigned", ref: "refs/heads/trunk" } });
    expect(await listed(primary, target)).toEqual({ kind: "assigned", ref: "refs/heads/trunk" });

    const refused = join(directory, "refused.json");
    expect((await cli(primary, "base", branch, "--set", "origin/absent", "--result-file", refused)).exitCode).toBe(1);
    const stop = await record(refused);
    expect(stop).toMatchObject({ command: "base", outcome: "failed", exitCode: 1,
      baseChange: { action: "set", result: "refused", previous: { kind: "assigned", ref: "refs/heads/trunk" },
        current: { kind: "assigned", ref: "refs/heads/trunk" } } });
    expect(stop.diagnostic).toContain("Remote base is missing");

    const cleared = join(directory, "cleared.json");
    expect((await cli(primary, "base", branch, "--clear", "--result-file", cleared)).exitCode).toBe(0);
    expect((await record(cleared)).baseChange).toEqual({ action: "clear", result: "cleared",
      previous: { kind: "assigned", ref: "refs/heads/trunk" }, current: { kind: "unassigned" } });
    expect(await listed(primary, target)).toEqual({ kind: "unassigned" });
  });
});

test("an unreachable remote is a failure, and malformed metadata refuses until repaired", async () => {
  await withRepository(async (primary, directory) => {
    const { target, remote } = await fixture(primary, directory);
    await git(primary, "remote", "set-url", "origin", join(directory, "gone.git"));
    const failed = join(directory, "failed.json");
    expect((await cli(primary, "base", branch, "--set", "origin/main", "--result-file", failed)).exitCode).toBe(1);
    expect((await record(failed)).baseChange).toMatchObject({ result: "failed", current: { kind: "unassigned" } });
    await git(primary, "remote", "set-url", "origin", remote);

    expect((await cli(primary, "base", branch, "--set", "refs/heads/trunk")).exitCode).toBe(0);
    await writeFile(await metadata(target), "not json\n");
    for (const args of [["--set", "refs/heads/main"], ["--clear"]]) {
      const result = await cli(primary, "base", branch, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("malformed or unreadable");
      expect(await readFile(await metadata(target), "utf8")).toBe("not json\n");
    }
  });
});

test("needs exactly one of --set or --clear and never offers a chooser", async () => {
  await withRepository(async (primary, directory) => {
    await fixture(primary, directory);
    for (const args of [[], ["--set", "main", "--clear"]]) {
      const result = await cli(primary, "base", branch, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Use exactly one of --set <ref> or --clear.");
    }
    const missing = await cli(primary, "base", "nothing-here", "--set", "main");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("No registered worktree matches");
  });
});

test("a detached worktree is eligible and keeps its detached HEAD", async () => {
  await withRepository(async (primary, directory) => {
    const { target } = await fixture(primary, directory);
    await git(target, "checkout", "--detach");
    const head = await git(target, "rev-parse", "HEAD");
    const result = await cli(primary, "base", target, "--set", "refs/heads/trunk");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await savedRef(target)).toBe("refs/heads/trunk");
    expect(await git(target, "rev-parse", "HEAD")).toBe(head);
    expect((await execa("git", ["symbolic-ref", "-q", "HEAD"], { cwd: target, reject: false })).exitCode).toBe(1);
  });
});
