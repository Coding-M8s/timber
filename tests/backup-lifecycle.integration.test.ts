import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { reviewBackupDeletion } from "../src/backup/lifecycle";
import { discoverRepository } from "../src/git/repository";
import type { TerminalTextPrompt } from "../src/selection";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, ...args: string[]) => execa(process.execPath, ["--no-env-file", entry, ...args], {
  cwd, reject: false, timeout: 15_000, env: { CI: "true", GIT_EDITOR: "false", XDG_CONFIG_HOME: "/nonexistent/timber-test-config" },
});
const secret = "SYNTHETIC_TOKEN=lifecycle-not-a-real-secret\n";
const identity = ["-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid"];

function root(primary: string): string {
  return join(primary, ".git/timber/backups");
}

async function entries(primary: string): Promise<string[]> {
  try { return (await fs.readdir(root(primary))).sort(); }
  catch { return []; }
}

async function timberRefs(primary: string): Promise<string> {
  return git(primary, "for-each-ref", "--format=%(refname) %(objectname)", "refs/timber/");
}

/** Every file under the backup root with its bytes, so preservation checks are exact. */
async function storageSnapshot(primary: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (directory: string, prefix: string) => {
    let names: string[];
    try { names = (await fs.readdir(directory)).sort(); } catch { return; }
    for (const name of names) {
      const path = join(directory, name);
      const info = await fs.lstat(path);
      if (info.isSymbolicLink()) result[prefix + name] = `-> ${await fs.readlink(path)}`;
      else if (info.isDirectory()) { result[prefix + name + "/"] = "dir"; await walk(path, `${prefix}${name}/`); }
      else result[prefix + name] = await fs.readFile(path, "utf8");
    }
  };
  await walk(root(primary), "");
  return result;
}

async function feature(primary: string, directory: string, branch = "feature/lifecycle", name = "feature worktree") {
  const target = join(directory, name);
  await git(primary, "worktree", "add", "-b", branch, target);
  await fs.writeFile(join(target, "untracked.txt"), "untracked work\n");
  await fs.writeFile(join(target, ".env"), secret);
  return target;
}

async function backup(primary: string, input: string): Promise<string> {
  const created = await cli(primary, "backup", "create", input);
  expect(created.stderr).toBe("");
  expect(created.exitCode).toBe(0);
  const id = /^Backup created: (\S+)$/mu.exec(created.stdout)?.[1];
  if (!id) throw new Error("No backup ID in output");
  return id;
}

/** Scripted terminal prompt: the only test double, at the TTY seam. */
function prompt(answers: (string | null | (() => Promise<string | null>))[]) {
  const asked: string[] = [];
  const ask: TerminalTextPrompt = async message => {
    asked.push(message);
    if (!answers.length) throw new Error(`Unexpected prompt: ${message}`);
    const next = answers.shift()!;
    return typeof next === "function" ? next() : next;
  };
  return { ask, asked };
}

