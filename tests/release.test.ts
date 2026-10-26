import { expect, test } from "bun:test";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { releaseTarget, validateReleaseTag, verifyTaggedCommit } from "../scripts/release";

test("release targets keep Linux assets compatible and Windows assets distinct", () => {
  expect(releaseTarget(undefined, "linux")).toMatchObject({ name: "linux-x64", compile: "bun-linux-x64", metadata: "build-info.json", checksums: "SHA256SUMS" });
  expect(releaseTarget(undefined, "win32")).toEqual({ name: "windows-x64", compile: "bun-windows-x64", extension: ".exe", metadata: "build-info-windows-x64.json", checksums: "SHA256SUMS-windows-x64" });
  expect(releaseTarget("linux-x64", "win32").name).toBe("linux-x64");
  expect(() => releaseTarget("windows-arm64")).toThrow();
  expect(() => releaseTarget("windows-x64;echo unsafe")).toThrow();
});

test("experimental macOS targets bind each binary name to the requested Bun platform", () => {
  expect(releaseTarget(undefined, "darwin", "arm64")).toEqual({ name: "darwin-arm64", compile: "bun-darwin-arm64", extension: "", metadata: "build-info.json", checksums: "SHA256SUMS" });
  expect(releaseTarget(undefined, "darwin", "x64")).toMatchObject({ name: "darwin-x64", compile: "bun-darwin-x64" });
  expect(releaseTarget("darwin-x64", "linux").compile).toBe("bun-darwin-x64");
  for (const target of ["darwin-ia32", "bun-darwin-arm64", "darwin-arm64;touch sentinel", ""]) {
    expect(() => releaseTarget(target)).toThrow(/target/i);
  }
  expect(() => releaseTarget(undefined, "darwin", "ia32")).toThrow(/target/i);
});

test("release CLI rejects an unsupported target before creating output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "timber-invalid-target-"));
  try {
    const outdir = join(cwd, "output");
    const result = await execa(process.execPath, ["--no-env-file", "scripts/release.ts", "--target", "darwin-ia32", "--outdir", outdir], { reject: false });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Release target must be");
    await expect(lstat(outdir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("release tags accept matching stable and numbered release candidates", () => {
  expect(() => validateReleaseTag("v0.2.0", "0.2.0")).not.toThrow();
  expect(() => validateReleaseTag("v1.0.0-rc.1", "1.0.0-rc.1")).not.toThrow();
});

for (const [tag, version] of [
  ["v0.2.0", "0.1.0"], ["0.2.0", "0.2.0"], ["v01.2.0", "01.2.0"],
  ["v0.1.0-dev.0", "0.1.0-dev.0"], ["v1.0.0-rc.01", "1.0.0-rc.01"],
  ["v1.0.0;touch sentinel", "1.0.0;touch sentinel"], ["v1.0.0\n", "1.0.0\n"],
]) {
  test(`release rejects invalid or mismatched identity ${JSON.stringify(tag)}`, () => {
    expect(() => validateReleaseTag(tag!, version!)).toThrow();
  });
}

test("tag verification rejects absent, moved, and dirty source without changing refs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "timber-release-identity-"));
  const git = (...args: string[]) => execa("git", args, { cwd });
  try {
    await git("init", "-b", "main");
    await writeFile(join(cwd, "file"), "one\n");
    await git("add", "file");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "one");
    await git("tag", "v0.2.0");
    const head = (await git("rev-parse", "HEAD")).stdout;
    expect(await verifyTaggedCommit(cwd, "v0.2.0")).toBe(head);
    await expect(verifyTaggedCommit(cwd, "v0.3.0")).rejects.toThrow();
    await writeFile(join(cwd, "file"), "dirty\n");
    await expect(verifyTaggedCommit(cwd, "v0.2.0")).rejects.toThrow();
    await git("add", "file");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "two");
    const refs = (await git("show-ref")).stdout;
    await expect(verifyTaggedCommit(cwd, "v0.2.0")).rejects.toThrow();
    expect((await git("show-ref")).stdout).toBe(refs);
    expect((await git("rev-parse", "refs/tags/v0.2.0")).stdout).toBe(head);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
