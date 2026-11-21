import { expect, test } from "bun:test";
import { readLinearKey } from "../src/linear/auth";
import { waitForProcessExit } from "./helpers/process";

test("Linear environment override avoids saved storage and never falls back on invalid input", async () => {
  let reads = 0;
  const saved = async () => { reads++; return "SYNTHETIC_SAVED_KEY"; };
  expect(await readLinearKey({ LINEAR_API_KEY: "SYNTHETIC_ENV_KEY" }, saved)).toBe("SYNTHETIC_ENV_KEY");
  for (const token of ["", " ", "a b", "a\n", "a\u007f", "a\u0085"]) {
    await expect(readLinearKey({ LINEAR_API_KEY: token }, saved)).rejects.toThrow(/LINEAR_API_KEY/u);
  }
  expect(reads).toBe(0);
  expect(await readLinearKey({}, saved)).toBe("SYNTHETIC_SAVED_KEY");
  expect(reads).toBe(1);
  await expect(readLinearKey({}, async () => null)).rejects.toThrow("timber setup");
});

test.skipIf(process.platform === "win32")("Linear credential deadline cancels the real Git storage-location probe", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "timber-linear-auth-cancel-"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = root;
    const ready = join(root, "ready"); const finished = join(root, "finished");
    const fixture = join(root, "probe.ts");
    // The child exits by itself only after the 2 second exit wait, so that wait proves cancellation killed it.
    await writeFile(fixture, `await Bun.write(${JSON.stringify(ready)}, String(process.pid));\nsetTimeout(async () => { await Bun.write(${JSON.stringify(finished)}, "finished"); console.log("false\\nfalse"); }, 5000);\n`);
    await writeFile(join(root, "git"), `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${fixture}'\n`, { mode: 0o700 });
    const controller = new AbortController();
    const loading = readLinearKey({ HOME: root, XDG_CONFIG_HOME: join(root, "config"), PATH: root }, undefined, controller.signal);
    // Attach the rejection handler before aborting, then wait for the owned child to start.
    const rejected = loading.catch(error => error);
    // The file can exist before its contents land, and an empty read would give pid 0.
    const readPid = async () => Number(await readFile(ready, "utf8").catch(() => ""));
    let pid = 0;
    for (let n = 0; n < 100 && !((pid = await readPid()) > 0); n++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(pid).toBeGreaterThan(0);
    const start = performance.now(); controller.abort();
    await rejected;
    expect(performance.now() - start).toBeLessThan(700);
    expect(await Bun.file(finished).exists()).toBe(false);
    expect(await waitForProcessExit(pid)).toBe(true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
