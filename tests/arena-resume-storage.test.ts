import { expect, test } from "bun:test";
import { existsSync, constants, type PathLike, type StatOptions, type Stats, type BigIntStats } from "node:fs";
import { readFile, writeFile, unlink, symlink } from "node:fs/promises";
import { withArena } from "./helpers/arena";
import * as storage from "../src/arena/storage";

for (const version of [1, 2] as const) test(`resume opens v${version} exclusively and updates without replacing identities or task`, async () => {
  await withArena(async f => {
    if (version === 1 && f.manifest.version === 2) {
      const { source, ticket, ...rest } = f.manifest;
      const old = { ...rest, version: 1, attempts: f.manifest.attempts.map(({ harness, model, effort, effortEnvironment, configSource, ...a }) => a) };
      await writeFile(f.manifestPath, JSON.stringify(old));
      f.manifest = (await storage.readArena(f.repository, "demo")).manifest;
    }
    const task = await readFile(f.taskPath);
    const session = await storage.openArenaForResume(f.repository, "demo", f.manifest);
    try {
      await expect(storage.openArenaForResume(f.repository, "demo", f.manifest)).rejects.toThrow(/lock|active/i);
      await expect(storage.readArena(f.repository, "demo")).rejects.toThrow(/lock|active/i);
      session.manifest.attempts[0]!.stage = "exited";
      session.manifest.attempts[0]!.exitCode = 7;
      await session.save();
      await session.verifyTask();
    } finally { await session.close(); }
    const actual = (await storage.readArena(f.repository, "demo")).manifest;
    const expected = structuredClone(f.manifest);
    expected.attempts[0]!.stage = "exited";
    expected.attempts[0]!.exitCode = 7;
    expect(actual).toEqual(expected);
    expect(await readFile(f.taskPath)).toEqual(task);
    expect(existsSync(f.lockPath)).toBe(false);
  });
});

test("resume rejects changed records and task, releasing only its new lock", async () => {
  await withArena(async f => {
    const changed = structuredClone(f.manifest);
    changed.attempts[1]!.stage = "created";
    await writeFile(f.manifestPath, JSON.stringify(changed));
    const before = await readFile(f.manifestPath);
    await expect(storage.openArenaForResume(f.repository, "demo", f.manifest)).rejects.toThrow(/changed|stale/i);
    expect(await readFile(f.manifestPath)).toEqual(before);
    expect(existsSync(f.lockPath)).toBe(false);
    await writeFile(f.taskPath, "tampered");
    await expect(storage.openArenaForResume(f.repository, "demo", changed)).rejects.toThrow(/task|snapshot/i);
    expect(existsSync(f.lockPath)).toBe(false);
  });
});

test("resume refuses stale/symlink locks and cannot save or close after losing ownership", async () => {
  await withArena(async f => {
    await symlink(f.taskPath, f.lockPath);
    await expect(storage.openArenaForResume(f.repository, "demo", f.manifest)).rejects.toThrow(/lock|active/i);
    await unlink(f.lockPath);
    await writeFile(f.lockPath, "interrupted", { mode: 0o600 });
    await expect(storage.openArenaForResume(f.repository, "demo", f.manifest)).rejects.toThrow(/lock|active/i);
    await unlink(f.lockPath);
    const session = await storage.openArenaForResume(f.repository, "demo", f.manifest);
    await writeFile(f.lockPath, "other owner");
    const before = await readFile(f.manifestPath);
    await expect(session.save()).rejects.toThrow(/lock/i);
    await expect(session.close()).rejects.toThrow(/lock/i);
    expect(await readFile(f.lockPath, "utf8")).toBe("other owner");
    expect(await readFile(f.manifestPath)).toEqual(before);
  });
});

test("simultaneous resumers admit one owner", async () => {
  await withArena(async f => {
    const opened = await Promise.allSettled([
      storage.openArenaForResume(f.repository, "demo", f.manifest),
      storage.openArenaForResume(f.repository, "demo", f.manifest),
    ]);
    expect(opened.filter(r => r.status === "fulfilled")).toHaveLength(1);
    for (const result of opened) if (result.status === "fulfilled") await result.value.close();
    expect(existsSync(f.lockPath)).toBe(false);
  });
});

// Fault only the OS boundary; acquisition, validation, cleanup, and retry remain real.
for (const [point, code] of [["open", "EACCES"], ["empty-write", "ENOSPC"], ["partial-write", "EIO"], ["sync", "EIO"], ["close", "EIO"]] as const)
test(`lock ${point}/${code} failure leaves no orphan and permits a later real resume`, async () => {
  const fs = await import("node:fs/promises");
  const { spyOn } = await import("bun:test");
  await withArena(async f => {
    const before = await readFile(f.manifestPath), task = await readFile(f.taskPath);
    const actualOpen = fs.open;
    let injected = false;
    const fault = Object.assign(new Error("PRIVATE_FILESYSTEM_ERROR"), { code });
    const intercept = spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] !== f.lockPath || typeof args[1] !== "number" || (args[1] & constants.O_CREAT) === 0) return actualOpen(...args);
      if (point === "open") { injected = true; throw fault; }
      const handle = await actualOpen(...args);
      if (point === "empty-write" || point === "partial-write") {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async data => {
          injected = true;
          if (point === "partial-write") await write(Buffer.from(String(data)).subarray(0, 5));
          throw fault;
        };
      } else if (point === "sync") handle.sync = async () => { injected = true; throw fault; };
      else {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); injected = true; throw fault; };
      }
      return handle;
    });
    let error: unknown;
    try { await storage.openArenaForResume(f.repository, "demo", f.manifest); } catch (e) { error = e; }
    finally { intercept.mockRestore(); }
    expect(injected).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(existsSync(f.lockPath)).toBe(false);
    expect(String(error)).not.toContain("Arena is active");
    expect(String(error)).toContain(code === "EACCES" ? "permission denied" : code === "ENOSPC" ? "storage is full" : "I/O error");
    expect(String(error)).not.toContain("PRIVATE_FILESYSTEM_ERROR");
    expect(await readFile(f.manifestPath)).toEqual(before); expect(await readFile(f.taskPath)).toEqual(task);
    const retried = await storage.openArenaForResume(f.repository, "demo", f.manifest);
    await retried.verifyTask(); await retried.close();
    expect(existsSync(f.lockPath)).toBe(false);
  });
});

