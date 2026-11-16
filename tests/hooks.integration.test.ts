import { expect, test } from "bun:test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, ...args], {
  cwd, reject: false, timeout: 30_000, env: { CI: "true", TIMBER_TASK_ID: "stale-parent-task" },
});
const exists = (path: string) => access(path).then(() => true, () => false);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function configure(primary: string, hooks: readonly string[], extra = "") {
  await writeFile(join(primary, ".timber.toml"),
    `base_branch = "trunk"\n${extra}\n[hooks]\npost_create = ${JSON.stringify(hooks)}\n`);
}

test("new runs sequential hooks before editor with cwd and ticket context", async () => {
  await withRepository(async (primary, directory) => {
    const target = join(directory, "primary repo-worktrees", "TIM-7-setup");
    const editorCapture = join(directory, "editor capture");
    const editorScript = join(directory, "editor.sh");
    await writeFile(editorScript, `test -f completed && printf editor > ${quote(editorCapture)}\n`);
    await configure(primary, [
      'printf "%s\\n" "$PWD" "$TIMBER_REPO" "$TIMBER_WORKTREE" "$TIMBER_BRANCH" "$TIMBER_TASK_ID" > context',
      'test -f context && sleep 0.05 && printf "first\\n" > order',
      'test "$(cat order)" = first && printf "second\\n" >> order && touch completed',
      'printf "hook stdout\\n"; printf "hook stderr\\n" >&2',
    ], `[editor]\ncommand = "/bin/sh"\nargs = [${JSON.stringify(editorScript)}]\nenabled = true`);
    const result = await cli(primary, "new", "TIM-7-setup");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hook stdout");
    expect(result.stderr).toBe("hook stderr");
    expect(await readFile(join(target, "context"), "utf8"))
      .toBe(`${target}\n${primary}\n${target}\nTIM-7-setup\nTIM-7\n`);
    expect(await readFile(join(target, "order"), "utf8")).toBe("first\nsecond\n");
    for (let attempt = 0; attempt < 100 && !await exists(editorCapture); attempt++) await Bun.sleep(10);
    expect(await readFile(editorCapture, "utf8")).toBe("editor");
  });
});

test("failed setup retains all work, skips later hooks/editor, and retries only with --setup", async () => {
  await withRepository(async (primary, directory) => {
    const target = join(directory, "primary repo-worktrees", "feature-retry");
    await configure(primary, [
      'printf "attempt\\n" >> attempts; printf "modified\\n" > tracked.txt; printf "ignored\\n" > .env',
      'test -f retry-ready || exit 23',
      'touch later-step',
    ], '[editor]\ncommand = "missing-editor-must-not-start"');
    const initialRefs = await git(primary, "show-ref");
    const failed = await cli(primary, "new", "feature/retry");
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("post_create step 2");
    expect(failed.stderr).toContain("exit code 23");
    expect(failed.stderr).toContain("retained");
    expect(failed.stderr).toContain(`timber open --setup -- '${target}'`);
    expect(failed.stderr).not.toContain("configured editor");
    expect(failed.stderr).not.toContain("test -f retry-ready");
    expect(await exists(join(target, "later-step"))).toBe(false);
    const retainedRefs = await git(primary, "show-ref");
    expect(retainedRefs).toContain(initialRefs);
    expect(await git(primary, "rev-parse", "refs/heads/feature/retry"))
      .toBe(await git(target, "rev-parse", "HEAD"));
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("modified\n");
    expect(await readFile(join(target, ".env"), "utf8")).toBe("ignored\n");
    const ordinary = await cli(primary, "open", "feature/retry", "--no-editor");
    expect(ordinary.exitCode).toBe(0);
    expect(await readFile(join(target, "attempts"), "utf8")).toBe("attempt\n");
    const retryFailure = await cli(primary, "open", target, "--setup", "--no-editor");
    expect(retryFailure.exitCode).toBe(1);
    expect(retryFailure.stdout).not.toContain("Opened existing");
    expect(retryFailure.stderr).toContain("post_create step 2");
    await writeFile(join(target, "retry-ready"), "ready");
    const retry = await cli(primary, "open", "feature/retry", "--setup", "--no-editor");
    expect(retry.exitCode).toBe(0);
    expect(retry.stderr).toBe("");
    expect(await readFile(join(target, "attempts"), "utf8")).toBe("attempt\nattempt\nattempt\n");
    expect(await exists(join(target, "later-step"))).toBe(true);
    expect(await git(primary, "show-ref")).toBe(retainedRefs);
    expect(await readFile(join(target, ".env"), "utf8")).toBe("ignored\n");
  });
});

