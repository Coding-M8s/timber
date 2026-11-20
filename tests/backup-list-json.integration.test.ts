import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execa } from "execa";
import type { BackupListRecord } from "../src/backup/lifecycle";
import { safeDisplay } from "../src/display";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, args: string[], env: Record<string, string> = {}) => execa(process.execPath,
  ["--no-env-file", entry, ...args], { cwd, reject: false, timeout: 15_000, stripFinalNewline: false, env: { CI: "true", GIT_EDITOR: "false", XDG_CONFIG_HOME: "/nonexistent/timber-test-config", ...env } });
const secret = "SYNTHETIC_TOKEN=list-json-not-a-real-secret\n";
const identity = ["-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid"];

function root(primary: string): string {
  return join(primary, ".git/timber/backups");
}

async function recordDigest(directory: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(join(directory, "record.json"))).digest("hex");
}

async function feature(primary: string, directory: string, branch = "feature/lifecycle", name = "feature worktree") {
  const target = join(directory, name);
  await git(primary, "worktree", "add", "-b", branch, target);
  await fs.writeFile(join(target, "untracked.txt"), "untracked work\n");
  await fs.writeFile(join(target, ".env"), secret);
  return target;
}

async function backup(primary: string, input: string): Promise<string> {
  const created = await cli(primary, ["backup", "create", input]);
  expect(created.exitCode).toBe(0);
  const id = /^Backup created: (\S+)$/mu.exec(created.stdout)?.[1];
  if (!id) throw new Error("No backup ID in output");
  return id;
}

/** Every path under the Git directory with its bytes, plus each worktree's status, so a read can be proven inert. */
async function repositoryState(primary: string, worktrees: readonly string[]): Promise<string> {
  const result: string[] = [];
  const walk = async (directory: string, prefix: string) => {
    for (const name of (await fs.readdir(directory)).sort()) {
      // Git may refresh its index stat cache on any read; that is not Timber's write.
      if (prefix === "" && name === "index") continue;
      const path = join(directory, name);
      const info = await fs.lstat(path);
      if (info.isSymbolicLink()) result.push(`${prefix}${name} -> ${await fs.readlink(path)}`);
      else if (info.isDirectory()) { result.push(`${prefix}${name}/ ${(info.mode & 0o777).toString(8)}`); await walk(path, `${prefix}${name}/`); }
      else result.push(`${prefix}${name} ${(info.mode & 0o777).toString(8)} ${(await fs.readFile(path)).toString("base64")}`);
    }
  };
  await walk(join(primary, ".git"), "");
  for (const tree of worktrees) result.push(`${tree}: ${await git(tree, "status", "--porcelain=v1", "--ignored", "--untracked-files=all")}`);
  return result.join("\n");
}

async function listJson(primary: string, env: Record<string, string> = {}): Promise<BackupListRecord> {
  const listed = await cli(primary, ["backup", "list", "--json"], env);
  expect(listed.stderr).toBe("");
  const record = JSON.parse(listed.stdout) as BackupListRecord;
  expect(listed.stdout.endsWith("}\n")).toBe(true);
  expect(listed.exitCode).toBe(record.exitCode);
  return record;
}