test("failed lock initialization cannot delete a replacement owner's lock", async () => {
  const fs = await import("node:fs/promises"), { spyOn } = await import("bun:test");
  await withArena(async f => {
    const actualOpen = fs.open;
    const intercept = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (args[0] === f.lockPath && typeof args[1] === "number" && (args[1] & constants.O_CREAT) !== 0) handle.sync = async () => {
        await unlink(f.lockPath); await writeFile(f.lockPath, "replacement owner", { mode: 0o600 });
        throw Object.assign(new Error("PRIVATE_SYNC_ERROR"), { code: "EIO" });
      };
      return handle;
    });
    let error: unknown;
    try { await storage.openArenaForResume(f.repository, "demo", f.manifest); } catch (e) { error = e; }
    finally { intercept.mockRestore(); }
    expect(String(error)).toMatch(/initialize|initializ|storage|I\/O/i);
    expect(await readFile(f.lockPath, "utf8")).toBe("replacement owner");
    await expect(storage.readArena(f.repository, "demo")).rejects.toThrow(/lock|active/i);
  });
});

test("failed owned-lock cleanup reports storage failure and required inspection without deleting records", async () => {
  const fs = await import("node:fs/promises"), { spyOn } = await import("bun:test");
  await withArena(async f => {
    const actualOpen = fs.open, actualUnlink = fs.unlink, before = await readFile(f.manifestPath);
    const opened = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (args[0] === f.lockPath && typeof args[1] === "number" && (args[1] & constants.O_CREAT) !== 0)
        handle.sync = async () => { throw Object.assign(new Error("PRIVATE_IO_ERROR"), { code: "EIO" }); };
      return handle;
    });
    const removed = spyOn(fs, "unlink").mockImplementation(async path => {
      if (path === f.lockPath) throw Object.assign(new Error("PRIVATE_UNLINK_ERROR"), { code: "EACCES" });
      return actualUnlink(path);
    });
    let error: unknown;
    try { await storage.openArenaForResume(f.repository, "demo", f.manifest); } catch (e) { error = e; }
    finally { opened.mockRestore(); removed.mockRestore(); }
    expect(String(error)).toMatch(/I\/O/); expect(String(error)).toMatch(/inspect/i);
    expect(String(error)).not.toContain("PRIVATE_");
    expect(existsSync(f.lockPath)).toBe(true); expect(await readFile(f.manifestPath)).toEqual(before);
  });
});

test("failed lock inspection preserves lock and reports original storage failure with inspection guidance", async () => {
  const fs = await import("node:fs/promises"), { spyOn } = await import("bun:test");
  await withArena(async f => {
    const actualOpen = fs.open, actualLstat = fs.lstat, before = await readFile(f.manifestPath);
    let syncFailed = false, inspectionFailed = false;
    const opened = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (args[0] === f.lockPath && typeof args[1] === "number" && (args[1] & constants.O_CREAT) !== 0)
        handle.sync = async () => { syncFailed = true; throw Object.assign(new Error("PRIVATE_SYNC_ERROR"), { code: "EIO" }); };
      return handle;
    });
    function inspectWithFault(path: PathLike, opts?: StatOptions & { bigint?: false | undefined }): Promise<Stats>;
    function inspectWithFault(path: PathLike, opts: StatOptions & { bigint: true }): Promise<BigIntStats>;
    function inspectWithFault(path: PathLike, opts?: StatOptions): Promise<Stats | BigIntStats>;
    function inspectWithFault(path: PathLike, opts?: StatOptions): Promise<Stats | BigIntStats> {
      if (syncFailed && path === f.lockPath) {
        inspectionFailed = true;
        return Promise.reject(Object.assign(new Error("PRIVATE_INSPECTION_ERROR"), { code: "EACCES" }));
      }
      return actualLstat(path, opts);
    }
    const inspected = spyOn(fs, "lstat").mockImplementation(inspectWithFault);
    let error: unknown;
    try { await storage.openArenaForResume(f.repository, "demo", f.manifest); } catch (e) { error = e; }
    finally { opened.mockRestore(); inspected.mockRestore(); }
    expect(inspectionFailed).toBe(true); expect(String(error)).toMatch(/I\/O/); expect(String(error)).toMatch(/inspect/);
    expect(String(error)).not.toContain("PRIVATE_"); expect(existsSync(f.lockPath)).toBe(true);
    expect(await readFile(f.manifestPath)).toEqual(before);
    await expect(storage.readArena(f.repository, "demo")).rejects.toThrow(/lock|active/);
  });
});
