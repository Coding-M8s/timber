import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import * as backupGitModule from "../src/backup/git";
import { runAppBackup } from "../src/commands/app-backup";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execa(process.execPath, ["--no-env-file", entry, ...args], {
    cwd, reject: false, timeout: 15_000, env: { CI: "true", GIT_EDITOR: "false", ...env },
  });
const secret = "SYNTHETIC_TOKEN=app-backup-not-a-real-secret\n";

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

/** Every entry under the backup root with its bytes, so preservation checks are exact. */
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

async function feature(primary: string, directory: string, branch = "feature/app", name = "feature worktree") {
  const target = join(directory, name);
  await git(primary, "worktree", "add", "-b", branch, target);
  await fs.writeFile(join(target, "untracked.txt"), "untracked work\n");
  await fs.writeFile(join(target, ".env"), secret);
  return target;
}

async function backup(primary: string, input: string): Promise<string> {
  const created = await cli(primary, ["backup", "create", input]);
  expect(created.stderr).toBe("");
  expect(created.exitCode).toBe(0);
  const id = /^Backup created: (\S+)$/mu.exec(created.stdout)?.[1];
  if (!id) throw new Error("No backup ID in output");
  return id;
}

/** The digest an app reads from the backup list: SHA-256 of the exact record.json bytes. */
async function recordDigest(directory: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(join(directory, "record.json"))).digest("hex");
}

async function readResult(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
}

/** In process, so file system spies reach the deletion. */
async function appDelete(primary: string, id: string, digest: string, resultFile: string) {
  let stdout = "";
  let stderr = "";
  const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
  let exitCode: number;
  let error: unknown = null;
  try { exitCode = await runAppBackup("delete", { id, recordSha256: digest, resultFile }, { cwd: primary, io }); }
  catch (caught) { exitCode = 1; error = caught; }
  return { exitCode, stdout, stderr, error, record: await readResult(resultFile) };
}

test("restore --result-file records a successful restore with the recovery worktree, branch and commit", async () => {
  await withRepository(async (primary, directory) => {
    const target = await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const commit = await git(target, "rev-parse", "HEAD");
    const destination = join(directory, "recovered tree");
    const resultFile = join(directory, "restore.json");
    const restored = await cli(primary, ["backup", "restore", "--result-file", resultFile, id, destination]);
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout).toContain(`Restored backup ${id}`);
    const record = await readResult(resultFile);
    expect(record).toMatchObject({
      schemaVersion: 1, command: "backup-restore", outcome: "succeeded", exitCode: 0, worktree: null,
      materialized: false, diagnostic: null,
      backupRestore: { result: "restored", id, worktree: destination, branch: `recovery/${id}`, commit, remaining: null, cleanup: [] },
    });
    expect((record.repository as { commonGitDir: string }).commonGitDir).toBe(await fs.realpath(join(primary, ".git")));
    expect(await fs.readFile(join(destination, ".env"), "utf8")).toBe(secret);
    expect(await git(destination, "rev-parse", "HEAD")).toBe(commit);
  });
});

test("restore --result-file records refusals and creates nothing", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const existing = join(directory, "existing");
    await fs.mkdir(existing);
    const branches = await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/");
    const worktrees = await git(primary, "worktree", "list", "--porcelain");
    for (const [name, args, expectedId] of [
      ["collision", [id, existing], id],
      ["unknown", ["20000101T000000Z-00000000", join(directory, "new one")], "20000101T000000Z-00000000"],
      ["malformed", ["../../etc", join(directory, "new two")], null],
    ] as const) {
      const resultFile = join(directory, `${name}.json`);
      const refused = await cli(primary, ["backup", "restore", "--result-file", resultFile, ...args]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("error: ");
      const record = await readResult(resultFile);
      expect(record).toMatchObject({
        command: "backup-restore", outcome: "failed", exitCode: 1,
        backupRestore: { result: "refused", id: expectedId, worktree: null, branch: null, commit: null, remaining: null, cleanup: [] },
      });
      expect(typeof record.diagnostic).toBe("string");
    }
    expect(await fs.readdir(existing)).toEqual([]);
    expect(await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/")).toBe(branches);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(worktrees);
  });
});

