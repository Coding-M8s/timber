import { expect, test } from "bun:test";
import { execa } from "execa";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, stat } from "node:fs/promises";
import { withRepository, git } from "./helpers/git";
import { discoverRepository } from "../src/git/repository";
import { readArena } from "../src/arena/storage";
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
async function remoteFixture(
  run: (primary: string, directory: string, taskFile: string) => Promise<void>,
) {
  await withRepository(async (primary, directory) => {
    const bare = join(directory, "upstream.git");
    await git(directory, "init", "--bare", bare);
    await git(primary, "remote", "add", "upstream", bare);
    await git(primary, "push", "upstream", "trunk:feature/TIM-123-api");
    await git(
      primary,
      "update-ref",
      "-d",
      "refs/remotes/upstream/feature/TIM-123-api",
    );
    await writeFile(join(primary, "tracked.txt"), "keep dirty source");
    await writeFile(join(primary, "untracked"), "keep untracked");
    await writeFile(join(primary, ".env"), "keep ignored");
    const taskFile = join(directory, "task.md");
    await writeFile(taskFile, "Do remaining work; do not commit.");
    await run(primary, directory, taskFile);
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe(
      "keep dirty source",
    );
    expect(await readFile(join(primary, "untracked"), "utf8")).toBe(
      "keep untracked",
    );
    expect(await readFile(join(primary, ".env"), "utf8")).toBe("keep ignored");
  });
}

test("ticket remote source without cached ref/worktree creates only fresh attempt worktrees", async () => {
  await remoteFixture(async (primary, _directory, taskFile) => {
    const result = await execa(
      process.execPath,
      [
        "--no-env-file",
        entry,
        "arena",
        "new",
        "TIM-123",
        "--name",
        "api",
        "--prompt-file",
        taskFile,
        "--tool",
        "manual",
        "--runs",
        "2",
        "--no-editor",
      ],
      { cwd: primary, reject: false, env: { CI: "1" } },
    );
    expect(result.exitCode).toBe(0);
    const saved = await readArena(await discoverRepository(primary), "api");
    expect(saved.manifest.base.commit).toBe(
      await git(primary, "rev-parse", "trunk"),
    );
    for (const attempt of saved.manifest.attempts)
      expect(await git(attempt.path, "rev-parse", "HEAD")).toBe(
        saved.manifest.base.commit,
      );
    expect(
      (await git(primary, "worktree", "list", "--porcelain")).match(
        /^worktree /gm,
      ),
    ).toHaveLength(3);
    await expect(
      git(primary, "show-ref", "--verify", "refs/heads/feature/TIM-123-api"),
    ).rejects.toThrow();
  });
});

test("remote source cancellation leaves cached refs, worktrees and arena metadata unchanged", async () => {
  await remoteFixture(async (primary, _directory, taskFile) => {
    const refs = await git(primary, "show-ref"),
      trees = await git(primary, "worktree", "list", "--porcelain");
    let output = "",
      sent = false;
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        entry,
        "arena",
        "new",
        "demo",
        "--base",
        "upstream/feature/TIM-123-api",
        "--prompt-file",
        taskFile,
        "--tool",
        "manual",
        "--runs",
        "2",
        "--no-editor",
      ],
      {
        cwd: primary,
        env: { ...process.env, CI: "false" },
        timeout: 4000,
        terminal: {
          data(terminal, bytes) {
            output += Buffer.from(bytes).toString("utf8");
            if (!sent && output.includes("[y/N]")) {
              sent = true;
              terminal.write("n\r");
            }
          },
        },
      },
    );
    try {
      expect(await child.exited).toBe(0);
      expect(output).toContain("Cancelled.");
      expect(output).toContain("fetch");
    } finally {
      child.kill();
      child.terminal?.close();
    }
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
    await expect(
      stat(
        join(
          (await discoverRepository(primary)).commonGitDir,
          "timber/arenas/demo",
        ),
      ),
    ).rejects.toThrow();
  });
});

test("cached/live remote attempt names block whole arena before fetch", async () => {
  await remoteFixture(async (primary, _directory, taskFile) => {
    await git(primary, "push", "upstream", "trunk:arena/demo/manual-2");
    await git(
      primary,
      "update-ref",
      "-d",
      "refs/remotes/upstream/arena/demo/manual-2",
    );
    const refs = await git(primary, "show-ref");
    const result = await execa(
      process.execPath,
      [
        "--no-env-file",
        entry,
        "arena",
        "new",
        "demo",
        "--base",
        "upstream/feature/TIM-123-api",
        "--prompt-file",
        taskFile,
        "--tool",
        "manual",
        "--runs",
        "2",
        "--no-editor",
      ],
      { cwd: primary, reject: false, env: { CI: "1" } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("remote attempt branch collision");
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(
      (await git(primary, "worktree", "list", "--porcelain")).match(
        /^worktree /gm,
      ),
    ).toHaveLength(1);
  });
});

test("ambiguous local ticket sources report exact selectors without fetching or creating", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "branch", "feature/TIM-123-api");
    await git(primary, "branch", "user/TIM-123-ui");
    await git(primary, "remote", "add", "offline", join(directory, "missing"));
    const task = join(directory, "task.md");
    await writeFile(task, "remaining work");
    const refs = await git(primary, "show-ref");
    const result = await execa(
      process.execPath,
      [
        "--no-env-file",
        entry,
        "arena",
        "new",
        "TIM-123",
        "--prompt-file",
        task,
        "--tool",
        "manual",
        "--runs",
        "2",
        "--no-editor",
      ],
      { cwd: primary, reject: false, env: { CI: "1" } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("refs/heads/feature/TIM-123-api");
    expect(result.stderr).toContain("refs/heads/user/TIM-123-ui");
    expect(result.stderr).toContain("--base");
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

test("ticket source chooser and final review preserve pasted selection and cancellation", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "branch", "feature/TIM-123-api");
    await git(primary, "branch", "user/TIM-123-ui");
    const task = join(directory, "task.md");
    await writeFile(task, "remaining work");
    const refs = await git(primary, "show-ref");
    let output = "",
      sent = false;
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        entry,
        "arena",
        "new",
        "TIM-123",
        "--prompt-file",
        task,
        "--tool",
        "manual",
        "--runs",
        "2",
        "--no-editor",
      ],
      {
        cwd: primary,
        env: { ...process.env, CI: "false" },
        timeout: 4000,
        terminal: {
          data(terminal, bytes) {
            output += Buffer.from(bytes).toString("utf8");
            if (!sent && output.includes("Enter select")) {
              sent = true;
              terminal.write("2n\r");
            }
          },
        },
      },
    );
    try {
      expect(await child.exited).toBe(0);
      expect(output).toContain("Cancelled.");
      expect(output).toContain("feature/TIM-123-api");
    } finally {
      child.kill();
      child.terminal?.close();
    }
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});
