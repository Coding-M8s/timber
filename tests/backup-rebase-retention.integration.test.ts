import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { cleanupBackups, listBackups, readBackupList, reviewBackupDeletion } from "../src/backup/lifecycle";
import { createBackup } from "../src/backup/service";
import { cleanupWorktree } from "../src/git/cleanup";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import { config, options, quiet } from "./helpers/cleanup-discard";
import { git, withRepository } from "./helpers/git";

// Rebase-origin backups (#188): retention starts only once the rebase is reliably seen to end.
const day = 24 * 60 * 60 * 1000;
const identity = ["-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid"];
const branch = "feature/rebase-retention";

function capture() {
  const out = { stdout: "", stderr: "" };
  return { out, io: { stdout: (text: string) => { out.stdout += text; }, stderr: (text: string) => { out.stderr += text; } } };
}

/** A feature worktree paused on a conflicting rebase, backed up the way `timber rebase --resolve` does. */
async function pausedBackup(primary: string, directory: string) {
  const target = join(directory, "feature worktree");
  await git(primary, "worktree", "add", "-b", branch, target);
  await fs.writeFile(join(target, "tracked.txt"), "feature side\n");
  await git(target, "add", "tracked.txt");
  await git(target, ...identity, "commit", "-m", "feature edit");
  await fs.writeFile(join(primary, "tracked.txt"), "trunk side\n");
  await git(primary, "add", "tracked.txt");
  await git(primary, ...identity, "commit", "-m", "trunk edit");
  const rebase = await execa("git", [...identity, "rebase", "trunk"], { cwd: target, reject: false, env: { GIT_EDITOR: "true" } });
  expect(rebase.exitCode).not.toBe(0);
  const repository = await discoverRepository(primary);
  const selected = (await listWorktrees(repository)).find(tree => tree.path === target)!;
  const report: { id: string | null } = { id: null };
  const { out, io } = capture();
  expect(await createBackup(repository, selected, io,
    { keep: false, settings: { retentionDays: 7, warningBytes: null }, pausedRebaseBranch: branch, report })).toBe(0);
  expect(out.stdout).toContain("Retention: not started; 7 days start once the rebase it was made for is seen to finish or be aborted");
  const id = report.id!;
  const record = await readRecord(primary, id);
  expect(record).toMatchObject({ version: 2, origin: "rebase", retentionDays: 7, keep: false, retentionStartedAt: null, branch });
  return { target, id, createdAt: Date.parse(record.createdAt as string) };
}

async function readRecord(primary: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(join(primary, ".git/timber/backups", id, "record.json"), "utf8")) as Record<string, unknown>;
}

async function entries(primary: string): Promise<string[]> {
  try { return (await fs.readdir(join(primary, ".git/timber/backups"))).sort(); } catch { return []; }
}

async function cleanup(primary: string, now: Date) {
  const { out, io } = capture();
  const exitCode = await cleanupBackups(await discoverRepository(primary), io, now);
  return { exitCode, ...out };
}

async function listText(primary: string, now: Date): Promise<string> {
  const { out, io } = capture();
  expect(await listBackups(await discoverRepository(primary), io, now)).toBe(0);
  return out.stdout;
}

/** Once started at `start`, the backup survives until the exact expiry instant and is deleted from it on. */
async function expectRetentionFrom(primary: string, id: string, start: Date) {
  expect((await readRecord(primary, id)).retentionStartedAt).toBe(start.toISOString());
  const expiresAt = start.getTime() + 7 * day;
  const early = await cleanup(primary, new Date(expiresAt - 1));
  expect(early.stdout).not.toContain("Retention started");
  expect(await entries(primary)).toEqual([id]);
  const due = await cleanup(primary, new Date(expiresAt));
  expect(due.stdout).toContain(`Deleted expired backup ${id}`);
  expect(await entries(primary)).toEqual([]);
}

test("while the rebase is active the backup is protected, its retention never starts and cleanup keeps it", async () => {
  await withRepository(async (primary, directory) => {
    const { id, createdAt } = await pausedBackup(primary, directory);
    const far = new Date(createdAt + 1000 * day);
    const before = await fs.readFile(join(primary, ".git/timber/backups", id, "record.json"), "utf8");
    const result = await cleanup(primary, far);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("No expired backups; nothing was deleted.\n");
    expect(await fs.readFile(join(primary, ".git/timber/backups", id, "record.json"), "utf8")).toBe(before);

    const text = await listText(primary, far);
    expect(text).toContain("Protection: protected, its source worktree has a rebase in progress");
    expect(text).toContain("Retention: not started; 7 days start once the rebase it was made for is seen to finish or be aborted");
    const json = await readBackupList(primary, discoverRepository, far);
    expect(json.backups[0]).toMatchObject({ id, protection: { protected: true },
      expiry: { state: "not-started", retentionDays: 7, expiresAt: null } });
  });
});

