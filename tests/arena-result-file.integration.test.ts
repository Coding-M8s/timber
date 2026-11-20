import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const SENTINEL = "PRIVATE_TASK_SENTINEL";

/** The real CLI with stdin closed, no terminal and CI on. */
async function timber(cwd: string, directory: string, args: string[]) {
  const result = await execa(process.execPath, ["--no-env-file", entry, ...args], {
    cwd, reject: false, timeout: 60_000, stdin: "ignore",
    env: { CI: "true", XDG_CONFIG_HOME: join(directory, "config"), XDG_STATE_HOME: join(directory, "state") },
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function withTask(run: (f: { primary: string; directory: string; task: string; out: (name: string) => string }) => Promise<void>) {
  await withRepository(async (primary, directory) => {
    const task = join(directory, "task.txt");
    await writeFile(task, `${SENTINEL}\n`);
    const results = join(directory, "results");
    await mkdir(results);
    await run({ primary, directory, task, out: name => join(results, name) });
  });
}

const create = (f: { primary: string; directory: string; task: string }, result: string, extra: string[] = []) =>
  timber(f.primary, f.directory, ["arena", "new", "demo", "--base", "trunk", "--tool", "manual", "--runs", "2", "--prompt-file", f.task,
    "--no-editor", "--no-agent", "--result-file", result, ...extra]);

const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("arena new --result-file records the arena and every created attempt", async () => {
  await withTask(async f => {
    const result = f.out("new.json");
    const run = await create(f, result);
    expect(run.exitCode).toBe(0);
    const record = await read(result);
    expect(record).toMatchObject({ schemaVersion: 1, command: "arena-new", outcome: "succeeded", exitCode: 0, diagnostic: null,
      repository: { primaryWorktreeRoot: f.primary } });
    expect(record.arenaNew).toMatchObject({ name: "demo", failure: null, base: { ref: "refs/heads/trunk" } });
    expect(record.arenaNew.attempts.map((a: { label: string }) => a.label)).toEqual(["manual-1", "manual-2"]);
    for (const attempt of record.arenaNew.attempts) {
      expect(attempt).toMatchObject({ tool: "manual", created: true, stage: "ready", failedStage: null, model: null, effort: null });
      expect(existsSync(attempt.path)).toBe(true);
    }
    expect(JSON.stringify(record) + run.stdout + run.stderr).not.toContain(SENTINEL);
  });
});

test("arena new --result-file records how far each attempt got when setup fails partway", async () => {
  await withTask(async f => {
    await writeFile(join(f.primary, ".timber.toml"), '[hooks]\npost_create = ["case \\"$PWD\\" in *manual-2*) exit 9;; esac"]\n');
    const result = f.out("new.json");
    const run = await create(f, result);
    expect(run.exitCode).toBe(1);
    const record = await read(result);
    expect(record).toMatchObject({ command: "arena-new", outcome: "failed", exitCode: 1 });
    expect(record.arenaNew.failure).toEqual({ stage: "setup", attempt: "manual-2" });
    expect(record.arenaNew.attempts).toMatchObject([
      { label: "manual-1", created: true, stage: "ready", failedStage: null },
      { label: "manual-2", created: true, stage: "failed", failedStage: "setup" },
    ]);
    // Completed work is retained.
    for (const attempt of record.arenaNew.attempts) expect(existsSync(attempt.path)).toBe(true);
    expect(JSON.stringify(record)).not.toContain(SENTINEL);
  });
});

test("arena new --result-file requires --no-editor and --no-agent and writes no record otherwise", async () => {
  await withTask(async f => {
    const result = f.out("new.json");
    const run = await timber(f.primary, f.directory, ["arena", "new", "demo", "--base", "trunk", "--tool", "manual", "--runs", "2",
      "--prompt-file", f.task, "--no-agent", "--result-file", result]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("--no-editor and --no-agent");
    expect(existsSync(result)).toBe(false);
  });
});

test("arena new --result-file before reservation fails without an arena report", async () => {
  await withTask(async f => {
    expect((await create(f, f.out("first.json"))).exitCode).toBe(0);
    const result = f.out("again.json");
    const run = await create(f, result);
    expect(run.exitCode).toBe(1);
    const record = await read(result);
    expect(record).toMatchObject({ command: "arena-new", outcome: "failed" });
    expect(record.arenaNew).toBeUndefined();
    expect(record.diagnostic).toMatch(/exists|reserved/i);
  });
});

test("arena pick --result-file reports the winner, archived, removed and kept attempts with reasons", async () => {
  await withTask(async f => {
    // A known base lets cleanup see that an untouched attempt holds no unique work.
    await writeFile(join(f.primary, ".timber.toml"), 'base_branch = "trunk"\n');
    const created = f.out("new.json");
    expect((await timber(f.primary, f.directory, ["arena", "new", "demo", "--base", "trunk", "--tool", "manual", "--runs", "4",
      "--prompt-file", f.task, "--no-editor", "--no-agent", "--result-file", created])).exitCode).toBe(0);
    const [winner, archived, removed, kept] = (await read(created)).arenaNew.attempts as { label: string; path: string; branch: string }[];
    await writeFile(join(archived!.path, "work.txt"), "unique work\n");
    await writeFile(join(kept!.path, ".env"), "SECRET=1\n");
    const refsBefore = await git(f.primary, "for-each-ref", `refs/heads/${kept!.branch}`);

    const result = f.out("pick.json");
    const run = await timber(f.primary, f.directory, ["arena", "pick", "demo", "--winner", winner!.label, "--keep-ignored", "--result-file", result]);
    expect(run.exitCode).toBe(1);
    const record = await read(result);
    expect(record).toMatchObject({ schemaVersion: 1, command: "arena-pick", outcome: "failed", exitCode: 1 });
    expect(record.arenaPick.winner).toBe(winner!.label);
    const [w, a, r, k] = record.arenaPick.attempts;
    expect(w).toEqual({ label: winner!.label, outcome: "winner", archiveRef: null, reason: null });
    expect(a).toEqual({ label: archived!.label, outcome: "archived", archiveRef: `refs/timber/arena/demo/${archived!.label}`, reason: null });
    expect(r).toEqual({ label: removed!.label, outcome: "removed", archiveRef: null, reason: null });
    expect(k).toMatchObject({ label: kept!.label, outcome: "kept" });
    expect(k.reason).toMatch(/ignored/i);
    // The kept attempt's files and branch are intact.
    expect(await readFile(join(kept!.path, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(await git(f.primary, "for-each-ref", `refs/heads/${kept!.branch}`)).toBe(refsBefore);
    expect(existsSync(archived!.path)).toBe(false);

    // A rerun reports earlier removals, and the kept attempt goes once ignored files may be deleted.
    const again = f.out("again.json");
    expect((await timber(f.primary, f.directory, ["arena", "pick", "demo", "--winner", winner!.label, "--result-file", again])).exitCode).toBe(0);
    const second = await read(again);
    expect(second).toMatchObject({ outcome: "succeeded" });
    expect(second.arenaPick.attempts.map((x: { outcome: string }) => x.outcome)).toEqual(["winner", "already-removed", "already-removed", "removed"]);
    expect(second.arenaPick.attempts[1].archiveRef).toBe(`refs/timber/arena/demo/${archived!.label}`);
    expect(JSON.stringify(record) + JSON.stringify(second)).not.toContain(SENTINEL);
  });
});

test("arena pick --inspect --json prints the comparison as one record and changes nothing", async () => {
  await withTask(async f => {
    const created = f.out("new.json");
    expect((await create(f, created)).exitCode).toBe(0);
    const [first, second] = (await read(created)).arenaNew.attempts as { label: string; path: string }[];
    await writeFile(join(first!.path, "tracked.txt"), "one\ntwo\n");
    await git(first!.path, "add", ".");
    await git(first!.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "work");
    await writeFile(join(first!.path, "old name.txt"), "edited\n");
    await writeFile(join(first!.path, "new.txt"), "new\n");
    await writeFile(join(first!.path, "other.txt"), "new\n");
    const snapshot = async () => [await git(f.primary, "show-ref"), await git(first!.path, "status", "--porcelain=v1", "-uall"),
      await readFile(join(f.primary, ".git", "timber", "arenas", "demo", "manifest.json"), "utf8")];
    const before = await snapshot();

    const run = await timber(f.primary, f.directory, ["arena", "pick", "demo", "--inspect", "--json"]);
    expect(run.exitCode).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(run.stderr).toBe("");
    const record = JSON.parse(run.stdout);
    expect(record).toMatchObject({ schemaVersion: 1, arena: "demo", winner: null, diagnostic: null });
    expect(record.attempts[0]).toMatchObject({ label: first!.label, state: "prepared", removed: false, archiveRef: null, reason: null,
      comparison: { commits: 1, committed: { files: 1, insertions: 2, deletions: 1 },
        uncommitted: { files: 1, insertions: 1, deletions: 1 }, untracked: 2, ignored: 0 } });
    expect(record.attempts[1]).toMatchObject({ label: second!.label, comparison: { commits: 0, untracked: 0 } });
    expect(run.stdout).not.toContain(SENTINEL);

    const plain = await timber(f.primary, f.directory, ["arena", "pick", "demo", "--json"]);
    expect(plain.exitCode).toBe(1);
    expect(plain.stderr).toContain("--json requires --inspect");
    const missing = await timber(f.primary, f.directory, ["arena", "pick", "nope", "--inspect", "--json"]);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ arena: "nope", attempts: [] });
    expect(JSON.parse(missing.stdout).diagnostic).toMatch(/arena/i);
  });
});

test("the hidden __app-arena command works end to end", async () => {
  await withTask(async f => {
    expect((await create(f, f.out("new.json"))).exitCode).toBe(0);
    const marker = join(f.directory, "state", "timber", "setup-hint-shown");
    await rm(join(f.directory, "state"), { recursive: true, force: true });
    // Machine reads never show the first-use hint or write its marker.
    for (const args of [["__app-arena", "list"], ["__app-arena", "launch", "demo", "--attempt", "manual-1"], ["arena", "pick", "demo", "--inspect", "--json"]]) {
      const run = await timber(f.primary, f.directory, args);
      expect([args, run.exitCode, run.stderr]).toEqual([args, 0, ""]);
      expect(existsSync(marker)).toBe(false);
    }
    const list = await timber(f.primary, f.directory, ["__app-arena", "list"]);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).arenas[0].attempts).toHaveLength(2);
    const launch = await timber(f.primary, f.directory, ["__app-arena", "launch", "demo", "--attempt", "manual-1"]);
    expect(launch.exitCode).toBe(0);
    expect(JSON.parse(launch.stdout)).toMatchObject({ outcome: "no-agent", launch: null });
    expect(list.stdout + launch.stdout + list.stderr + launch.stderr).not.toContain(SENTINEL);
  });
});