async function review(primary: string, all: boolean, ask: TerminalTextPrompt) {
  let stdout = "";
  let stderr = "";
  const exitCode = await reviewBackupDeletion(await discoverRepository(primary), { all },
    { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, ask);
  return { exitCode, stdout, stderr };
}

async function admin(target: string): Promise<string> {
  return git(target, "rev-parse", "--absolute-git-dir");
}

/** Pause a real rebase on conflict in the backed-up worktree. */
async function pausedRebase(primary: string, target: string) {
  await fs.writeFile(join(target, "tracked.txt"), "feature side\n");
  await git(target, "add", "tracked.txt");
  await git(target, ...identity, "commit", "-m", "feature edit");
  await fs.writeFile(join(primary, "tracked.txt"), "trunk side\n");
  await git(primary, "add", "tracked.txt");
  await git(primary, ...identity, "commit", "-m", "trunk edit");
  const rebase = await execa("git", [...identity, "rebase", "trunk"], { cwd: target, reject: false, env: { GIT_EDITOR: "true" } });
  expect(rebase.exitCode).not.toBe(0);
  expect((await fs.lstat(join(await admin(target), "rebase-merge"))).isDirectory()).toBe(true);
}

test("list shows backups with branch, time, size, protection and expiry, and reports unusable entries safely", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/lifecycle");
    const head = await git(primary, "rev-parse", "HEAD");
    const storage = root(primary);
    // A malformed record, an unrecognized name with a control character, an interrupted creation,
    // a ref without a directory, and a symlink that impersonates a valid backup directory.
    await fs.mkdir(join(storage, "20260101T000000Z-00000001"), { mode: 0o700 });
    await fs.writeFile(join(storage, "20260101T000000Z-00000001", "record.json"), "{not json", { mode: 0o600 });
    await fs.mkdir(join(storage, "evil\nname"), { mode: 0o700 });
    await fs.mkdir(join(storage, ".incomplete-20260101T000000Z-00000002"), { mode: 0o700 });
    await git(primary, "update-ref", "refs/timber/backups/20260101T000000Z-00000003", head);
    const decoy = join(directory, "decoy");
    await fs.cp(join(storage, id), decoy, { recursive: true });
    await fs.symlink(decoy, join(storage, "20260101T000000Z-00000004"));

    const listed = await cli(primary, "backup", "list");
    expect(listed.stderr).toBe("");
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("Recovery backups: 1 (");
    expect(listed.stdout).toContain(`${id}\n  Branch: feature/lifecycle\n  Created: `);
    expect(listed.stdout).toMatch(/ {2}Size: \d+(\.\d)? (B|KiB), \d+ entries/u);
    expect(listed.stdout).toContain("  Protection: none");
    expect(listed.stdout).toMatch(/ {2}Retention: expires \S+Z \(7 days\)\n/u);
    expect(listed.stdout).toContain("20260101T000000Z-00000001: Backup record or manifest is missing, unreadable or not private");
    expect(listed.stdout).toContain("\"evil\\nname\": unrecognized entry");
    expect(listed.stdout).not.toContain("evil\nname");
    expect(listed.stdout).toContain(".incomplete-20260101T000000Z-00000002: incomplete creation");
    expect(listed.stdout).toContain("refs/timber/backups/20260101T000000Z-00000003: private backup ref without a backup directory");
    expect(listed.stdout).toContain("20260101T000000Z-00000004: Backup storage is not a private directory");
    expect(listed.stdout).toContain("can contain copies of ignored files");
    expect(listed.stdout).not.toContain("SYNTHETIC_TOKEN");
    expect(listed.stdout).not.toContain("untracked.txt");

    // Unusable entries are never offered, even under --all.
    const before = await storageSnapshot(primary);
    const decoyBefore = await fs.readdir(decoy);
    const { ask, asked } = prompt(["y"]);
    const result = await review(primary, true, ask);
    expect(result.exitCode).toBe(0);
    expect(asked).toEqual([expect.stringContaining("Delete all 1 backup ")]);
    expect(result.stdout).toContain(`Deleted backup ${id}`);
    const after = await storageSnapshot(primary);
    for (const key of Object.keys(before)) {
      if (key.startsWith(id)) expect(after[key]).toBeUndefined();
      else expect(after[key]).toBe(before[key]!);
    }
    expect(await fs.readdir(decoy)).toEqual(decoyBefore);
    expect(await timberRefs(primary)).toBe(`refs/timber/backups/20260101T000000Z-00000003 ${head}`);
  });
});

test("list with no storage reports none and creates nothing", async () => {
  await withRepository(async primary => {
    const listed = await cli(primary, "backup", "list");
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toBe("No recovery backups in this repository.");
    await expect(fs.lstat(join(primary, ".git/timber"))).rejects.toThrow();
  });
});

test.each([[[]], [["--all"]]])("backup done %j refuses without an interactive terminal and deletes nothing", async flags => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    await backup(primary, "feature/lifecycle");
    const before = await storageSnapshot(primary);
    const refs = await timberRefs(primary);
    const result = await cli(primary, "backup", "done", ...flags);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Deleting backups requires an interactive terminal; nothing was deleted.");
    expect(await storageSnapshot(primary)).toEqual(before);
    expect(await timberRefs(primary)).toBe(refs);
  });
});

