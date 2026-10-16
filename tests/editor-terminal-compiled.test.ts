import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { withRepository } from "./helpers/git";

test("standalone CLI hands setup to its own compiled runner without Bun or source on PATH", async () => {
  const directory = await mkdtemp("/tmp/timber-compiled-runner-");
  try {
    const binary = join(directory, "timber");
    await execa(process.execPath, ["--no-env-file", "build", "src/index.ts", "--compile",
      "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", binary]);
    await withRepository(async primary => {
      const fixture = resolve("tests/fixtures/orca-stub.py");
      await writeFile(join(primary, ".timber.toml"), '[editor]\ncommand = "/usr/bin/python3"\n' +
        `args = [${JSON.stringify(fixture)}]\nenabled = true\nintegration = "orca"\n` +
        '[hooks]\npost_create = ["printf compiled > compiled-marker"]\n');
      const result = await execa(binary, ["new", "compiled", "--base", "trunk"], { cwd: primary,
        env: { PATH: "/usr/bin:/bin", ORCA_ENVIRONMENT: "", ORCA_PAIRING_CODE: "" }, reject: false, timeout: 10_000 });
      expect(result.exitCode).toBe(0);
      const path = join(primary, "../primary repo-worktrees/compiled");
      expect(await readFile(join(path, "compiled-marker"), "utf8")).toBe("compiled");
      expect(await readFile(join(path, "editor-output"), "utf8")).not.toContain("installation");
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