/** The text form must show every JSON entry with the same reason and protection. */
async function expectTextParity(primary: string, record: BackupListRecord): Promise<void> {
  const text = (await cli(primary, ["backup", "list"])).stdout;
  expect(text).toContain(`Recovery backups: ${record.backups.length} (`);
  for (const item of record.backups) {
    const protection = item.protection.protected ? `protected, ${item.protection.reason}` : "none";
    expect(text).toContain(`${item.id}\n  Branch: ${item.branch === null ? "detached HEAD" : safeDisplay(item.branch)}\n  Created: ${item.createdAt}\n`);
    expect(text).toContain(`, ${item.entries} entries\n  Source worktree: ${safeDisplay(item.worktreePath)}\n  Protection: ${protection}\n`);
  }
  for (const item of record.unfinished) expect(text).toContain(`  ${item.id}: deletion did not complete; ${safeDisplay(item.directory)} remains`);
  for (const item of record.notUsable) expect(text).toContain(`  ${safeDisplay(item.name)}: ${item.reason}`);
  // Nothing in the text sections is missing from JSON: count the entry lines under each heading.
  const section = (heading: string) => {
    const lines = text.split("\n");
    const start = lines.findIndex(line => line.startsWith(heading));
    if (start < 0) return 0;
    let count = 0;
    for (const line of lines.slice(start + 1)) { if (!line.startsWith("  ")) break; count++; }
    return count;
  };
  expect(section("Unfinished deletions")).toBe(record.unfinished.length);
  expect(section("Not usable")).toBe(record.notUsable.length);
}