test.each([
  ["individual Enter (default No)", false, [""]],
  ["individual n", false, ["n"]],
  ["individual yes is not y", false, ["yes"]],
  ["individual end of input", false, [null]],
  ["all Enter (default No)", true, [""]],
  ["all n", true, ["n"]],
  ["all end of input", true, [null]],
] as const)("cancellation keeps every backup file and ref: %s", async (_name, all, answers) => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    await backup(primary, "feature/lifecycle");
    const before = await storageSnapshot(primary);
    const refs = await timberRefs(primary);
    const { ask, asked } = prompt([...answers]);
    const result = await review(primary, all, ask);
    expect(result.exitCode).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Type y and press Enter to delete [y/N]");
    expect(result.stdout).not.toContain("Deleted backup");
    expect(await storageSnapshot(primary)).toEqual(before);
    expect(await timberRefs(primary)).toBe(refs);
  });
});

test("individual review deletes only the backup confirmed with y and keeps the next one by default", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const first = await backup(primary, "feature/lifecycle");
    const second = await backup(primary, "feature/lifecycle");
    const [older, newer] = [first, second].sort();
    const kept = Object.fromEntries(Object.entries(await storageSnapshot(primary)).filter(([key]) => key.startsWith(newer!)));
    const { ask, asked } = prompt(["y", ""]);
    const result = await review(primary, false, ask);
    expect(result.exitCode).toBe(0);
    expect(asked).toEqual([expect.stringContaining(older!), expect.stringContaining(newer!)]);
    expect(result.stdout).toContain(`Deleted backup ${older}`);
    expect(result.stdout).toContain(`Kept backup ${newer}`);
    expect(await entries(primary)).toEqual([newer!]);
    expect(await storageSnapshot(primary)).toEqual(kept);
    expect(await timberRefs(primary)).toBe(`refs/timber/backups/${newer} ${await git(primary, "rev-parse", "HEAD")}`);
  });
});

test("--all asks once with the count and total size, and selection alone deletes nothing", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    await backup(primary, "feature/lifecycle");
    await backup(primary, "feature/lifecycle");
    let seen: Record<string, string> = {};
    const { ask, asked } = prompt([async () => { seen = await storageSnapshot(primary); return "y"; }]);
    const before = await storageSnapshot(primary);
    const result = await review(primary, true, ask);
    expect(seen).toEqual(before);
    expect(asked).toEqual([expect.stringMatching(/^Delete all 2 backups \(\d+(\.\d)? (B|KiB)\)\? Type y and press Enter/u)]);
    expect(result.stdout).toContain("Selected 2 eligible backups (");
    expect(result.exitCode).toBe(0);
    expect(await entries(primary)).toEqual([]);
    expect(await timberRefs(primary)).toBe("");
  });
});

test("active rebase backups stay protected in list, individual review and --all", async () => {
  await withRepository(async (primary, directory) => {
    const target = await feature(primary, directory);
    const id = await backup(primary, "feature/lifecycle");
    await pausedRebase(primary, target);
    const listed = await cli(primary, "backup", "list");
    expect(listed.stdout).toContain("  Protection: protected, its source worktree has a rebase in progress");
    const before = await storageSnapshot(primary);
    const refs = await timberRefs(primary);
    for (const all of [false, true]) {
      const { ask, asked } = prompt([]);
      const result = await review(primary, all, ask);
      expect(result.exitCode).toBe(0);
      expect(asked).toEqual([]);
      expect(result.stdout).toContain(`Protected, not offered: ${id}`);
      expect(result.stdout).toContain("No backups are eligible for deletion; nothing was deleted.");
    }
    expect(await storageSnapshot(primary)).toEqual(before);
    expect(await timberRefs(primary)).toBe(refs);
  });
});

test("an uncertain rebase elsewhere protects every backup, including under --all", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const other = await feature(primary, directory, "feature/other", "other worktree");
    const id = await backup(primary, "feature/lifecycle");
    // Rebase state without a readable branch name: Timber cannot tell which branch is being rebased.
    await fs.mkdir(join(await admin(other), "rebase-merge"));
    const listed = await cli(primary, "backup", "list");
    expect(listed.stdout).toContain("Protection: protected, a rebase whose branch cannot be identified is in progress (uncertain rebase)");
    const before = await storageSnapshot(primary);
    const { ask, asked } = prompt([]);
    const result = await review(primary, true, ask);
    expect(asked).toEqual([]);
    expect(result.stdout).toContain(`Protected, not offered: ${id}`);
    expect(await storageSnapshot(primary)).toEqual(before);
    expect(await timberRefs(primary)).toContain(id);
  });
});