test("a completed rebase starts retention when Timber observes it, never on a read-only list", async () => {
  await withRepository(async (primary, directory) => {
    const { target, id, createdAt } = await pausedBackup(primary, directory);
    await fs.writeFile(join(target, "tracked.txt"), "resolved\n");
    await git(target, "add", "tracked.txt");
    await execa("git", [...identity, "rebase", "--continue"], { cwd: target, env: { GIT_EDITOR: "true" } });

    const observed = new Date(createdAt + 30 * day);
    await listText(primary, observed);
    await readBackupList(primary, discoverRepository, observed);
    expect((await readRecord(primary, id)).retentionStartedAt).toBeNull();

    const result = await cleanup(primary, observed);
    expect(result.stdout).toContain(`Retention started for backup ${id}: its rebase was seen to finish or be aborted.`);
    expect(result.stdout).toContain("No expired backups; nothing was deleted.");
    await expectRetentionFrom(primary, id, observed);
  });
});

test("an explicitly aborted rebase starts retention through backup create's cleanup", async () => {
  await withRepository(async (primary, directory) => {
    const { target, id, createdAt } = await pausedBackup(primary, directory);
    await git(target, "rebase", "--abort");
    const observed = new Date(createdAt + 2 * day);
    const repository = await discoverRepository(primary);
    const selected = (await listWorktrees(repository)).find(tree => tree.path === target)!;
    const { out, io } = capture();
    expect(await createBackup(repository, selected, io,
      { keep: false, settings: { retentionDays: 7, warningBytes: null }, now: () => observed })).toBe(0);
    expect(out.stdout).toContain(`Retention started for backup ${id}`);
    expect((await readRecord(primary, id)).retentionStartedAt).toBe(observed.toISOString());
  });
});

test("uncertain rebase state keeps retention from starting until it can be inspected again", async () => {
  await withRepository(async (primary, directory) => {
    const { target, id, createdAt } = await pausedBackup(primary, directory);
    await git(target, "rebase", "--abort");
    // Auto-maintenance would prune this link in the background; withRepository turns it off.
    expect(await git(primary, "config", "maintenance.auto")).toBe("false");
    await fs.symlink(directory, join(primary, ".git/worktrees/linked"));
    const first = new Date(createdAt + 10 * day);
    const uncertain = await cleanup(primary, first);
    expect(uncertain.stdout).not.toContain("Retention started");
    expect((await readRecord(primary, id)).retentionStartedAt).toBeNull();
    expect(await listText(primary, first)).toContain("Protection: protected, rebase state in this repository cannot be inspected (uncertain rebase)");
    await fs.unlink(join(primary, ".git/worktrees/linked"));

    const later = new Date(createdAt + 20 * day);
    expect((await cleanup(primary, later)).stdout).toContain(`Retention started for backup ${id}`);
    await expectRetentionFrom(primary, id, later);
  });
});

test("a rebase directory removed without an observed outcome never starts retention; only a confirmed done deletes it", async () => {
  await withRepository(async (primary, directory) => {
    const { target, id, createdAt } = await pausedBackup(primary, directory);
    const rebaseDir = await git(target, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge");
    await fs.rm(rebaseDir, { recursive: true });
    const far = new Date(createdAt + 1000 * day);
    const result = await cleanup(primary, far);
    expect(result.stdout).toBe("No expired backups; nothing was deleted.\n");
    expect((await readRecord(primary, id)).retentionStartedAt).toBeNull();
    expect(await entries(primary)).toEqual([id]);
    const text = await listText(primary, far);
    expect(text).toContain("Protection: none");
    expect(text).toContain("Retention: not started");

    // An older finish of the same branch, before the backup, is not evidence either.
    const log = await git(target, "rev-parse", "--path-format=absolute", "--git-path", "logs/HEAD");
    const old = Math.floor(createdAt / 1000) - 60;
    await fs.appendFile(log, `${"0".repeat(40)} ${"1".repeat(40)} T <t@e> ${old} +0000\trebase (finish): returning to refs/heads/${branch}\n`);
    expect((await cleanup(primary, far)).stdout).not.toContain("Retention started");

    const answers = ["y"];
    const { out, io } = capture();
    expect(await reviewBackupDeletion(await discoverRepository(primary), { all: false }, io, async () => answers.shift() ?? null, far)).toBe(0);
    expect(out.stdout).toContain("Retention: not started");
    expect(await entries(primary)).toEqual([]);
  });
});

test("timber done observes the outcome before removing the worktree, whose reflog is the evidence", async () => {
  await withRepository(async (primary, directory) => {
    const { target, id } = await pausedBackup(primary, directory);
    await git(target, "rebase", "--abort");
    const repository = await discoverRepository(primary);
    const tree = (await listWorktrees(repository)).find(item => item.path === target)!;
    const before = Date.now();
    await cleanupWorktree(repository, tree, config, options, quiet, async () => true);
    expect(await fs.lstat(target).then(() => true, () => false)).toBe(false);
    const started = (await readRecord(primary, id)).retentionStartedAt as string;
    expect(Date.parse(started)).toBeGreaterThanOrEqual(before - 1000);
  });
});

test("a worktree removed outside Timber after the rebase ends leaves retention not started", async () => {
  await withRepository(async (primary, directory) => {
    const { target, id, createdAt } = await pausedBackup(primary, directory);
    await git(target, "rebase", "--abort");
    await git(primary, "worktree", "remove", "--force", target);
    const far = new Date(createdAt + 1000 * day);
    expect((await cleanup(primary, far)).stdout).toBe("No expired backups; nothing was deleted.\n");
    expect((await readRecord(primary, id)).retentionStartedAt).toBeNull();
  });
});