test("JSON list reports usable, unusable and unfinished entries with the text list's reasons and changes nothing", async () => {
  await withRepository(async (primary, directory) => {
    const target = await feature(primary, directory);
    const id = await backup(primary, "feature/lifecycle");
    const finishing = await backup(primary, "feature/lifecycle");
    const commit = await git(target, "rev-parse", "HEAD");
    const storage = root(primary);
    // Malformed record, nonprivate record, unexpected extra file, moved ref, unrecognized
    // control-character name, interrupted creation, orphan ref, symlinked decoy, unfinished deletion.
    await fs.mkdir(join(storage, "20260101T000000Z-00000001"), { mode: 0o700 });
    await fs.writeFile(join(storage, "20260101T000000Z-00000001", "record.json"), "{not json", { mode: 0o600 });
    await fs.cp(join(storage, id), join(storage, "20260101T000000Z-00000005"), { recursive: true });
    await fs.chmod(join(storage, "20260101T000000Z-00000005", "record.json"), 0o644);
    await fs.mkdir(join(storage, "evil\nname"), { mode: 0o700 });
    await fs.mkdir(join(storage, ".incomplete-20260101T000000Z-00000002"), { mode: 0o700 });
    await git(primary, "update-ref", "refs/timber/backups/20260101T000000Z-00000003", commit);
    const decoy = join(directory, "decoy");
    await fs.cp(join(storage, id), decoy, { recursive: true });
    await fs.symlink(decoy, join(storage, "20260101T000000Z-00000004"));
    await git(primary, "update-ref", "-d", `refs/timber/backups/${finishing}`);
    await fs.rename(join(storage, finishing), join(storage, `.deleting-${finishing}`));
    const extra = await backup(primary, "feature/lifecycle");
    await fs.writeFile(join(storage, extra, "unexpected"), "x", { mode: 0o600 });
    const moved = await backup(primary, "feature/lifecycle");
    const other = await git(primary, ...identity, "commit-tree", "-m", "elsewhere", `${commit}^{tree}`);
    await git(primary, "update-ref", `refs/timber/backups/${moved}`, other);

    const before = await repositoryState(primary, [primary, target]);
    const record = await listJson(primary);
    expect(await repositoryState(primary, [primary, target])).toBe(before);

    expect(record.schemaVersion).toBe(1);
    expect(record).toMatchObject({ outcome: "succeeded", exitCode: 0, diagnostic: null });
    expect(record.repository).toEqual({ commonGitDir: join(primary, ".git"), primaryWorktreeRoot: primary, currentWorktreeRoot: primary });
    expect(record.backups).toEqual([{
      id, branch: "feature/lifecycle", commit, createdAt: expect.any(String), bytes: expect.any(Number),
      entries: expect.any(Number), worktreePath: target, recordSha256: await recordDigest(join(storage, id)),
      protection: { protected: false, reason: null },
      expiry: { state: "expiring", retentionDays: 7, expiresAt: expect.any(String) },
    }]);
    const listedExpiry = record.backups[0]!.expiry!;
    expect(Date.parse(listedExpiry.expiresAt!) - Date.parse(record.backups[0]!.createdAt)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(record.totalBytes).toBe(record.backups[0]!.bytes);
    expect(record.unfinished).toEqual([{ id: finishing, directory: join(storage, `.deleting-${finishing}`),
      recordSha256: await recordDigest(join(storage, `.deleting-${finishing}`)) }]);
    const reasons = Object.fromEntries(record.notUsable.map(item => [item.name, item.reason]));
    // Storage names ascending, then refs ascending.
    expect(record.notUsable.map(item => item.name)).toEqual([
      ...[".incomplete-20260101T000000Z-00000002", "20260101T000000Z-00000001", "20260101T000000Z-00000004",
        "20260101T000000Z-00000005", extra, moved, "evil\nname"].sort(),
      "refs/timber/backups/20260101T000000Z-00000003",
    ]);
    expect(reasons["20260101T000000Z-00000001"]).toStartWith("Backup record or manifest is missing, unreadable or not private");
    expect(reasons["20260101T000000Z-00000005"]).toStartWith("Backup record or manifest is missing, unreadable or not private");
    expect(reasons["20260101T000000Z-00000004"]).toStartWith("Backup storage is not a private directory");
    expect(reasons[extra]).toStartWith("Backup directory has missing or unexpected files");
    expect(reasons[moved]).toStartWith("The backup's private Git ref is missing or no longer names its commit");
    expect(reasons["evil\nname"]).toBe("unrecognized entry in backup storage");
    expect(reasons["refs/timber/backups/20260101T000000Z-00000003"]).toBe("private backup ref without a backup directory");
    // Only record facts: no snapshot file names or contents.
    const raw = JSON.stringify(record);
    for (const leak of ["SYNTHETIC_TOKEN", "untracked.txt", "untracked work", ".env", "tracked.txt"]) expect(raw).not.toContain(leak);

    await expectTextParity(primary, record);
    expect(await repositoryState(primary, [primary, target])).toBe(before);
  });
});

test("JSON list reports protected backups with the same reason as the text list", async () => {
  await withRepository(async (primary, directory) => {
    const target = await feature(primary, directory);
    await feature(primary, directory, "feature/other", "other worktree");
    const id = await backup(primary, "feature/lifecycle");
    const other = await backup(primary, "feature/other");
    // A paused rebase in the backed-up worktree protects only its own backup.
    await fs.writeFile(join(target, "tracked.txt"), "feature side\n");
    await git(target, "add", "tracked.txt");
    await git(target, ...identity, "commit", "-m", "feature edit");
    await fs.writeFile(join(primary, "tracked.txt"), "trunk side\n");
    await git(primary, "add", "tracked.txt");
    await git(primary, ...identity, "commit", "-m", "trunk edit");
    const rebase = await execa("git", [...identity, "rebase", "trunk"], { cwd: target, reject: false, env: { GIT_EDITOR: "true" } });
    expect(rebase.exitCode).not.toBe(0);

    const record = await listJson(primary);
    expect(record.outcome).toBe("succeeded");
    const protection = Object.fromEntries(record.backups.map(item => [item.id, item.protection]));
    expect(protection).toEqual({
      [id]: { protected: true, reason: "its source worktree has a rebase in progress" },
      [other]: { protected: false, reason: null },
    });
    expect(record.backups.map(item => item.id)).toEqual([id, other].sort());
    expect(record.totalBytes).toBe(record.backups.reduce((sum, item) => sum + item.bytes, 0));
    await expectTextParity(primary, record);

    // Rebase state without a readable branch makes every backup uncertain.
    await git(target, "rebase", "--abort");
    await fs.mkdir(join(primary, ".git/worktrees/elsewhere/rebase-merge"), { recursive: true });
    const uncertain = await listJson(primary);
    const reason = "a rebase whose branch cannot be identified is in progress (uncertain rebase)";
    expect(uncertain.backups.map(item => item.protection)).toEqual([{ protected: true, reason }, { protected: true, reason }]);
    await expectTextParity(primary, uncertain);
  });
});

test("JSON list with no storage is an empty success, creates nothing, and shows no first-use hint", async () => {
  await withRepository(async (primary, directory) => {
    const machine = join(directory, "machine");
    const env = { HOME: machine, XDG_CONFIG_HOME: join(machine, "config"), XDG_STATE_HOME: join(machine, "state") };
    const before = await repositoryState(primary, [primary]);
    const record = await listJson(primary, env);
    expect(record).toEqual({ schemaVersion: 1, outcome: "succeeded", exitCode: 0, repository: expect.any(Object),
      diagnostic: null, backups: [], unfinished: [], notUsable: [], totalBytes: 0 });
    expect(await repositoryState(primary, [primary])).toBe(before);
    await expect(fs.lstat(join(primary, ".git/timber"))).rejects.toThrow();
    // Bun may cache under HOME; Timber's own config and state stay absent.
    await expect(fs.lstat(join(machine, "config"))).rejects.toThrow();
    await expect(fs.lstat(join(machine, "state"))).rejects.toThrow();
  });
});

test("JSON list reports nonprivate storage as a failed record with the repository and exit 1", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    await backup(primary, "feature/lifecycle");
    await fs.chmod(root(primary), 0o755);
    const before = await repositoryState(primary, [primary]);
    const record = await listJson(primary);
    expect(record).toMatchObject({ outcome: "failed", exitCode: 1, backups: [], unfinished: [], notUsable: [], totalBytes: 0 });
    expect(record.repository?.primaryWorktreeRoot).toBe(primary);
    expect(record.diagnostic).toContain("Backup storage is not a private directory");
    expect(await repositoryState(primary, [primary])).toBe(before);
    // The text form refuses the same storage.
    expect((await cli(primary, ["backup", "list"])).exitCode).not.toBe(0);
  });
});

