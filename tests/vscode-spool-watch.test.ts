import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { watchSpool } from "../vscode-extension/src/spool-watch";

let root: string;
let spool: string;
beforeEach(async () => { root = await mkdtemp("/tmp/timber-spool-watch-test-"); spool = join(root, "spool"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function until(condition: () => boolean, timeoutMs = 2000, refresh?: () => Promise<void>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await refresh?.();
    if (condition()) return;
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
}

test("a spool removed by /tmp cleanup is recreated privately and watched again", async () => {
  let changes = 0;
  const watcher = watchSpool({ spool, uid: process.getuid!(), checkMs: 20, onChange: () => { changes++; } });
  try {
    await until(() => changes >= 1); // initial scan after arming
    expect((await stat(spool)).mode & 0o777).toBe(0o700);
    await rm(spool, { recursive: true });
    let recreated = false;
    await until(() => recreated, 2000, async () => { recreated = await stat(spool).then(() => true, () => false); });
    expect((await stat(spool)).mode & 0o777).toBe(0o700);
    await watcher.check(); // let the re-arm that recreated it finish
    const before = changes;
    await writeFile(join(spool, "00112233445566ff.json"), "{}", { mode: 0o600 });
    await until(() => changes > before); // the new directory is the one being watched
  } finally { watcher.dispose(); }
});

test("a spool readable by others is never watched, and is watched once it is private", async () => {
  await mkdir(spool, { mode: 0o755 });
  await chmod(spool, 0o755);
  let changes = 0;
  const watcher = watchSpool({ spool, uid: process.getuid!(), checkMs: 20, onChange: () => { changes++; } });
  try {
    await watcher.check();
    await Bun.sleep(60);
    expect(changes).toBe(0);
    await chmod(spool, 0o700);
    await until(() => changes >= 1);
  } finally { watcher.dispose(); }
});

test("a disposed watcher stops re-arming", async () => {
  let changes = 0;
  const watcher = watchSpool({ spool, uid: process.getuid!(), checkMs: 20, onChange: () => { changes++; } });
  await until(() => changes >= 1);
  watcher.dispose();
  await rm(spool, { recursive: true });
  await Bun.sleep(80);
  expect(await stat(spool).then(() => true, () => false)).toBe(false);
});