test("a rebase of the backed-up branch in another worktree protects the backup", async () => {
  await withRepository(async (primary, directory) => {
    const target = await feature(primary, directory);
    const id = await backup(primary, "feature/lifecycle");
    // Same branch rebased from a different admin directory after the source was removed.
    await git(primary, "worktree", "remove", "--force", target);
    await fs.mkdir(join(primary, ".git/worktrees/elsewhere/rebase-merge"), { recursive: true });
    await fs.writeFile(join(primary, ".git/worktrees/elsewhere/rebase-merge/head-name"), "refs/heads/feature/lifecycle\n");
    const listed = await cli(primary, "backup", "list");
    expect(listed.stdout).toContain("Protection: protected, branch feature/lifecycle has a rebase in progress");
    const { ask, asked } = prompt([]);
    await review(primary, true, ask);
    expect(asked).toEqual([]);
    expect(await entries(primary)).toEqual([id]);
  });
});

test.each([
  ["a rewritten record", async (primary: string, id: string) => {
    const path = join(root(primary), id, "record.json");
    const record = JSON.parse(await fs.readFile(path, "utf8")) as { createdAt: string };
    record.createdAt = "2000-01-01T00:00:00.000Z";
    await fs.writeFile(path, JSON.stringify(record) + "\n");
  }, "it changed after it was selected"],
  ["a moved private ref", async (primary: string, id: string) => {
    await git(primary, ...identity, "commit", "--allow-empty", "-m", "moved");
    await git(primary, "update-ref", `refs/timber/backups/${id}`, await git(primary, "rev-parse", "HEAD"));
  }, "it changed after it was selected"],
  ["a rebase started on the source", async (_primary: string, _id: string, target: string) => {
    await fs.mkdir(join(await admin(target), "rebase-merge"));
    await fs.writeFile(join(await admin(target), "rebase-merge", "head-name"), "detached HEAD\n");
  }, "it is now protected"],
  ["an extra file in the backup", async (primary: string, id: string) => {
    await fs.writeFile(join(root(primary), id, "unrelated.txt"), "keep me\n", { mode: 0o600 });
  }, "it changed after it was selected"],
] as const)("a concurrent change between selection and deletion stops it: %s", async (_name, change, reason) => {
  for (const all of [false, true]) {
    await withRepository(async (primary, directory) => {
      const target = await feature(primary, directory);
      const id = await backup(primary, "feature/lifecycle");
      let before: Record<string, string> = {};
      let refs = "";
      const { ask } = prompt([async () => {
        await change(primary, id, target);
        before = await storageSnapshot(primary);
        refs = await timberRefs(primary);
        return "y";
      }]);
      const result = await review(primary, all, ask);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`Kept backup ${id}: ${reason}`);
      expect(await storageSnapshot(primary)).toEqual(before);
      expect(await timberRefs(primary)).toBe(refs);
    });
  }
});