test.each([false, true])("open materializes a local branch and runs setup once (--setup=%s)", async explicit => {
  await withRepository(async (primary, directory) => {
    await git(primary, "branch", "local");
    await configure(primary, ['printf "run\\n" >> count; test "${TIMBER_TASK_ID+x}" != x']);
    const result = await cli(primary, "open", "local", ...(explicit ? ["--setup"] : []));
    expect(result.exitCode).toBe(0);
    const target = join(directory, "primary repo-worktrees", "local");
    expect(await readFile(join(target, "count"), "utf8")).toBe("run\n");
    expect((await cli(primary, "open", "local")).exitCode).toBe(0);
    expect(await readFile(join(target, "count"), "utf8")).toBe("run\n");
  });
});

test("open creates a tracking worktree and retains it when setup fails", async () => {
  await withRepository(async (primary, directory) => {
    const bare = join(directory, "origin.git");
    await git(directory, "init", "--bare", bare);
    await git(primary, "remote", "add", "origin", bare);
    await git(primary, "push", "origin", "trunk:remote-feature");
    await configure(primary, ['touch retained; exit 19']);
    const result = await cli(primary, "open", "origin/remote-feature");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("post_create step 1");
    const target = join(directory, "primary repo-worktrees", "remote-feature");
    expect(await exists(join(target, "retained"))).toBe(true);
    expect(await git(target, "rev-parse", "--abbrev-ref", "@{upstream}"))
      .toBe("origin/remote-feature");
    expect(await git(primary, "rev-parse", "refs/heads/remote-feature"))
      .toBe(await git(target, "rev-parse", "HEAD"));
  });
});

test("explicit setup reads only primary config and treats hostile paths/branches as environment data", async () => {
  await withRepository(async (primary, directory) => {
    const marker = join(directory, "injected");
    const branch = "TIM-8-$(touch${IFS}injected);'quoted";
    const target = join(directory, "hostile ' $(touch injected) `touch injected`\npath");
    await git(primary, "worktree", "add", "-b", branch, target);
    const nested = join(target, "nested");
    await mkdir(nested);
    await configure(primary, ['printf "%s\\n" "$TIMBER_WORKTREE" "$TIMBER_BRANCH" "$TIMBER_TASK_ID" > context']);
    await writeFile(join(target, ".timber.toml"), '[hooks]\npost_create = ["exit 99"]');
    const result = await cli(nested, "open", target, "--setup");
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(target, "context"), "utf8"))
      .toBe(`${target}\n${branch}\nTIM-8\n`);
    expect(await exists(marker)).toBe(false);
    expect(await exists(join(primary, "injected"))).toBe(false);
    expect(await exists(join(target, "injected"))).toBe(false);
  });
});

test("explicit setup on detached worktrees supplies an empty branch and no stale task ID", async () => {
  await withRepository(async (primary, directory) => {
    const target = join(directory, "detached");
    await git(primary, "worktree", "add", "--detach", target);
    await configure(primary, ['test "$TIMBER_BRANCH" = "" && test "${TIMBER_TASK_ID+x}" != x && touch setup-ran']);
    expect((await cli(primary, "open", target, "--setup")).exitCode).toBe(0);
    expect(await exists(join(target, "setup-ran"))).toBe(true);
  });
});
