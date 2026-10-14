import { expect, test } from "bun:test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("first-use hint appears once and ordinary commands remain quiet without any configuration", async () => {
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
      expect(result.stderr).toBe("");
      expect(result.stdout.length).toBeGreaterThan(0);
    }
    expect((await cli("ls")).stderr).toBe("");
    const required = await cli("open", "main", "--agent", "--no-editor");
    expect(required.exitCode).toBe(1);
    expect(required.stderr).toContain("timber setup");
    expect(required.stderr).not.toContain("Before using Timber");
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

test("completion generation and query bypass first-use guidance and malformed configuration", async () => {
  await withRepository(async (primary, directory) => {
    const sentinel = join(directory, "completion-integration-started");
    await writeFile(join(primary, ".timber.toml"), [
      "[editor]",
      `command = ${JSON.stringify(sentinel)}`,
      "args = []",
      "[agent]",
      `command = ${JSON.stringify(sentinel)}`,
      "enabled = true",
      "[hooks]",
      `post_create = [${JSON.stringify(sentinel)}]`,
      "[jira]",
      'site_url = "https://example.atlassian.net"',
      "broken = [",
      "",
    ].join("\n"));
    const home = join(directory, "completion-home");
    const configHome = join(directory, "completion-config");
    const stateHome = join(directory, "completion-state");
    await mkdir(join(configHome, "timber"), { recursive: true });
    await writeFile(join(configHome, "timber/config.toml"), "also = [invalid\n");
    const env = { CI: "true", HOME: home, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome };
    const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, ...args], {
      cwd, env, reject: false, timeout: 5000, stripFinalNewline: false,
    });

    const generated = await cli(directory, "completion", "bash");
    expect(generated.exitCode).toBe(0);
    expect(generated.stdout.startsWith("_timber_complete() {")).toBe(true);
    expect(generated.stdout.endsWith("complete -F _timber_complete timber\n")).toBe(true);
    expect(generated.stderr).toBe("");

    const outsideLine = "timber op";
    const outsideQueryArgs = [
      "completion", "__query", "--", "1", String(Array.from(outsideLine).length), outsideLine,
      " \t\n'\"@><=;|&(:", "timber", "op",
    ];
    const query = await cli(directory, ...outsideQueryArgs);
    expect(query.exitCode).toBe(0);
    expect(query.stdout).toBe("open\0");
    expect(query.stderr).toBe("");

    const targetLine = "timber open t";
    const targetQueryArgs = [
      "completion", "__query", "--", "2", String(Array.from(targetLine).length), targetLine,
      " \t\n'\"@><=;|&(:", "timber", "open", "t",
    ];
    const inRepository = await cli(primary, ...targetQueryArgs);
    expect(inRepository.exitCode).toBe(0);
    expect(inRepository.stdout).toBe("trunk\0");
    expect(inRepository.stderr).toBe("");
    await expect(access(join(stateHome, "timber/setup-hint-shown"))).rejects.toThrow();
    await expect(access(sentinel)).rejects.toThrow();
  });
});
