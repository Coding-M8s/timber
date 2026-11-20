import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { cleanupBackups, readBackupList, setBackupKeep } from "../src/backup/lifecycle";
import { createBackup } from "../src/backup/service";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import type { TerminalTextPrompt } from "../src/selection";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const day = 24 * 60 * 60 * 1000;
const secret = "SYNTHETIC_TOKEN=retention-not-a-real-secret\n";
const identity = ["-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid"];

/** Each test gets its own global config directory so a developer's config never leaks in. */
function cliFor(configHome: string) {
  return (cwd: string, ...args: string[]) => execa(process.execPath, ["--no-env-file", entry, ...args], {
    cwd, reject: false, timeout: 15_000, env: { CI: "true", GIT_EDITOR: "false", XDG_CONFIG_HOME: configHome },
  });
}

async function setup(primary: string, directory: string, globalConfig = "") {
  const configHome = join(directory, "config home");
  await fs.mkdir(join(configHome, "timber"), { recursive: true });
  await fs.writeFile(join(configHome, "timber/config.toml"), globalConfig);
  const cli = cliFor(configHome);
  const target = join(directory, "feature worktree");
  await git(primary, "worktree", "add", "-b", "feature/retention", target);
  await fs.writeFile(join(target, "untracked.txt"), "untracked work\n");
  await fs.writeFile(join(target, ".env"), secret);
  const backup = async (...extra: string[]) => {
    const created = await cli(primary, "backup", "create", ...extra, "feature/retention");
    expect(created.stderr).toBe("");
    expect(created.exitCode).toBe(0);
    const id = /^Backup created: (\S+)$/mu.exec(created.stdout)?.[1];
    if (!id) throw new Error("No backup ID in output");
    return { id, stdout: created.stdout };
  };
  return { cli, target, configHome, backup };
}

function root(primary: string): string {
  return join(primary, ".git/timber/backups");
}

async function entries(primary: string): Promise<string[]> {
  try { return (await fs.readdir(root(primary))).sort(); } catch { return []; }
}

async function timberRefs(primary: string): Promise<string> {
  return git(primary, "for-each-ref", "--format=%(refname) %(objectname)", "refs/timber/");
}

async function readRecord(primary: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(join(root(primary), id, "record.json"), "utf8")) as Record<string, unknown>;
}

async function writeRecord(primary: string, id: string, record: Record<string, unknown>): Promise<void> {
  await fs.writeFile(join(root(primary), id, "record.json"), JSON.stringify(record) + "\n", { mode: 0o600 });
}

/** Rewrite a backup as a version 1 record, which has no retention policy. */
async function makeVersion1(primary: string, id: string): Promise<void> {
  const { origin: _o, retentionDays: _r, keep: _k, ...rest } = await readRecord(primary, id);
  await writeRecord(primary, id, { ...rest, version: 1 });
}

function io() {
  const out = { stdout: "", stderr: "" };
  return { out, io: { stdout: (text: string) => { out.stdout += text; }, stderr: (text: string) => { out.stderr += text; } } };
}

async function cleanup(primary: string, now: Date) {
  const { out, io: capture } = io();
  const exitCode = await cleanupBackups(await discoverRepository(primary), capture, now);
  return { exitCode, ...out };
}

function createdAt(record: Record<string, unknown>): number {
  return Date.parse(record.createdAt as string);
}

function prompt(answers: (string | null)[]) {
  const asked: string[] = [];
  const ask: TerminalTextPrompt = async message => {
    asked.push(message);
    if (!answers.length) throw new Error(`Unexpected prompt: ${message}`);
    return answers.shift()!;
  };
  return { ask, asked };
}

test("new backups capture the configured retention; later config changes do not touch them", async () => {
  await withRepository(async (primary, directory) => {
    const { backup, configHome, cli } = await setup(primary, directory, "backup_retention_days = 3\n");
    const first = await backup();
    expect(first.stdout).toMatch(/^Retention: expires \S+Z \(3 days\)$/mu);
    expect(first.stdout).toContain("Expired backups that are not protected are deleted by a later timber backup create or timber backup cleanup");
    expect(first.stdout).toMatch(/^Recovery backups now: 1, \d+ B$/mu);
    expect(await readRecord(primary, first.id)).toMatchObject({ version: 2, origin: "manual", retentionDays: 3, keep: false });

    // Repository config overrides global: until deleted.
    await fs.writeFile(join(primary, ".timber.toml"), "backup_retention_days = false\n");
    const second = await backup();
    expect(second.stdout).toContain("Retention: kept until deleted (no expiry when created)");
    expect(await readRecord(primary, second.id)).toMatchObject({ retentionDays: null, keep: false });
    expect(await readRecord(primary, first.id)).toMatchObject({ retentionDays: 3 });

    const kept = await backup("--keep");
    expect(kept.stdout).toContain("Retention: kept indefinitely");
    expect(await readRecord(primary, kept.id)).toMatchObject({ keep: true });

    // Invalid configuration refuses before anything changes.
    await fs.writeFile(join(configHome, "timber/config.toml"), "backup_retention_days = 0\n");
    const before = await entries(primary);
    const refused = await cli(primary, "backup", "create", "feature/retention");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("backup_retention_days is invalid");
    expect(await entries(primary)).toEqual(before);
  });
});

