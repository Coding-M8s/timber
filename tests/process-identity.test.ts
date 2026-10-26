import { expect, test } from "bun:test";
import { execa } from "execa";
import { parseDarwinProcessInfo, processIdentity, supportsEditorTerminals } from "../src/editor-terminals/process-identity";

function darwinInfo(pid = 42, seconds = 1_800_000_000n, microseconds = 123456) {
  const data = Buffer.alloc(136);
  data.writeUInt32LE(2, 4);
  data.writeUInt32LE(pid, 12);
  data.writeBigUInt64LE(seconds, 120);
  data.writeBigUInt64LE(BigInt(microseconds), 128);
  return data;
}

test("Darwin identity distinguishes process starts within the same second", () => {
  const first = parseDarwinProcessInfo(42, darwinInfo());
  expect(first).toEqual({ pid: 42, start: "darwin:1800000000:123456" });
  expect(parseDarwinProcessInfo(42, darwinInfo(42, 1_800_000_000n, 123457))).not.toEqual(first);
});

test("Darwin identity refuses truncated, mismatched, zombie and invalid native records", () => {
  for (const data of [Buffer.alloc(135), Buffer.alloc(137), darwinInfo(43),
    darwinInfo(42, 0n), darwinInfo(42, 1n, 1_000_000)]) {
    expect(parseDarwinProcessInfo(42, data)).toBeNull();
  }
  const zombie = darwinInfo(); zombie.writeUInt32LE(5, 4);
  expect(parseDarwinProcessInfo(42, zombie)).toBeNull();
});

test("editor terminal platform eligibility includes both Mac architectures and keeps unsupported targets closed", () => {
  for (const [platform, arch, expected] of [
    ["linux", "x64", true], ["darwin", "arm64", true], ["darwin", "x64", true],
    ["linux", "arm64", false], ["win32", "x64", false], ["darwin", "ia32", false],
  ] as const) expect(supportsEditorTerminals(platform, arch)).toBe(expected);
});

test("native process identity is stable while alive and absent after the child exits", async () => {
  const child = execa(process.execPath, ["--no-env-file", "-e", "setInterval(() => {}, 1000)"], { reject: false });
  try {
    const first = await processIdentity(child.pid!);
    expect(first).not.toBeNull();
    expect(await processIdentity(child.pid!)).toEqual(first);
  } finally { child.kill("SIGTERM"); await child; }
  expect(await processIdentity(child.pid!)).toBeNull();
});

test("invalid PIDs fail closed without querying another process", async () => {
  for (const pid of [0, -1, 1.5, NaN, Infinity, 2 ** 32]) expect(await processIdentity(pid)).toBeNull();
});