test("restore --result-file refuses an existing result file before any work", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const resultFile = join(directory, "taken.json");
    await fs.writeFile(resultFile, "keep\n");
    const destination = join(directory, "never created");
    const refused = await cli(primary, ["backup", "restore", "--result-file", resultFile, id, destination]);
    expect(refused.exitCode).toBe(1);
    expect(await fs.readFile(resultFile, "utf8")).toBe("keep\n");
    await expect(fs.lstat(destination)).rejects.toThrow();
  });
});

test("restore --result-file reports a partial restore with what remains and the manual cleanup commands", async () => {
  if (process.platform === "win32") return;
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const branch = `recovery/${id}`;
    const destination = join(directory, "partial recovery");
    const bin = join(directory, "git wrapper");
    await fs.mkdir(bin);
    await fs.writeFile(join(bin, "git"), [
      "#!/bin/sh",
      "for arg do",
      '  if [ "$arg" = read-tree ]; then exit 73; fi',
      "done",
      'exec "$TIMBER_REAL_GIT" "$@"',
      "",
    ].join("\n"));
    await fs.chmod(join(bin, "git"), 0o755);
    const resultFile = join(directory, "partial.json");
    const failed = await cli(primary, ["backup", "restore", "--result-file", resultFile, id, destination], {
      PATH: bin + delimiter + process.env.PATH, TIMBER_REAL_GIT: (await execa("which", ["git"])).stdout,
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("incomplete and must not be used");
    const record = await readResult(resultFile);
    expect(record).toMatchObject({
      command: "backup-restore", outcome: "failed", exitCode: 1,
      backupRestore: {
        result: "partial", id, worktree: null, branch: null, commit: null,
        remaining: { worktree: destination, branch },
        cleanup: [`git worktree remove --force -- '${destination}'`, `git branch -D -- '${branch}'`],
      },
    });
    expect(record.diagnostic).toContain("incomplete and must not be used");
    expect(await git(destination, "symbolic-ref", "HEAD")).toBe(`refs/heads/${branch}`);
    // The backup itself is untouched and still restorable after the advertised cleanup.
    expect(await entries(primary)).toEqual([id]);
    await git(primary, "worktree", "remove", "--force", "--", destination);
    await git(primary, "branch", "-D", "--", branch);
    expect((await cli(primary, ["backup", "restore", id, destination])).exitCode).toBe(0);
  });
});

test("__app-backup delete removes only the confirmed backup and records it", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    await feature(primary, directory, "feature/other", "other worktree");
    const id = await backup(primary, "feature/app");
    const other = await backup(primary, "feature/other");
    await fs.writeFile(join(root(primary), "unrelated note"), "keep\n");
    const otherBefore = await storageSnapshot(primary);
    const digest = await recordDigest(join(root(primary), id));
    const resultFile = join(directory, "delete.json");
    const deleted = await cli(primary, ["__app-backup", "delete", "--id", id, "--record-sha256", digest, "--result-file", resultFile]);
    expect(deleted.stderr).toBe("");
    expect(deleted.exitCode).toBe(0);
    expect(deleted.stdout).toBe(`Deleted backup ${id}`);
    expect(await readResult(resultFile)).toMatchObject({
      schemaVersion: 1, command: "backup-delete", outcome: "succeeded", exitCode: 0, worktree: null, materialized: false,
      diagnostic: null, backupDelete: { result: "deleted", id, remaining: null, cleanup: [] },
    });
    expect(await entries(primary)).toEqual([other, "unrelated note"].sort());
    const expected = Object.fromEntries(Object.entries(otherBefore).filter(([path]) => !path.startsWith(`${id}/`) && path !== `${id}/`));
    expect(await storageSnapshot(primary)).toEqual(expected);
    expect(await timberRefs(primary)).toBe(`refs/timber/backups/${other} ${await git(primary, "rev-parse", `refs/timber/backups/${other}`)}`);
  });
});

