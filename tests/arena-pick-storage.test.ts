import { expect, test } from "bun:test";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { withArena } from "./helpers/arena";
import { openArenaForPick, readArenaPick } from "../src/arena/storage";

test("pick storage binds winner to manifest and preserves manifest/task bytes", async () => {
  await withArena(async f => {
    const before = await readFile(f.manifestPath), task = await readFile(f.taskPath);
    const session = await openArenaForPick(f.repository, "demo", f.manifest, null);
    try {
      const pick = { version: 1 as const, arenaId: f.manifest.id, winnerId: f.manifest.attempts[0]!.id,
        archives: [{ attemptId: f.manifest.attempts[1]!.id, ref: "refs/timber/arena/demo/manual-2", commit: "a".repeat(40) }] };
      session.pick = pick;
      await session.savePick();
      pick.winnerId = "00000000-0000-4000-8000-000000000000";
      await expect(session.savePick()).rejects.toThrow();
      pick.winnerId = f.manifest.attempts[0]!.id;
      pick.archives[0]!.ref = "refs/heads/elsewhere";
      await expect(session.savePick()).rejects.toThrow();
    } finally { await session.close(); }
    expect((await readArenaPick(f.repository, "demo", f.manifest))?.winnerId).toBe(f.manifest.attempts[0]!.id);
    expect(await readFile(f.manifestPath)).toEqual(before);
    expect(await readFile(f.taskPath)).toEqual(task);
    expect(existsSync(f.lockPath)).toBe(false);
  });
});

test("pick rejects changed review snapshots and leaves existing locks untouched", async () => {
  await withArena(async f => {
    const session = await openArenaForPick(f.repository, "demo", f.manifest, null);
    await expect(openArenaForPick(f.repository, "demo", f.manifest, null)).rejects.toThrow();
    await session.close();
    const changed = structuredClone(f.manifest); changed.attempts[0]!.stage = "exited";
    await expect(openArenaForPick(f.repository, "demo", changed, null)).rejects.toThrow("changed");
    expect(existsSync(f.lockPath)).toBe(false);
  });
});

for (const unsafe of ["symlink", "permissions", "foreign", "malformed"] as const)
test(`pick rejects unsafe ${unsafe} sidecar without overwriting it`, async () => {
  await withArena(async f => {
    const path = join(dirname(f.manifestPath), "pick.json");
    if (unsafe === "symlink") await symlink(f.taskPath, path);
    else {
      await writeFile(path, unsafe === "malformed" ? "{" : JSON.stringify({ version: 1, arenaId: "00000000-0000-4000-8000-000000000000",
        winnerId: f.manifest.attempts[0]!.id, archives: [] }), { mode: 0o600 });
      if (unsafe === "permissions") await chmod(path, 0o644);
    }
    const before = await readFile(path);
    await expect(readArenaPick(f.repository, "demo", f.manifest)).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
  });
});