test("JSON list outside a repository is a failed record with no repository", async () => {
  const outside = await fs.mkdtemp(join(await fs.realpath(process.env.TMPDIR ?? "/tmp"), "timber outside "));
  try {
    const record = await listJson(outside, { GIT_CEILING_DIRECTORIES: outside });
    expect(record).toMatchObject({ schemaVersion: 1, outcome: "failed", exitCode: 1, repository: null, backups: [] });
    expect(record.diagnostic).toEqual(expect.any(String));
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("JSON list from a linked worktree reports a detached backup and the same storage", async () => {
  await withRepository(async (primary, directory) => {
    const target = join(directory, "detached worktree");
    await git(primary, "worktree", "add", "--detach", target);
    const id = await backup(primary, target);
    const fromPrimary = await listJson(primary);
    const fromLinked = await listJson(target);
    expect(fromLinked.repository).toEqual({ ...fromPrimary.repository!, currentWorktreeRoot: target });
    expect(fromLinked.backups).toEqual(fromPrimary.backups);
    expect(fromLinked.backups).toEqual([expect.objectContaining({ id, branch: null, worktreePath: target })]);
    await expectTextParity(target, fromLinked);
  });
});

test("the listed recordSha256 is what __app-backup delete accepts, and the list then omits the backup", async () => {
  await withRepository(async (primary, directory) => {
    await feature(primary, directory);
    const id = await backup(primary, "feature/lifecycle");
    const [listed] = (await listJson(primary)).backups;
    expect(listed?.id).toBe(id);
    const results = await fs.mkdtemp(join(directory, "results "));
    const deleted = await cli(primary, ["__app-backup", "delete", "--id", id, "--record-sha256", listed!.recordSha256,
      "--result-file", join(results, "delete.json")]);
    expect(deleted.exitCode).toBe(0);
    expect(JSON.parse(await fs.readFile(join(results, "delete.json"), "utf8")).backupDelete.result).toBe("deleted");
    const after = await listJson(primary);
    expect(after).toMatchObject({ outcome: "succeeded", backups: [], unfinished: [], notUsable: [] });
  });
});