test.each([
  ["a digest that does not match the record", async (_primary: string, _id: string, digest: string) => digest.replace(/^./u, c => c === "0" ? "1" : "0"),
    "its record differs from the one that was confirmed"],
  ["a record rewritten after it was shown", async (primary: string, id: string, digest: string) => {
    const path = join(root(primary), id, "record.json");
    const record = JSON.parse(await fs.readFile(path, "utf8")) as { createdAt: string };
    record.createdAt = "2000-01-01T00:00:00.000Z";
    await fs.writeFile(path, JSON.stringify(record) + "\n");
    return digest;
  }, "its record differs from the one that was confirmed"],
  ["a protected backup", async (_primary: string, _id: string, digest: string, target: string) => {
    const admin = await git(target, "rev-parse", "--absolute-git-dir");
    await fs.mkdir(join(admin, "rebase-merge"));
    await fs.writeFile(join(admin, "rebase-merge", "head-name"), "refs/heads/feature/app\n");
    return digest;
  }, "it is protected: its source worktree has a rebase in progress"],
  ["a moved private ref", async (primary: string, id: string, digest: string) => {
    await git(primary, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-m", "moved");
    await git(primary, "update-ref", `refs/timber/backups/${id}`, await git(primary, "rev-parse", "HEAD"));
    return digest;
  }, "it is not usable"],
  ["an extra file in the backup", async (primary: string, id: string, digest: string) => {
    await fs.writeFile(join(root(primary), id, "unrelated.txt"), "keep me\n", { mode: 0o600 });
    return digest;
  }, "it is not usable"],
  ["a backup directory substituted by a link", async (primary: string, id: string, digest: string, _target: string, directory: string) => {
    const moved = join(directory, "moved backup");
    await fs.rename(join(root(primary), id), moved);
    await fs.symlink(moved, join(root(primary), id));
    return digest;
  }, "it is not usable"],
] as const)("__app-backup delete refuses %s and leaves everything untouched", async (_name, change, reason) => {
  await withRepository(async (primary, directory) => {
    const target = await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const digest = await change(primary, id, await recordDigest(join(root(primary), id)), target, directory);
    const before = await storageSnapshot(primary);
    const refs = await timberRefs(primary);
    const moved = join(directory, "moved backup");
    const linkTarget = await fs.readdir(moved).then(names => names.sort(), () => null);
    const resultFile = join(directory, "refused.json");
    const refused = await cli(primary, ["__app-backup", "delete", "--id", id, "--record-sha256", digest, "--result-file", resultFile]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(`Kept backup ${id}: ${reason}`);
    const record = await readResult(resultFile);
    expect(record).toMatchObject({
      command: "backup-delete", outcome: "failed", exitCode: 1,
      backupDelete: { result: "refused", id, remaining: null, cleanup: [] },
    });
    expect(record.diagnostic).toContain(reason);
    expect(await storageSnapshot(primary)).toEqual(before);
    expect(await timberRefs(primary)).toBe(refs);
    if (linkTarget !== null) expect((await fs.readdir(moved)).sort()).toEqual(linkTarget);
  });
});

test("__app-backup delete refuses an unknown ID", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const before = await storageSnapshot(primary);
    const resultFile = join(directory, "unknown.json");
    const unknown = "20000101T000000Z-00000000";
    const refused = await cli(primary, ["__app-backup", "delete", "--id", unknown, "--record-sha256", "a".repeat(64), "--result-file", resultFile]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(`Kept backup ${unknown}: no backup with that ID exists`);
    expect(await readResult(resultFile)).toMatchObject({ backupDelete: { result: "refused", id: unknown } });
    expect(await storageSnapshot(primary)).toEqual(before);
    expect(await entries(primary)).toEqual([id]);
  });
});

