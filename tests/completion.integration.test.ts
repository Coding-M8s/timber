import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { fileURLToPath } from "node:url";
import { candidates } from "./helpers/completion";
import { git, withRepository } from "./helpers/git";

test("completion reads fresh Git targets from primary, nested and linked checkouts", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "linked tree");
    const detached = join(directory, "detached tree");
    await git(primary, "worktree", "add", "-b", "TIM-23-one", linked);
    await git(primary, "worktree", "add", "--detach", detached);
    await git(primary, "branch", "TIM-23-two");
    await git(primary, "remote", "add", "origin", "https://example.invalid/never-contact");
    await git(primary, "remote", "add", "other", "https://example.invalid/never-contact");
    await git(primary, "update-ref", "refs/remotes/origin/shared", "HEAD");
    await git(primary, "update-ref", "refs/remotes/other/shared", "HEAD");
    await git(primary, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/shared");
    await writeFile(join(linked, "tracked.txt"), "dirty\n");
    await writeFile(join(linked, ".env"), "ignored\n");
    await writeFile(join(linked, "untracked"), "untracked\n");
    // Even invalid launch/Jira config must never be parsed by completion.
    await writeFile(join(primary, ".timber.toml"), "invalid TOML [[[\n");
    const nested = join(primary, "nested");
    await mkdir(nested);
    const beforeRefs = await git(primary, "show-ref");
    const beforeIndex = await readFile(join(primary, ".git/index"));
    const beforeInventory = await git(primary, "worktree", "list", "--porcelain", "-z");
    const open = ["TIM-23-one", "TIM-23-two", detached, linked, "origin/shared", "other/shared", primary, "trunk"].sort();
    const done = ["TIM-23-one", detached, linked].sort();
    for (const cwd of [primary, nested, linked]) {
      expect(await candidates("timber open ", cwd)).toEqual(open);
      expect(await candidates("timber done ", cwd)).toEqual(done);
      expect(await candidates("timber open TIM-23", cwd)).toEqual(["TIM-23-one", "TIM-23-two"]);
      expect(await candidates("timber done --keep-branch TIM-", cwd)).toEqual(["TIM-23-one"]);
      expect(await candidates("timber done --typo TIM-", cwd)).toEqual(["TIM-23-one"]);
      expect(await candidates("timber new --base ori", cwd)).toEqual(["origin/shared"]);
      expect(await candidates("timber new --base=oth", cwd)).toEqual(["--base=other/shared"]);
      expect(await candidates("timber done TIM-23-one --base ori", cwd)).toEqual(["origin/shared"]);
      expect(await candidates("timber done --base=oth", cwd)).toEqual(["--base=other/shared"]);
    }
    expect(await git(primary, "show-ref")).toBe(beforeRefs);
    expect(await readFile(join(primary, ".git/index"))).toEqual(beforeIndex);
    expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(beforeInventory);
    expect(await readFile(join(linked, "tracked.txt"), "utf8")).toBe("dirty\n");
    expect(await readFile(join(linked, ".env"), "utf8")).toBe("ignored\n");
    expect(await readFile(join(linked, "untracked"), "utf8")).toBe("untracked\n");

    const fresh = join(directory, "fresh");
    await git(primary, "worktree", "add", "-b", "fresh", fresh);
    expect(await candidates("timber done fresh", nested)).toEqual(["fresh"]);
    await git(primary, "worktree", "remove", fresh);
    expect(await candidates("timber done fresh", linked)).toEqual([]);
    expect(await candidates("timber open fresh", linked)).toEqual(["fresh"]);
    // Stale inventory remains discoverable; normal execution handles validity.
    await rm(detached, { recursive: true });
    expect(await candidates("timber done ", primary)).toContain(detached);
  });
});

test("duplicate branch worktrees offer only unambiguous path selectors", async () => {
  await withRepository(async (primary, directory) => {
    const one = join(directory, "one");
    const two = join(directory, "two");
    await git(primary, "worktree", "add", "-b", "shared", one);
    await git(primary, "worktree", "add", "--force", two, "shared");
    await git(primary, "branch", "shared-sibling");
    expect(await candidates("timber done ", primary)).toEqual([one, two].sort());
    expect(await candidates("timber open sh", primary)).toEqual(["shared-sibling"]);
    expect(await candidates("timber open ", primary)).toEqual([one, two, primary, "shared-sibling", "trunk"].sort());
    await git(primary, "worktree", "remove", two);
    expect(await candidates("timber done sh", primary)).toEqual(["shared"]);
  });
});

test("missing repository directories return quietly", async () => {
  expect(await candidates("timber done ", "/nonexistent/timber-completion-test")).toEqual([]);
  expect(await candidates("timber open --no-", "/nonexistent/timber-completion-test")).toEqual(["--no-agent", "--no-editor"]);
});

test("unreadable Git metadata quietly yields no targets while commands still complete", async () => {
  await withRepository(async (primary) => {
    // Git cannot read a directory as its config file, including under root.
    await rm(join(primary, ".git/config"));
    await mkdir(join(primary, ".git/config"));
    expect(await candidates("timber open ", primary)).toEqual([]);
    expect(await candidates("timber done ", primary)).toEqual([]);
    expect(await candidates("timber o", primary)).toEqual(["open"]);
  });
});

