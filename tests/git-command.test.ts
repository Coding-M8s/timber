import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { gitCommand } from "../src/platform/git-command";

const windows = test.skipIf(process.platform !== "win32");

test.skipIf(process.platform === "win32")("Git keeps its plain program name outside Windows", () => {
  expect(gitCommand({ PATH: "/nowhere" })).toBe("git");
});

windows("Windows spawns the first git.exe on PATH by its full path", async () => {
  const resolved = gitCommand();
  expect(resolved).toMatch(/^[a-z]:\\.*\\git\.exe$/iu);
  expect((await execa(resolved, ["--version"])).stdout).toStartWith("git version");
});

windows("Windows skips git scripts and extensionless files, and falls back to plain git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber git command "));
  try {
    const scripts = join(directory, "scripts"); const first = join(directory, "first"); const second = join(directory, "second");
    for (const folder of [scripts, first, second]) await mkdir(folder);
    await writeFile(join(scripts, "git"), ""); await writeFile(join(scripts, "git.cmd"), "@echo off\n");
    await writeFile(join(first, "git.exe"), ""); await writeFile(join(second, "git.exe"), "");
    expect(gitCommand({ PATH: `${scripts};${first};${second}` })).toBe(join(first, "git.exe"));
    expect(gitCommand({ PATH: `${second};${first}` })).toBe(join(second, "git.exe"));
    expect(gitCommand({ PATH: scripts })).toBe("git");
    expect(gitCommand({ PATH: "" })).toBe("git");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