test("cleanup deletes only expired unprotected backups, at the exact boundary, and preserves everything else", async () => {
  await withRepository(async (primary, directory) => {
    const { backup } = await setup(primary, directory);
    const expiring = await backup();
    const kept = await backup("--keep");
    const legacy = await backup();
    await makeVersion1(primary, legacy.id);
    await fs.writeFile(join(primary, ".timber.toml"), "backup_retention_days = false\n");
    const untilDeleted = await backup();
    // Unrelated storage entries and refs must survive.
    await fs.writeFile(join(root(primary), "unrelated"), "keep me");
    await git(primary, "update-ref", "refs/timber/other", "HEAD");
    const expiresAt = createdAt(await readRecord(primary, expiring.id)) + 7 * day;

    const early = await cleanup(primary, new Date(expiresAt - 1));
    expect(early.exitCode).toBe(0);
    expect(early.stdout).toBe("No expired backups; nothing was deleted.\n");
    expect(await entries(primary)).toContain(expiring.id);

    const refsBefore = await timberRefs(primary);
    const far = new Date(expiresAt + 1000 * day);
    const boundary = await cleanup(primary, new Date(expiresAt));
    expect(boundary.exitCode).toBe(0);
    expect(boundary.stderr).toBe("");
    expect(boundary.stdout).toMatch(new RegExp(`^Deleted expired backup ${expiring.id} \\(\\d+ B, expired \\S+Z\\)$`, "mu"));
    expect(boundary.stdout).toMatch(/^Deleted 1 expired backup \(\d+ B\)\.$/mu);
    expect((await entries(primary)).sort()).toEqual([kept.id, legacy.id, untilDeleted.id, "unrelated"].sort());
    const refsAfter = await timberRefs(primary);
    expect(refsAfter).not.toContain(expiring.id);
    expect(refsAfter.split("\n").length).toBe(refsBefore.split("\n").length - 1);
    expect(refsAfter).toContain("refs/timber/other");
    expect(await fs.readFile(join(root(primary), "unrelated"), "utf8")).toBe("keep me");

    const later = await cleanup(primary, far);
    expect(later.stdout).toBe("No expired backups; nothing was deleted.\n");
    expect((await entries(primary)).sort()).toEqual([kept.id, legacy.id, untilDeleted.id, "unrelated"].sort());

    // Listing reports every state accurately at a controlled time.
    const record = await readBackupList(primary, discoverRepository, far);
    const states = Object.fromEntries(record.backups.map(item => [item.id, item.expiry?.state ?? null]));
    expect(states).toEqual({ [kept.id]: "kept", [legacy.id]: null, [untilDeleted.id]: "until-deleted" });
  });
});

