import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { cli, entry, mergedIntoParent, removed, retained, saveBase, snapshot, target, upstream } from "./helpers/done";

test("done uses the saved epic base instead of config: squash", async () => {
  await withRepository(async (primary, directory) => {
    const { path } = await mergedIntoParent(primary, directory, true, false);
    await saveBase(primary, path, "refs/heads/feature/parent");
    const parent = await git(primary, "rev-parse", "feature/parent");
    const trunk = await git(primary, "rev-parse", "trunk");
    const config = await readFile(join(primary, ".timber.toml"));
    const result = await cli(primary, path);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    await removed(primary, path, "feature/one", true);
    expect(await git(primary, "rev-parse", "feature/parent")).toBe(parent);
    expect(await git(primary, "rev-parse", "trunk")).toBe(trunk);
    expect(await readFile(join(primary, ".timber.toml"))).toEqual(config);
  });
});

test("done explicit base overrides the saved choice without rewriting it", async () => {
  await withRepository(async (primary, directory) => {
    const { path } = await mergedIntoParent(primary, directory);
    const file = await saveBase(primary, path, "refs/heads/trunk");
    const record = await readFile(file, "utf8");
    const before = await snapshot(primary);
    expect((await cli(primary, path)).exitCode).toBe(1);
    await retained(primary, path, before);
    expect(await readFile(file, "utf8")).toBe(record);
    const result = await cli(primary, path, "--base", "refs/heads/feature/parent");
    expect(result.exitCode).toBe(0);
    await removed(primary, path, "feature/one", true);
  });
});

test.each(["missing", "missing-local-shadow", "missing-remote-shadow", "self", "malformed", "stale"])("done refuses a %s saved base even with published work", async scenario => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    await upstream(primary, directory, path);
    const file = await saveBase(primary, path, scenario === "self" ? "refs/heads/feature/one" : "refs/heads/trunk");
    if (scenario.startsWith("missing")) {
      const ref = scenario === "missing-remote-shadow" ? "refs/remotes/backup/missing" : "refs/heads/missing";
      if (scenario !== "missing") await git(primary, "branch", ref);
      const record = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...record, ref }));
    } else if (scenario === "malformed") await writeFile(file, "invalid JSON");
    else if (scenario === "stale") {
      const record = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...record, worktreePath: primary }));
    }
    const record = await readFile(file, "utf8");
    const before = await snapshot(primary);
    const result = await cli(primary, path, "--keep-branch");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/base/i);
    await retained(primary, path, before);
    expect(await readFile(file, "utf8")).toBe(record);
    const override = await cli(primary, path, "--base", "refs/heads/trunk");
    expect(override.exitCode).toBe(scenario === "malformed" ? 1 : 0);
    if (scenario === "malformed") await retained(primary, path, before);
    else await removed(primary, path, "feature/one", true);
  });
});

test("done rechecks the saved base association after hooks even when both bases contain the branch", async () => {
  await withRepository(async (primary, directory) => {
    const path = await target(primary, directory);
    const file = await saveBase(primary, path, "refs/heads/trunk");
    await git(primary, "branch", "other");
    const hook = join(directory, "change-base.sh");
    // In-place sed flags differ between GNU and BSD, so rewrite through a temporary file.
    await writeFile(hook, 'sed "s@refs/heads/trunk@refs/heads/other@" "$TIMBER_BASE_RECORD" > "$TIMBER_BASE_RECORD.next" && mv "$TIMBER_BASE_RECORD.next" "$TIMBER_BASE_RECORD"\n');
    await writeFile(join(primary, ".timber.toml"), `base_branch = "trunk"\n[hooks]\npre_delete = ['sh "${hook}"']\n`);
    const before = await snapshot(primary);
    const result = await execa(process.execPath, [entry, "done", path], {
      cwd: primary, reject: false, timeout: 30_000, env: { CI: "true", TIMBER_BASE_RECORD: file },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/base.*changed/i);
    await retained(primary, path, before);
  });
});
