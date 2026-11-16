import { expect, test } from "bun:test";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { cli, commit, entry, removed, retained, snapshot, target } from "./helpers/done";

test("done preserves untracked work even with both cleanup options", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const file = "untracked.txt";
    await writeFile(join(path, file), "preserve bytes\n");
    const bytes = await readFile(join(path, file));
    await writeFile(join(path, ".env"), "ignored bytes\n");
    const status = await git(path, "status", "--porcelain=v1", "-z");
    const before = await snapshot(primary);
    const result = await cli(primary, "feature/one", "--keep-branch", "--discard-ignored");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/modified|untracked/);
    expect(result.stderr).toContain(file);
    await retained(primary, path, before);
    expect(await readFile(join(path, ".env"), "utf8")).toBe("ignored bytes\n");
    expect(await git(path, "status", "--porcelain=v1", "-z")).toBe(status);
    expect(await readFile(join(path, file))).toEqual(bytes);
  });
});

test("done keeps ignored files in place with keep-ignored and discards them by default", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    await writeFile(join(path, ".env"), "synthetic private bytes\n");
    await appendFile(join(primary, ".git", "info", "exclude"), "cache/\n");
    await mkdir(join(path, "cache"));
    await writeFile(join(path, "cache", "ignored.txt"), "cache bytes\n");
    const before = await snapshot(primary);
    for (const options of [["--keep-ignored"], ["--keep-branch", "--keep-ignored"]]) {
      const refused = await cli(primary, path, ...options);
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("--keep-ignored");
      expect(refused.stderr).toContain(".env");
      expect(refused.stderr).not.toContain("synthetic private bytes");
      await retained(primary, path, before);
      expect(await readFile(join(path, ".env"), "utf8")).toBe("synthetic private bytes\n");
      expect(await readFile(join(path, "cache", "ignored.txt"), "utf8")).toBe("cache bytes\n");
    }
    const completed = await cli(primary, path);
    expect(completed.exitCode).toBe(0);
    expect(completed.stderr).toBe("");
    await removed(primary, path, "feature/one", true);
  });
});

for (const answer of ["2\n", "\n"]) test(`interactive done discard handles ${JSON.stringify(answer)}`, async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    await commit(path);
    await writeFile(join(path, "tracked.txt"), "local edit\n");
    await writeFile(join(path, "scratch.txt"), "local scratch\n");
    const before = await snapshot(primary);
    const payload = join(directory, "done terminal.json");
    await writeFile(payload, JSON.stringify({
      cwd: primary, command: [process.execPath, entry, "done", "feature/one"],
      sendAt: "Choose 1-2, or q to cancel:", input: answer,
      env: { XDG_CONFIG_HOME: join(directory, "isolated config") },
    }));
    const child = await execa("python3", [fileURLToPath(new URL("./helpers/pty-runner.py", import.meta.url)), payload]);
    const result = JSON.parse(child.stdout) as { exitCode: number; output: string };
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Delete anyway?");
    expect(result.output).toContain("modified and untracked files");
    expect(result.output).toContain("default");
    if (answer === "2\n") {
      await removed(primary, path, "feature/one", true);
      expect(result.output).toContain("Deleted local branch feature/one");
    } else {
      await retained(primary, path, before);
      expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("local edit\n");
      expect(await readFile(join(path, "scratch.txt"), "utf8")).toBe("local scratch\n");
      expect(result.output).toContain("Cancelled.");
    }
  });
});