test("a symlink substituted for the backup directory after selection deletes nothing it points to", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/lifecycle");
    const moved = join(directory, "moved backup");
    let target: string[] = [];
    const { ask } = prompt([async () => {
      await fs.rename(join(root(primary), id), moved);
      await fs.symlink(moved, join(root(primary), id));
      target = (await fs.readdir(moved)).sort();
      return "y";
    }]);
    const refs = await timberRefs(primary);
    const result = await review(primary, false, ask);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Kept backup ${id}: it changed after it was selected`);
    expect((await fs.readdir(moved)).sort()).toEqual(target);
    expect((await fs.lstat(join(root(primary), id))).isSymbolicLink()).toBe(true);
    expect(await timberRefs(primary)).toBe(refs);
  });
});

test("a partial deletion failure reports the remaining state and can be finished explicitly", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/lifecycle");
    const actualUnlink = fs.unlink;
    const failing = spyOn(fs, "unlink").mockImplementation(async path => {
      if (String(path).endsWith("manifest.json")) throw Object.assign(new Error("synthetic failure"), { code: "EIO" });
      return actualUnlink(path);
    });
    let result;
    try { result = await review(primary, false, prompt(["y"]).ask); }
    finally { failing.mockRestore(); }
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Backup ${id} was only partly deleted: its private ref was removed; 2 files remain in`);
    expect(result.stderr).toContain("Run timber backup done again to finish deleting it");
    expect(result.stdout).not.toContain(`Deleted backup ${id}`);
    expect(result.stdout).toContain("Deleted 0 backups; 1 not fully deleted.");
    expect(await entries(primary)).toEqual([`.deleting-${id}`]);
    expect((await fs.readdir(join(root(primary), `.deleting-${id}`))).sort()).toEqual(["manifest.json", "record.json"]);
    expect(await timberRefs(primary)).toBe("");

    const listed = await cli(primary, "backup", "list");
    expect(listed.stdout).toContain(`Unfinished deletions (finish with timber backup done):\n  ${id}: deletion did not complete`);
    // Finishing still requires confirmation; default No keeps the remains.
    expect((await review(primary, true, prompt([""]).ask)).exitCode).toBe(0);
    expect(await entries(primary)).toEqual([`.deleting-${id}`]);
    const finished = await review(primary, false, prompt(["y"]).ask);
    expect(finished.exitCode).toBe(0);
    expect(finished.stdout).toContain(`Deleted backup ${id}`);
    expect(await entries(primary)).toEqual([]);
  });
});

test("an unfinished deletion with unexpected contents is not offered and is left intact", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/lifecycle");
    await git(primary, "update-ref", "-d", `refs/timber/backups/${id}`);
    await fs.rename(join(root(primary), id), join(root(primary), `.deleting-${id}`));
    await fs.writeFile(join(root(primary), `.deleting-${id}`, "unrelated.txt"), "keep me\n", { mode: 0o600 });
    const before = await storageSnapshot(primary);
    const { ask, asked } = prompt([]);
    const result = await review(primary, true, ask);
    expect(asked).toEqual([]);
    expect(result.stdout).toContain(`Not usable, not offered: .deleting-${id}`);
    expect(await storageSnapshot(primary)).toEqual(before);
  });
});

test("timber done keeps the backup, reports it, and the backup restores after the source worktree is gone", async () => {
  await withRepository(async (primary, directory) => {
    const target = await feature(primary, directory);
    await fs.rm(join(target, "untracked.txt"));
    const id = await backup(primary, "feature/lifecycle");
    const refs = await timberRefs(primary);
    const done = await cli(primary, "done", "feature/lifecycle", "--base", "trunk");
    expect(done.stderr).toBe("");
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain(`Removed worktree at ${target}`);
    expect(done.stdout).toMatch(new RegExp(`Kept 1 recovery backup of this worktree:\\n {2}${id} \\(\\d+ B, expires \\S+Z\\)\\n`, "u"));
    expect(done.stdout).toContain("can still contain copies of ignored files, including secrets such as .env");
    expect(done.stdout).toContain("delete with timber backup done");
    await expect(fs.lstat(target)).rejects.toThrow();
    expect(await entries(primary)).toEqual([id]);
    expect(await timberRefs(primary)).toBe(refs);

    const restored = join(directory, "restored");
    const restore = await cli(primary, "backup", "restore", id, restored);
    expect(restore.stderr).toBe("");
    expect(restore.exitCode).toBe(0);
    expect(await fs.readFile(join(restored, ".env"), "utf8")).toBe(secret);
  });
});

test("timber done without backups of the worktree adds no backup report", async () => {
  await withRepository(async (primary, directory) => {
    const target = await feature(primary, directory);
    await fs.rm(join(target, "untracked.txt"));
    await feature(primary, directory, "feature/other", "other worktree");
    await backup(primary, "feature/other");
    const done = await cli(primary, "done", "feature/lifecycle", "--base", "trunk");
    expect(done.exitCode).toBe(0);
    expect(done.stdout).not.toContain("recovery backup");
  });
});