test("expired backups of an active or uncertain rebase are protected from cleanup and listed as such", async () => {
  await withRepository(async (primary, directory) => {
    const { backup, target, cli } = await setup(primary, directory);
    const { id } = await backup();
    await fs.writeFile(join(target, "tracked.txt"), "feature side\n");
    await git(target, "add", "tracked.txt");
    await git(target, ...identity, "commit", "-m", "feature edit");
    await fs.writeFile(join(primary, "tracked.txt"), "trunk side\n");
    await git(primary, "add", "tracked.txt");
    await git(primary, ...identity, "commit", "-m", "trunk edit");
    const rebase = await execa("git", [...identity, "rebase", "trunk"], { cwd: target, reject: false, env: { GIT_EDITOR: "true" } });
    expect(rebase.exitCode).not.toBe(0);
    const far = new Date(createdAt(await readRecord(primary, id)) + 30 * day);

    const refs = await timberRefs(primary);
    const active = await cleanup(primary, far);
    expect(active.exitCode).toBe(0);
    expect(active.stdout).toContain(`Kept expired backup ${id}: it is protected, its source worktree has a rebase in progress.`);
    expect(await entries(primary)).toEqual([id]);
    expect(await timberRefs(primary)).toBe(refs);
    const listed = await readBackupList(primary, discoverRepository, far);
    expect(listed.backups[0]).toMatchObject({ protection: { protected: true }, expiry: { state: "expired" } });

    // Abort the rebase, then make rebase state uncertain: a link in worktrees/ cannot be inspected.
    await git(target, "rebase", "--abort");
    await fs.symlink(directory, join(primary, ".git/worktrees/linked"));
    const uncertain = await cleanup(primary, far);
    expect(uncertain.stdout).toContain(`Kept expired backup ${id}: it is protected, rebase state in this repository cannot be inspected (uncertain rebase).`);
    expect(await entries(primary)).toEqual([id]);
    const text = await cli(primary, "backup", "list");
    expect(text.stdout).toContain("Protection: protected");
    await fs.unlink(join(primary, ".git/worktrees/linked"));

    // With nothing in progress it is eligible again.
    const done = await cleanup(primary, far);
    expect(done.stdout).toContain(`Deleted expired backup ${id}`);
    expect(await entries(primary)).toEqual([]);
  });
});

test("a backup kept while cleanup is deleting it is restored and never deleted", async () => {
  await withRepository(async (primary, directory) => {
    const { backup } = await setup(primary, directory);
    const { id } = await backup();
    const far = new Date(createdAt(await readRecord(primary, id)) + 30 * day);
    const actualRename = fs.rename;
    let changed = false;
    const intercept = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!changed && String(to).endsWith(`.deleting-${id}`)) {
        changed = true;
        await writeRecord(primary, id, { ...await readRecord(primary, id), keep: true });
      }
      return actualRename(from, to);
    });
    let result;
    try { result = await cleanup(primary, far); } finally { intercept.mockRestore(); }
    expect(changed).toBe(true);
    expect(result.stderr).toContain(`Kept expired backup ${id}: it changed while it was being deleted.`);
    expect(await entries(primary)).toEqual([id]);
    expect(await readRecord(primary, id)).toMatchObject({ keep: true });
    expect(await timberRefs(primary)).toContain(id);
  });
});