test("__app-backup delete keeps a backup that changes while it is being deleted", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const digest = await recordDigest(join(root(primary), id));
    const refs = await timberRefs(primary);
    const actualRename = fs.rename;
    let injected = false;
    const racing = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!injected && String(to).endsWith(`.deleting-${id}`)) {
        injected = true;
        await fs.writeFile(join(String(from), "late.txt"), "late\n", { mode: 0o600 });
      }
      return actualRename(from, to);
    });
    let result;
    try { result = await appDelete(primary, id, digest, join(directory, "race.json")); }
    finally { racing.mockRestore(); }
    expect(injected).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(String(result.error)).toContain(`Kept backup ${id}: it changed while it was being deleted`);
    expect(result.record).toMatchObject({ outcome: "failed", backupDelete: { result: "refused", id } });
    expect(await entries(primary)).toEqual([id]);
    expect((await fs.readdir(join(root(primary), id))).includes("late.txt")).toBe(true);
    expect(await timberRefs(primary)).toBe(refs);
  });
});

test("__app-backup delete reports a partial deletion and a later run finishes it", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const digest = await recordDigest(join(root(primary), id));
    const deleting = join(await fs.realpath(root(primary)), `.deleting-${id}`);
    const actualUnlink = fs.unlink;
    const failing = spyOn(fs, "unlink").mockImplementation(async path => {
      if (String(path).endsWith("manifest.json")) throw Object.assign(new Error("synthetic failure"), { code: "EIO" });
      return actualUnlink(path);
    });
    let result;
    try { result = await appDelete(primary, id, digest, join(directory, "partial.json")); }
    finally { failing.mockRestore(); }
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(String(result.error)).toContain(`Backup ${id} was only partly deleted: its private ref was removed; 2 files remain in`);
    expect(result.record).toMatchObject({
      command: "backup-delete", outcome: "failed", exitCode: 1,
      backupDelete: {
        result: "partial", id,
        remaining: { directory: deleting, directoryState: "present", files: 2, ref: `refs/timber/backups/${id}`, refState: "removed" },
        cleanup: [`rm -r -- '${deleting}'`],
      },
    });
    expect(await entries(primary)).toEqual([`.deleting-${id}`]);
    expect(await timberRefs(primary)).toBe("");

    // A different digest does not finish a deletion whose record still exists.
    const wrong = await appDelete(primary, id, "0".repeat(64), join(directory, "wrong.json"));
    expect(wrong.record).toMatchObject({ backupDelete: { result: "refused" } });
    expect(await entries(primary)).toEqual([`.deleting-${id}`]);

    const finished = await appDelete(primary, id, digest, join(directory, "finish.json"));
    expect(finished.exitCode).toBe(0);
    expect(finished.record).toMatchObject({ outcome: "succeeded", backupDelete: { result: "deleted", id } });
    expect(await entries(primary)).toEqual([]);
  });
});

test("__app-backup delete finishes an unfinished deletion whose record is already gone", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const digest = await recordDigest(join(root(primary), id));
    await git(primary, "update-ref", "-d", `refs/timber/backups/${id}`);
    const deleting = join(root(primary), `.deleting-${id}`);
    await fs.rename(join(root(primary), id), deleting);
    for (const name of await fs.readdir(deleting)) if (name !== "record.json") await fs.unlink(join(deleting, name));
    await fs.unlink(join(deleting, "record.json"));
    // Nothing restorable remains, so the ID alone identifies it; the digest is not checked.
    expect(digest).not.toBe("f".repeat(64));
    const finished = await appDelete(primary, id, "f".repeat(64), join(directory, "finish.json"));
    expect(finished.exitCode).toBe(0);
    expect(await entries(primary)).toEqual([]);
  });
});

