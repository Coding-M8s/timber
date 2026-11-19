import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackupCreateHandler, createBackupDoneHandler, createBackupListHandler, createBackupRestoreHandler } from "../src/commands/backup";
import type { BackupListRecord } from "../src/backup/lifecycle";
import { assertStorageSpace, copySnapshot, sameListing, SnapshotError, walkWorktree } from "../src/backup/snapshot";
import { newBackupId, validateManifest, validateRecord } from "../src/backup/storage";
import type { CommandContext } from "../src/services";
import { createServiceDouble, repositoryFixture } from "./helpers/services";

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "timber backup "));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function context(overrides: Partial<CommandContext> = {}): CommandContext & { output: string[] } {
  const output: string[] = [];
  return { cwd: "/work/primary", io: { stdout: text => { output.push(text); }, stderr: text => { output.push(text); } }, output, ...overrides };
}

test("backup IDs are sortable UTC stamps with a random suffix", () => {
  expect(newBackupId(new Date("2026-11-15T09:08:07.654Z"))).toMatch(/^20261115T090807Z-[0-9a-f]{8}$/u);
});

test("a file changed between the walk and the copy refuses the snapshot", async () => {
  await withDirectory(async directory => {
    const source = join(directory, "source");
    const storage = join(directory, "storage");
    await mkdir(source);
    await mkdir(storage, { mode: 0o700 });
    await writeFile(join(source, "file.txt"), "before\n");
    const listing = await walkWorktree(source, []);
    await writeFile(join(source, "file.txt"), "after!!\n");
    await expect(copySnapshot(source, listing, storage)).rejects.toThrow(SnapshotError);
  });
});

test("rewalks detect added files and metadata-only changes", async () => {
  await withDirectory(async directory => {
    await writeFile(join(directory, "file.txt"), "same\n");
    const before = await walkWorktree(directory, []);
    expect(sameListing(before, await walkWorktree(directory, []))).toBe(true);
    await utimes(join(directory, "file.txt"), new Date(0), new Date(0));
    expect(sameListing(before, await walkWorktree(directory, []))).toBe(false);
    const touched = await walkWorktree(directory, []);
    await writeFile(join(directory, "added.txt"), "new\n");
    expect(sameListing(touched, await walkWorktree(directory, []))).toBe(false);
  });
});

test("insufficient storage refuses before copying", async () => {
  await withDirectory(async directory => {
    await expect(assertStorageSpace(directory, Number.MAX_SAFE_INTEGER)).rejects.toThrow("Insufficient storage");
    expect(await readdir(directory)).toEqual([]);
  });
});

test("manifests reject traversal, Git admin paths, undeclared parents and duplicates", () => {
  const file = { type: "file", mode: 0o644, size: 0, sha256: "0".repeat(64), blob: "000001" };
  for (const bad of [
    [{ ...file, path: "../escape" }],
    [{ ...file, path: "/absolute" }],
    [{ ...file, path: "dir/.git/config" }],
    [{ ...file, path: "missing-parent/file" }],
    [{ ...file, path: "twice" }, { ...file, path: "twice", blob: "000002" }],
    [{ ...file, path: "a" }, { ...file, path: "b" }],
    [{ path: "link", type: "symlink", target: "" }],
    [{ path: "dir", type: "directory", mode: 0o4777 }],
    [{ path: "dir", type: "directory", mode: 0o755, extra: true }],
  ]) expect(() => validateManifest(bad)).toThrow("malformed or unsafe");
  expect(validateManifest([
    { path: "dir", type: "directory", mode: 0o755 }, { ...file, path: "dir/file" },
    { path: "dir/link", type: "symlink", target: "../elsewhere" },
  ])).toHaveLength(3);
});

test("records must match their ID and private ref exactly", () => {
  const record = {
    version: 1, id: "20261115T090807Z-0123abcd", createdAt: "2026-11-15T09:08:07.654Z", commonGitDir: "/repo/.git",
    worktreePath: "/repo", worktreeGitDir: "/repo/.git", branch: null, commit: "a".repeat(40),
    ref: "refs/timber/backups/20261115T090807Z-0123abcd", entries: 0, bytes: 0, manifestSha256: "b".repeat(64),
  };
  expect(validateRecord(record, record.id).branch).toBeNull();
  expect(() => validateRecord(record, "20261115T090807Z-ffffffff")).toThrow();
  expect(() => validateRecord({ ...record, ref: "refs/heads/main" }, record.id)).toThrow();
  expect(() => validateRecord({ ...record, version: 2 }, record.id)).toThrow();
});

test("cancelled backup selection succeeds without calling the backup service", async () => {
  const worktree = (path: string) => ({ kind: "worktree" as const, worktree: {
    path, branch: "TIM-119-a", head: "a".repeat(40), isPrimary: false, pathExists: true, locked: null, prunable: null,
    status: { kind: "known" as const, modified: [], untracked: [], ignored: [] },
  } });
  const services = createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => ({}) as never,
    resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: [worktree("/work/a"), worktree("/work/b")] }),
  });
  const run = context({ choose: async () => null });
  expect(await createBackupCreateHandler(services)("TIM-119", run)).toBe(0);
  expect(run.output).toEqual(["Cancelled.\n"]);
  const capped = context();
  await expect(createBackupCreateHandler(services)("TIM-119", capped)).rejects.toThrow("matches 2 worktrees");
});

test("restore resolves the destination from the invoking directory", async () => {
  const calls: unknown[][] = [];
  const services = createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    restoreBackup: async (...args) => { calls.push(args.slice(1, 4)); return 0; },
  });
  expect(await createBackupRestoreHandler(services)("20261115T090807Z-0123abcd", "../recovered", context({ cwd: "/work/nested" }))).toBe(0);
  expect(calls).toEqual([["20261115T090807Z-0123abcd", "../recovered", "/work/nested"]]);
});

test("backup done refuses without a terminal prompt before touching the repository", async () => {
  const handler = createBackupDoneHandler(createServiceDouble());
  await expect(handler({ all: true }, context())).rejects.toThrow("Deleting backups requires an interactive terminal; nothing was deleted.");
});

test("backup done passes the terminal prompt and --all selection to the deletion service", async () => {
  const ask = async () => null;
  const handler = createBackupDoneHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    reviewBackupDeletion: async (_repository, options, _io, actual) => {
      expect(options).toEqual({ all: true });
      expect(actual).toBe(ask);
      return 0;
    },
  }));
  expect(await handler({ all: true }, context({ ask }))).toBe(0);
});

const failedList: BackupListRecord = { schemaVersion: 1, outcome: "failed", exitCode: 1, repository: null,
  diagnostic: "Not a Git repository.", backups: [], unfinished: [], notUsable: [], totalBytes: 0 };

test("backup list --json prints one record from the JSON service and exits with its code", async () => {
  const cwds: string[] = [];
  const handler = createBackupListHandler(createServiceDouble({
    readBackupList: async (cwd, discover) => {
      cwds.push(cwd);
      expect(typeof discover).toBe("function");
      return failedList;
    },
  }));
  const run = context({ cwd: "/work/nested" });
  expect(await handler(run, { json: true })).toBe(1);
  expect(cwds).toEqual(["/work/nested"]);
  expect(run.output).toEqual([JSON.stringify(failedList) + "\n"]);
});

test("backup list without --json keeps the text service", async () => {
  const handler = createBackupListHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    listBackups: async (_repository, io) => { io.stdout("text\n"); return 0; },
  }));
  const run = context();
  expect(await handler(run)).toBe(0);
  expect(run.output).toEqual(["text\n"]);
});