test("keep and unkeep change only the record, invalidate an app confirmation, and refuse version 1", async () => {
  await withRepository(async (primary, directory) => {
    const { backup, cli } = await setup(primary, directory);
    const { id } = await backup();
    const legacy = await backup();
    await makeVersion1(primary, legacy.id);
    const listed = await readBackupList(primary, discoverRepository);
    const digest = listed.backups.find(item => item.id === id)!.recordSha256;
    const blobsBefore = (await fs.readdir(join(root(primary), id))).sort();

    const kept = await cli(primary, "backup", "keep", id);
    expect(kept.exitCode).toBe(0);
    expect(kept.stdout).toContain(`Backup ${id} is kept indefinitely; automatic cleanup will not delete it.`);
    expect(await readRecord(primary, id)).toMatchObject({ keep: true, retentionDays: 7 });
    expect((await fs.readdir(join(root(primary), id))).sort()).toEqual(blobsBefore);
    expect(await entries(primary)).toEqual([legacy.id, id].sort());
    const mode = (await fs.lstat(join(root(primary), id, "record.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
    const far = new Date(Date.now() + 30 * day);
    expect((await cleanup(primary, far)).stdout).toBe("No expired backups; nothing was deleted.\n");

    // An app confirmation of the old record no longer matches.
    const stale = await cli(primary, "__app-backup", "delete", "--id", id, "--record-sha256", digest,
      "--result-file", join(directory, "delete.json"));
    expect(stale.exitCode).toBe(1);
    expect(await entries(primary)).toContain(id);

    const again = await cli(primary, "backup", "keep", id);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("is already kept indefinitely");

    const { out, io: capture } = io();
    expect(await setBackupKeep(await discoverRepository(primary), id, false, capture, far)).toBe(0);
    expect(out.stdout).toContain(`Backup ${id} is no longer kept. Retention: expired `);
    expect(await readRecord(primary, id)).toMatchObject({ keep: false });

    const v1 = await cli(primary, "backup", "keep", legacy.id);
    expect(v1.exitCode).toBe(1);
    expect(v1.stderr).toContain("has no retention policy and is already kept until deleted");
    const unknown = await cli(primary, "backup", "unkeep", "20200101T000000Z-00000000");
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("no backup with that ID exists");
    expect((await cli(primary, "backup", "keep", "../x")).stderr).toContain("Invalid backup ID");

    // A leftover temporary record is reported, never treated as a backup or deleted.
    await fs.writeFile(join(root(primary), `.retain-${id}-0000abcd`), "{}", { mode: 0o600 });
    const text = await cli(primary, "backup", "list");
    expect(text.stdout).toContain(`.retain-${id}-0000abcd: temporary record left by an interrupted keep or unkeep`);
    await cleanup(primary, far);
    expect(await entries(primary)).toContain(`.retain-${id}-0000abcd`);
  });
});

test("noninteractive creation over the warning threshold refuses with sizes and creates nothing", async () => {
  await withRepository(async (primary, directory) => {
    const { cli, backup, configHome } = await setup(primary, directory, 'backup_storage_warning = "1B"\n');
    const refs = await timberRefs(primary);
    const refused = await cli(primary, "backup", "create", "feature/retention");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/Backup storage warning: this backup is about \d+ B\. With it, recovery backups would total \d+ B, over the 1 B warning threshold \(backup_storage_warning\)\./u);
    expect(refused.stderr).toContain("No backup was created.");
    expect(refused.stderr).not.toContain("retention-not-a-real-secret");
    expect(await entries(primary)).toEqual([]);
    expect(await timberRefs(primary)).toBe(refs);

    await fs.writeFile(join(configHome, "timber/config.toml"), "backup_storage_warning = false\n");
    await backup();
    expect((await entries(primary)).length).toBe(1);
  });
});

test("interactive warning: cancel creates nothing, review can free space, and continue creates", async () => {
  await withRepository(async (primary, directory) => {
    const { backup, target } = await setup(primary, directory);
    const existing = await backup();
    const repository = await discoverRepository(primary);
    const selected = (await listWorktrees(repository)).find(tree => tree.path === target)!;
    const size = (await readRecord(primary, existing.id)).bytes as number;
    // The new backup alone fits; together with the existing one it does not.
    const settings = { retentionDays: 7, warningBytes: size + Math.ceil(size / 2) };

    const cancelled = prompt([""]);
    const first = io();
    expect(await createBackup(repository, selected, first.io, { keep: false, settings, ask: cancelled.ask })).toBe(0);
    expect(first.out.stdout).toContain("Backup storage warning");
    expect(first.out.stdout).toContain("Existing: 1 backup");
    expect(first.out.stdout).toContain("Cancelled; no backup was created.");
    expect(cancelled.asked).toEqual(["Type c to continue, r to review backups for deletion, or press Enter to cancel [c/r/N] "]);
    expect(await entries(primary)).toEqual([existing.id]);

    // Review deletes the existing backup, the recheck fits, and no second question is asked.
    const reviewed = prompt(["r", "y"]);
    const second = io();
    expect(await createBackup(repository, selected, second.io, { keep: false, settings, ask: reviewed.ask })).toBe(0);
    expect(reviewed.asked.length).toBe(2);
    expect(second.out.stdout).toContain(`Deleted backup ${existing.id}`);
    const created = /^Backup created: (\S+)$/mu.exec(second.out.stdout)?.[1];
    expect(await entries(primary)).toEqual([created!]);

    const continued = prompt(["c"]);
    const third = io();
    expect(await createBackup(repository, selected, third.io, { keep: false, settings, ask: continued.ask })).toBe(0);
    expect(third.out.stdout).toContain("Backup created: ");
    expect((await entries(primary)).length).toBe(2);
  });
});

test("backup create runs expiry cleanup first and reports it", async () => {
  await withRepository(async (primary, directory) => {
    const { backup, target } = await setup(primary, directory);
    const old = await backup();
    const repository = await discoverRepository(primary);
    const selected = (await listWorktrees(repository)).find(tree => tree.path === target)!;
    const later = new Date(createdAt(await readRecord(primary, old.id)) + 8 * day);
    const { out, io: capture } = io();
    expect(await createBackup(repository, selected, capture,
      { keep: false, settings: { retentionDays: 7, warningBytes: null }, now: () => later })).toBe(0);
    expect(out.stdout).toContain(`Deleted expired backup ${old.id}`);
    const created = /^Backup created: (\S+)$/mu.exec(out.stdout)?.[1]!;
    expect(created.startsWith(later.toISOString().slice(0, 10).replace(/-/gu, ""))).toBe(true);
    expect(await entries(primary)).toEqual([created]);
    expect(out.stdout).toMatch(/^Recovery backups now: 1, /mu);
  });
});