test("__app-backup delete refuses incomplete invocations without a record or any change", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const digest = await recordDigest(join(root(primary), id));
    const before = await storageSnapshot(primary);
    for (const args of [
      ["delete", "--id", id, "--record-sha256", digest],
      ["delete", "--id", id, "--result-file", join(directory, "a.json")],
      ["delete", "--record-sha256", digest, "--result-file", join(directory, "b.json")],
      ["all", "--id", id, "--record-sha256", digest, "--result-file", join(directory, "c.json")],
    ]) {
      const refused = await cli(primary, ["__app-backup", ...args]);
      expect(refused.exitCode).toBe(1);
    }
    for (const name of ["a.json", "b.json", "c.json"]) await expect(fs.lstat(join(directory, name))).rejects.toThrow();
    const badDigest = join(directory, "bad.json");
    const refused = await cli(primary, ["__app-backup", "delete", "--id", id, "--record-sha256", digest.toUpperCase(), "--result-file", badDigest]);
    expect(refused.exitCode).toBe(1);
    expect(await readResult(badDigest)).toMatchObject({ backupDelete: { result: "refused", id } });
    expect(await storageSnapshot(primary)).toEqual(before);
  });
});

test("__app-backup delete refuses when a backup and an unfinished deletion share the ID", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const digest = await recordDigest(join(root(primary), id));
    await fs.mkdir(join(root(primary), `.deleting-${id}`), { mode: 0o700 });
    const before = await storageSnapshot(primary);
    const refs = await timberRefs(primary);
    const result = await appDelete(primary, id, digest, join(directory, "both.json"));
    expect(String(result.error)).toContain("more than one entry in backup storage has that ID");
    expect(result.record).toMatchObject({ backupDelete: { result: "refused", id } });
    expect(await storageSnapshot(primary)).toEqual(before);
    expect(await timberRefs(primary)).toBe(refs);
  });
});

test("__app-backup delete finishes an unfinished deletion that still has its record and ref, unless protected", async () => {
  await withRepository(async (primary, directory) => {
    const target = await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const digest = await recordDigest(join(root(primary), id));
    await fs.rename(join(root(primary), id), join(root(primary), `.deleting-${id}`));
    const admin = await git(target, "rev-parse", "--absolute-git-dir");
    await fs.mkdir(join(admin, "rebase-merge"));
    await fs.writeFile(join(admin, "rebase-merge", "head-name"), "refs/heads/feature/app\n");
    const before = await storageSnapshot(primary);
    const refs = await timberRefs(primary);
    const protectedRun = await appDelete(primary, id, digest, join(directory, "protected.json"));
    expect(String(protectedRun.error)).toContain("it is protected");
    expect(protectedRun.record).toMatchObject({ backupDelete: { result: "refused", id } });
    expect(await storageSnapshot(primary)).toEqual(before);
    expect(await timberRefs(primary)).toBe(refs);

    await fs.rm(join(admin, "rebase-merge"), { recursive: true });
    const finished = await appDelete(primary, id, digest, join(directory, "finish.json"));
    expect(finished.exitCode).toBe(0);
    expect(finished.record).toMatchObject({ backupDelete: { result: "deleted", id } });
    expect(await entries(primary)).toEqual([]);
    expect(await timberRefs(primary)).toBe("");
  });
});

test("__app-backup delete that cannot rename back reports the remaining ref and directory with both cleanup commands", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const digest = await recordDigest(join(root(primary), id));
    const deleting = join(await fs.realpath(root(primary)), `.deleting-${id}`);
    const ref = `refs/timber/backups/${id}`;
    const actualRename = fs.rename;
    const racing = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith(`.deleting-${id}`)) {
        await fs.writeFile(join(String(from), "late.txt"), "late\n", { mode: 0o600 });
        return actualRename(from, to);
      }
      throw Object.assign(new Error("synthetic failure"), { code: "EIO" });
    });
    let result;
    try { result = await appDelete(primary, id, digest, join(directory, "stuck.json")); }
    finally { racing.mockRestore(); }
    expect(result.record).toMatchObject({
      outcome: "failed",
      backupDelete: {
        result: "partial", id,
        remaining: { directory: deleting, directoryState: "present", ref, refState: "present" },
        cleanup: [`git update-ref -d ${ref}`, `rm -r -- '${deleting}'`],
      },
    });
    expect(await timberRefs(primary)).toContain(ref);
    // The advertised commands leave nothing behind.
    await git(primary, "update-ref", "-d", ref);
    await fs.rm(deleting, { recursive: true });
    expect((await cli(primary, ["backup", "list"])).stdout).toBe("No recovery backups in this repository.");
  });
});

