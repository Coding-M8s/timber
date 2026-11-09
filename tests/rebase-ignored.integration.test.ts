import { expect, test } from "bun:test";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const scenarios = [
  { name: "exact Unicode file", ignored: ["秘密.env"], incoming: ["秘密.env"], first: "秘密.env" },
  { name: "tracked ancestor of ignored directories", ignored: ["cache/a/local", "cache/z/local"], incoming: ["cache"], first: "cache/a/local" },
  { name: "tracked descendant of ignored file", ignored: ["cache"], incoming: ["cache/child"], first: "cache" },
  // Tracked Git tree order takes precedence over ignored-list order.
  { name: "first tracked collision", ignored: ["a-ignored", "a/z/local"], incoming: ["a", "a-ignored/child"], first: "a/z/local" },
];

test.each(scenarios)("indexed rebase protection retains refs, files and first diagnostic: $name", async scenario => {
  await withRepository(async (primary, directory) => {
    const target = join(directory, "feature");
    await git(primary, "worktree", "add", "-b", "feature", target);
    await appendFile(join(primary, ".git/info/exclude"), scenario.ignored.map(path => "/" + path.replace(/\/local$/u, "/")).join("\n") + "\n");
    for (const path of scenario.ignored) {
      await mkdir(dirname(join(target, path)), { recursive: true });
      await writeFile(join(target, path), "private ignored bytes\n");
    }
    for (const path of scenario.incoming) {
      await mkdir(dirname(join(primary, path)), { recursive: true });
      await writeFile(join(primary, path), "incoming tracked bytes\n");
      await git(primary, "add", "-f", "--", path);
    }
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "incoming paths");
    const refs = await git(primary, "show-ref");
    const status = await git(target, "status", "--porcelain=v1", "--ignored", "-z");
    const result = await execa(process.execPath, ["--no-env-file", entry, "rebase", target, "--base", "refs/heads/trunk"], {
      cwd: primary, reject: false, timeout: 10_000, env: { CI: "true" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Rebase could overwrite ignored content at ${JSON.stringify(scenario.first)};`);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(target, "status", "--porcelain=v1", "--ignored", "-z")).toBe(status);
    for (const path of scenario.ignored) expect(await readFile(join(target, path), "utf8")).toBe("private ignored bytes\n");
    const state = await git(target, "rev-parse", "--git-path", "rebase-merge/head-name");
    expect(await Bun.file(state).exists()).toBe(false);
  });
});
