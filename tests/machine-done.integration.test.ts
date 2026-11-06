import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, withRepository } from "./helpers/git";
import { previewCleanup, applyCleanup } from "../src/machine-done";

const io = { stdout: (_text: string) => {}, stderr: (_text: string) => {} };
async function setup(primary: string, directory: string) {
  await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n');
  const path = join(directory, "linked");
  await git(primary, "worktree", "add", "-b", "feature", path);
  return path;
}
const options = { keepBranch: true, discardIgnored: true };
test("native approval removes dirty worktree without prompting and keeps its branch", async () => {
  await withRepository(async (primary, directory) => {
    const path = await setup(primary, directory);
    await writeFile(join(path, "tracked.txt"), "local edit");
    const preview = await previewCleanup(primary, path, options);
    expect(preview.worktree.status.kind).toBe("known");
    expect((await git(primary, "worktree", "list", "--porcelain"))).toContain(path);
    await applyCleanup(primary, path, preview, io);
    expect((await git(primary, "worktree", "list", "--porcelain"))).not.toContain(path);
    expect(await git(primary, "rev-parse", "feature")).toBe(await git(primary, "rev-parse", "trunk"));
  });
});
test.each(["files", "head", "options", "expiry", "target"])("native approval rejects changed %s and retains work", async change => {
  await withRepository(async (primary, directory) => {
    const path = await setup(primary, directory);
    await writeFile(join(path, "tracked.txt"), "local edit");
    const preview = await previewCleanup(primary, path, options);
    if (change === "files") await writeFile(join(path, "tracked.txt"), "new edit");
    if (change === "head") {
      await git(path, "add", ".");
      await git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "changed head");
    }
    if (change === "options") preview.options.keepBranch = false;
    if (change === "expiry") preview.expiresAt = 0;
    await expect(applyCleanup(primary, change === "target" ? primary : path, preview, io)).rejects.toThrow();
    expect(await git(primary, "worktree", "list", "--porcelain")).toContain(path);
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe(change === "files" ? "new edit" : "local edit");
  });
});
test("native preview enforces keep-ignored and primary protections", async () => {
  await withRepository(async (primary, directory) => {
    const path = await setup(primary, directory);
    await writeFile(join(path, ".env"), "secret");
    await expect(previewCleanup(primary, path, { keepBranch: true, discardIgnored: false })).rejects.toThrow();
    await expect(previewCleanup(primary, primary, options)).rejects.toThrow();
  });
});
test("native approval retains worktree when deletion hook fails", async () => {
  await withRepository(async (primary, directory) => {
    const path = await setup(primary, directory);
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n[hooks]\npre_delete = ["exit 7"]\n');
    const preview = await previewCleanup(primary, path, options);
    await expect(applyCleanup(primary, path, preview, io)).rejects.toThrow();
    expect(await git(primary, "worktree", "list", "--porcelain")).toContain(path);
  });
});

test("native approval rejects root replacement by a hook on the clean cleanup path", async () => {
  await withRepository(async (primary, directory) => {
    const path = await setup(primary, directory);
    const hook = 'saved="$TIMBER_WORKTREE.saved"; mv "$TIMBER_WORKTREE" "$saved"; mkdir "$TIMBER_WORKTREE"; cp -a "$saved/." "$TIMBER_WORKTREE/"';
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n[hooks]\npre_delete = [' + JSON.stringify(hook) + ']\n');
    const preview = await previewCleanup(primary, path, options);
    await expect(applyCleanup(primary, path, preview, io)).rejects.toThrow("changed");
    expect(await git(primary, "worktree", "list", "--porcelain")).toContain(path);
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("original\n");
  });
});
test("single native approval discards unmerged commits and deletes the branch when selected", async () => {
  await withRepository(async (primary, directory) => {
    const path = await setup(primary, directory);
    await writeFile(join(path, "tracked.txt"), "committed change");
    await git(path, "add", ".");
    await git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "unpublished");
    const preview = await previewCleanup(primary, path, { keepBranch: false, discardIgnored: true });
    await applyCleanup(primary, path, preview, io);
    expect(await git(primary, "branch", "--list", "feature")).toBe("");
    expect(await git(primary, "worktree", "list", "--porcelain")).not.toContain(path);
  });
});
test("native CLI transport returns preview and done envelope without a terminal", async () => {
  const { execa } = await import("execa");
  const { fileURLToPath } = await import("node:url");
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  await withRepository(async (primary, directory) => {
    const path = await setup(primary, directory);
    const invoke = (...args: string[]) => execa(process.execPath, [entry, "__ide-done", ...args], { cwd: primary, reject: false, env: { CI: "true" } });
    const preview = await invoke("preview", "--keep-branch", "--", path);
    expect(preview.exitCode).toBe(0);
    const approval = join(directory, "approval.json"), resultFile = join(directory, "result.json");
    await writeFile(approval, preview.stdout);
    const result = await invoke("apply", "--approval-file", approval, "--result-file", resultFile, "--", path);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(resultFile, "utf8"))).toMatchObject({ command: "done", outcome: "succeeded", exitCode: 0, materialized: false });
  });
});
test("native malformed approvals return a failed result without mutating the target", async () => {
  const { execa } = await import("execa");
  const { fileURLToPath } = await import("node:url");
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  await withRepository(async (primary, directory) => {
    const path = await setup(primary, directory);
    const approval = join(directory, "approval.json"), result = join(directory, "result.json");
    await writeFile(approval, "{bad");
    const applied = await execa(process.execPath, [entry, "__ide-done", "apply", "--approval-file", approval, "--result-file", result, "--", path], { cwd: primary, reject: false, env: { CI: "true" } });
    expect(applied.exitCode).toBe(1);
    expect(JSON.parse(await readFile(result, "utf8"))).toMatchObject({ command: "done", outcome: "failed", exitCode: 1 });
    expect(await git(primary, "worktree", "list", "--porcelain")).toContain(path);
  });
});