test("__app-backup delete reports a partial deletion when Git cannot start after the rename", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const digest = await recordDigest(join(root(primary), id));
    const actualGit = backupGitModule.backupGit;
    const broken = spyOn(backupGitModule, "backupGit").mockImplementation(async (cwd, args) => {
      if (args.includes("update-ref")) throw new Error("Could not start Git for backup; check the Git installation and repository access.");
      return actualGit(cwd, args);
    });
    let result;
    try { result = await appDelete(primary, id, digest, join(directory, "nogit.json")); }
    finally { broken.mockRestore(); }
    expect(result.exitCode).toBe(1);
    expect(result.record).toMatchObject({
      backupDelete: { result: "partial", id, remaining: { directoryState: "present", refState: "present" } },
    });
    expect(await entries(primary)).toEqual([`.deleting-${id}`]);
    const finished = await appDelete(primary, id, digest, join(directory, "finish.json"));
    expect(finished.record).toMatchObject({ backupDelete: { result: "deleted", id } });
    expect(await entries(primary)).toEqual([]);
    expect(await timberRefs(primary)).toBe("");
  });
});

/** A Git wrapper whose `worktree add` fails, optionally after creating the recovery branch. */
async function failingWorktreeAdd(directory: string): Promise<Record<string, string>> {
  const bin = join(directory, "worktree add wrapper");
  await fs.mkdir(bin);
  await fs.writeFile(join(bin, "git"), [
    "#!/bin/sh",
    "for arg do",
    '  if [ "$arg" = --no-checkout ]; then',
    '    if [ -n "$TIMBER_TEST_BRANCH" ]; then "$TIMBER_REAL_GIT" branch "$TIMBER_TEST_BRANCH" >/dev/null 2>&1; fi',
    "    exit 1",
    "  fi",
    "done",
    'exec "$TIMBER_REAL_GIT" "$@"',
    "",
  ].join("\n"));
  await fs.chmod(join(bin, "git"), 0o755);
  return { PATH: bin + delimiter + process.env.PATH, TIMBER_REAL_GIT: (await execa("which", ["git"])).stdout };
}

test("restore --result-file reports a branch left by a failed worktree add, and a refusal when nothing is left", async () => {
  if (process.platform === "win32") return;
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/app");
    const branch = `recovery/${id}`;
    const env = await failingWorktreeAdd(directory);

    const nothing = join(directory, "nothing.json");
    const refused = await cli(primary, ["backup", "restore", "--result-file", nothing, id, join(directory, "dest one")], env);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("nothing was restored");
    expect(await readResult(nothing)).toMatchObject({
      backupRestore: { result: "refused", id, remaining: null, cleanup: [] },
    });

    const left = join(directory, "left.json");
    const partial = await cli(primary, ["backup", "restore", "--result-file", left, id, join(directory, "dest two")],
      { ...env, TIMBER_TEST_BRANCH: branch });
    expect(partial.exitCode).toBe(1);
    expect(partial.stderr).toContain(`git branch -D -- '${branch}'`);
    expect(await readResult(left)).toMatchObject({
      backupRestore: { result: "partial", id, remaining: { worktree: null, branch }, cleanup: [`git branch -D -- '${branch}'`] },
    });
    expect(await git(primary, "branch", "--list", branch)).toContain(branch);
  });
});
