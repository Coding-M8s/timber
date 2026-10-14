import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execa } from "execa";
import { version } from "../package.json";

const root = fileURLToPath(new URL("../", import.meta.url));
const runner = join(root, "scripts/smoke-release.py");
let directory: string;
let binary: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "timber release test "));
  binary = join(directory, `timber-v${version}-linux-x64`);
  await execa(process.execPath, ["--no-env-file", "scripts/release.ts", "--outdir", directory], {
    cwd: root, timeout: 60_000,
  });
}, 65_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test("release output identifies source and passes checksum validation", async () => {
  const info = JSON.parse(await readFile(join(directory, "build-info.json"), "utf8"));
  expect(info.version).toBe(version);
  expect(info.sourceCommit).toBe((await execa("git", ["rev-parse", "HEAD"], { cwd: root })).stdout);
  expect(info.target).toBe("bun-linux-x64");
  expect(info.bunVersion).toBe("1.4.2");
  expect(info.tag).toBeNull();
  expect(typeof info.sourceDirty).toBe("boolean");
  await execa("sha256sum", ["-c", "SHA256SUMS"], { cwd: directory });
});

test("standalone rebuild produces identical bytes with the same inputs", async () => {
  const hash = async () => createHash("sha256").update(await readFile(binary)).digest("hex");
  const first = await hash();
  const metadata = await readFile(join(directory, "build-info.json"), "utf8");
  await execa(process.execPath, ["--no-env-file", "scripts/release.ts", "--outdir", directory], {
    cwd: root, timeout: 60_000,
  });
  expect(await hash()).toBe(first);
  expect(await readFile(join(directory, "build-info.json"), "utf8")).toBe(metadata);
}, 65_000);

test("compiled CLI passes real lifecycle, preservation, setup and terminal checks", async () => {
  const result = await execa("python3", [runner, "--binary", binary, "--expected-version", version], {
    timeout: 60_000, reject: false,
  });
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('"result": "passed"');
}, 65_000);

test("smoke verifier refuses wrong versions, missing executables and failing fixtures", async () => {
  for (const [path, expected, diagnostic] of [
    [binary, "999.0.0", "Version mismatch"],
    [join(directory, "missing"), version, "Release binary"],
  ]) {
    const result = await execa("python3", [runner, "--binary", path!, "--expected-version", expected!], {
      reject: false, timeout: 5_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(diagnostic!);
  }
  const fixture = join(directory, "fails");
  await writeFile(fixture, "#!/bin/sh\nexit 9\n");
  await chmod(fixture, 0o755);
  const result = await execa("python3", [runner, "--binary", fixture, "--expected-version", version], {
    reject: false, timeout: 5_000,
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Version command failed");
});