test("local names that resemble explicit remotes use resolvable selectors", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "remote", "add", "origin", "https://example.invalid/never-contact");
    await git(primary, "branch", "origin/only-local");
    const linked = join(directory, "remote-shaped-local");
    await git(primary, "worktree", "add", "-b", "origin/linked-local", linked);
    expect(await candidates("timber open origin/", primary)).toEqual([]);
    expect(await candidates("timber open ", primary)).toContain(linked);
    expect(await candidates("timber new --base ori", primary)).toEqual([]);
    expect(await candidates("timber new --base refs/heads/ori", primary)).toEqual([
      "refs/heads/origin/linked-local", "refs/heads/origin/only-local",
    ]);
    expect(await candidates("timber done ", primary)).toContain(linked);
    expect(await candidates("timber done origin/", primary)).toEqual([]);
    await git(primary, "update-ref", "refs/remotes/origin/only-local", "HEAD");
    expect(await candidates("timber open origin/only-", primary)).toEqual(["origin/only-local"]);
  });
});

test("CLI completion cannot launch tools, contact remotes, inspect status, or write first-use state", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "linked");
    await git(primary, "worktree", "add", "-b", "linked", linked);
    await git(primary, "remote", "add", "origin", "https://example.invalid/never-contact");
    await git(primary, "update-ref", "refs/remotes/origin/cached", "HEAD");
    const marker = join(directory, "TOOL_WAS_LAUNCHED");
    const executable = join(directory, "launch-tool");
    await writeFile(executable, '#!/bin/sh\ntouch "$TIMBER_FORBIDDEN_MARKER"\n', { mode: 0o755 });
    await writeFile(join(primary, ".timber.toml"), [
      "[editor]", "command = " + JSON.stringify(executable),
      "[agent]", "command = " + JSON.stringify(executable), "enabled = true",
      "[hooks]", 'post_create = [\'touch "$TIMBER_FORBIDDEN_MARKER"\']',
      "[jira]", 'site_url = "https://example.atlassian.net"',
    ].join("\n"));
    const bin = join(directory, "bin");
    await mkdir(bin);
    const calls = join(directory, "git-calls");
    const realGit = (await execa("which", ["git"])).stdout;
    await writeFile(join(bin, "git"), [
      "#!/bin/sh",
      '[ "${GIT_OPTIONAL_LOCKS-}" = 0 ] || exit 95',
      'printf "%s\\n" "$1" >> "$TIMBER_GIT_CALLS"',
      'case "$1" in',
      '  rev-parse|symbolic-ref|for-each-ref) ;;',
      '  remote) [ "$#" -eq 1 ] || exit 91 ;;',
      '  worktree) [ "$2" = list ] || exit 92 ;;',
      '  *) exit 93 ;;',
      "esac",
      'exec "$TIMBER_REAL_GIT" "$@"',
    ].join("\n"), { mode: 0o755 });
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const env = {
      PATH: bin + ":" + process.env.PATH, XDG_STATE_HOME: join(directory, "state"),
      XDG_CONFIG_HOME: join(directory, "config"), TIMBER_REAL_GIT: realGit,
      TIMBER_GIT_CALLS: calls, TIMBER_FORBIDDEN_MARKER: marker,
    };
    for (const command of ["open", "done"]) {
      const line = "timber " + command + " ";
      const result = await execa(process.execPath, ["--no-env-file", entry, "__complete", "--", line], {
        cwd: primary, env, timeout: 3_000,
      });
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("linked\0");
    }
    const operations = (await readFile(calls, "utf8")).trim().split("\n");
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every(value => ["rev-parse", "symbolic-ref", "remote", "worktree", "for-each-ref"].includes(value))).toBe(true);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(join(directory, "state/timber/setup-hint-shown")).exists()).toBe(false);
    // Missing Git must be as quiet as a missing repository.
    const result = await execa(process.execPath, ["--no-env-file", entry, "__complete", "--", "timber done "], {
      cwd: primary, env: { ...env, PATH: join(directory, "missing-bin") }, timeout: 3_000,
    });
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

test("a stalled Git read ends quietly within the completion deadline", async () => {
  await withRepository(async (primary, directory) => {
    const bin = join(directory, "stall bin");
    const pidFile = join(directory, "stalled pid");
    const stall = join(directory, "ignore-term.ts");
    await mkdir(bin);
    await writeFile(stall, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.TIMBER_STALL_PID!, `${process.pid}\\n`);",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    await writeFile(join(bin, "git"), [
      "#!/bin/sh",
      'if [ "$1" = for-each-ref ]; then exec "$TIMBER_BUN" "$TIMBER_STALL"; fi',
      'exec "$TIMBER_REAL_GIT" "$@"',
    ].join("\n"), { mode: 0o755 });
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const started = Date.now();
    const result = await execa(process.execPath, ["--no-env-file", entry, "__complete", "--", "timber open t"], {
      cwd: primary, timeout: 5_000, env: {
        PATH: bin + ":" + process.env.PATH, XDG_STATE_HOME: join(directory, "state"),
        TIMBER_REAL_GIT: (await execa("which", ["git"])).stdout, TIMBER_BUN: process.execPath,
        TIMBER_STALL: stall, TIMBER_STALL_PID: pidFile,
      },
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
