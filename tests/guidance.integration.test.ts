import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("first-use fallback, all four command reminders, and empty scoped configs work through the real CLI", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "branch", "-m", "main");
    const env = { CI: "true", HOME: directory, XDG_CONFIG_HOME: join(directory, "machine/config"),
      XDG_STATE_HOME: join(directory, "machine/state") };
    const cli = (...args: string[]) => execa(process.execPath, [entry, ...args], { cwd: primary, env, reject: false, timeout: 5000 });
    const before = await git(primary, "status", "--porcelain=v1");
    const first = await cli("--help");
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain("Before using Timber");
    expect(first.stdout).toContain("setup");
    expect(await readFile(join(directory, "machine/state/timber/setup-hint-shown"), "utf8")).toBe("1\n");
    expect(await git(primary, "status", "--porcelain=v1")).toBe(before);
    for (const args of [["ls"], ["new", "feature", "--no-editor"], ["open", "feature", "--no-editor"], ["done", "feature", "--keep-branch"]]) {
      const result = await cli(...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toStartWith("No Timber settings found.");
      expect(result.stderr).not.toContain("Before using Timber");
      expect(result.stdout.length).toBeGreaterThan(0);
    }
    await mkdir(join(directory, "machine/config/timber"), { recursive: true });
    const globalPath = join(directory, "machine/config/timber/config.toml");
    await writeFile(globalPath, "# deliberately minimal defaults\n");
    expect((await cli("ls")).stderr).toBe("");
    await writeFile(globalPath, 'remote = [\n');
    const invalid = await cli("ls");
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("Invalid TOML");
    expect(invalid.stderr).not.toContain("No Timber settings");
    await writeFile(globalPath, "");
    await writeFile(join(primary, ".timber.toml"), "");
    expect((await cli("ls")).stderr).toBe("");
    const setup = await cli("setup", "--global");
    expect(setup.exitCode).toBe(1);
    expect(setup.stderr).toContain("interactive terminal");
    expect(await readFile(globalPath, "utf8")).toBe("");
  });
});

test("setup help outside a repository shows the first-invocation hint without creating config", async () => {
  await withRepository(async (_primary, directory) => {
    const result = await execa(process.execPath, [entry, "setup", "--help"], { cwd: directory,
      env: { CI: "true", HOME: directory, XDG_CONFIG_HOME: join(directory, "config"), XDG_STATE_HOME: join(directory, "state") }, reject: false });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Before using Timber");
    expect(result.stdout).toContain("--global");
  });
});
