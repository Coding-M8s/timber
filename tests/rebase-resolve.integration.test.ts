import { expect, mock, test } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchAgent } from "../src/agent";
import { createBackup } from "../src/backup/service";
import { runCli } from "../src/cli";
import { createRebaseHandler } from "../src/commands/rebase";
import { loadRepositoryConfig } from "../src/config";
import { discoverRepository } from "../src/git/repository";
import { rebaseWorktree, resolveRebaseTarget } from "../src/git/rebase";
import type { CommandContext, CommandServices } from "../src/services";
import { git, withRepository } from "./helpers/git";
import { advance, cli, commit, fixture, paused } from "./helpers/rebase";

interface Setup { primary: string; directory: string; publisher: string; target: string; agent: string }

/** A real repository whose feature worktree conflicts with the remote base on tracked.txt. */
async function conflicted(primary: string, directory: string, script: string, agentTable = 'resolve_handoff = "wrapper"\nresolve_instructions = "CONFIG-NOTE"'): Promise<Setup> {
  const { publisher, target } = await fixture(primary, directory);
  await commit(target, "tracked.txt", "feature\n");
  await advance(publisher, "tracked.txt", "incoming\n");
  const agent = join(directory, "agent.sh");
  await writeAgent(agent, script);
  await writeFile(join(primary, ".timber.toml"), `base_branch = "main"\n[agent]\ncommand = ${JSON.stringify(agent)}\n${agentTable}\n`);
  return { primary, directory, publisher, target, agent };
}

async function writeAgent(path: string, script: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nset -e\n" + script + "\n");
  await chmod(path, 0o755);
}

function invoke(cwd: string, args: string[], options: { answers?: string[]; interactive?: boolean; services?: Partial<CommandServices> } = {}) {
  let stdout = "", stderr = "";
  const answers = [...options.answers ?? []];
  const ask = mock(async (_message: string) => answers.shift() ?? null);
  const context: CommandContext = {
    cwd, interactive: options.interactive ?? true, ask,
    io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
  };
  const handler = createRebaseHandler({
    discoverRepository, loadConfig: loadRepositoryConfig, resolveOpenTarget: resolveRebaseTarget, rebaseWorktree,
    createBackup, launchAgent, ...options.services,
  });
  const run = runCli(["rebase", ...args], { context, handlers: { rebase: handler,
    setup: async () => {}, new: async () => {}, open: async () => {}, list: async () => {}, done: async () => {} } });
  return run.then(code => ({ code, stdout, stderr, ask }));
}

const backups = (cwd: string) => git(cwd, "for-each-ref", "--format=%(refname)", "refs/timber/backups/");
const unmerged = (cwd: string) => git(cwd, "diff", "--name-only", "--diff-filter=U");
const taskFile = async (target: string) => Bun.file(join(await git(target, "rev-parse", "--absolute-git-dir"), "timber-rebase-resolve-task.txt")).exists();

test("assistant resolves, stages and continues; task carries config then CLI note; backup made first", async () => {
  await withRepository(async (primary, directory) => {
    const s = await conflicted(primary, directory, [
      `cp "$TIMBER_TASK_FILE" ${JSON.stringify(join(directory, "task-copy.txt"))}`,
      `git for-each-ref refs/timber/backups/ > ${JSON.stringify(join(directory, "backups-seen.txt"))}`,
      "printf 'resolved\\n' > tracked.txt", "git add -- tracked.txt", "GIT_EDITOR=true git rebase --continue",
    ].join("\n"));
    const result = await invoke(primary, [s.target, "--resolve", "--resolve-note", "CLI-NOTE"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("AI assistance requested with --resolve.");
    expect(result.stdout).toContain("cannot enforce");
    expect(result.stdout).toContain("Rebase completed.");
    expect(result.stdout).not.toContain("CONFIG-NOTE");
    expect(result.stdout).not.toContain("CLI-NOTE");
    expect(result.ask).not.toHaveBeenCalled();
    expect(await paused(s.target)).toBe(false);
    expect(await readFile(join(s.target, "tracked.txt"), "utf8")).toBe("resolved\n");
    expect(await git(s.target, "merge-base", "--is-ancestor", "origin/main", "HEAD").then(() => true)).toBe(true);
    const task = await readFile(join(directory, "task-copy.txt"), "utf8");
    expect(task).toContain('"tracked.txt"');
    expect(task.indexOf("CONFIG-NOTE")).toBeGreaterThan(0);
    expect(task.indexOf("CLI-NOTE")).toBeGreaterThan(task.indexOf("CONFIG-NOTE"));
    expect(await readFile(join(directory, "backups-seen.txt"), "utf8")).toContain("refs/timber/backups/");
    expect(await taskFile(s.target)).toBe(false);
  });
});

test.each([["y", 0], ["", 1]] as const)("staged-only assistant: continue answer %j returns %d and never continues on no", async (answer, code) => {
  await withRepository(async (primary, directory) => {
    const s = await conflicted(primary, directory, "printf 'merged\\n' > tracked.txt\ngit add -- tracked.txt");
    const result = await invoke(primary, [s.target, "--resolve"], { answers: [answer] });
    expect(result.code).toBe(code);
    expect(result.ask).toHaveBeenCalledTimes(1);
    expect(await paused(s.target)).toBe(code !== 0);
    expect(await readFile(join(s.target, "tracked.txt"), "utf8")).toBe("merged\n");
    if (code !== 0) {
      expect(result.stderr).toContain("nothing was continued");
      expect(result.stderr).toContain("rebase --continue");
      expect(await git(s.target, "diff", "--cached", "--name-only")).toBe("tracked.txt");
    }
  });
});

test("assistant failure and termination keep the paused rebase, files and index intact", async () => {
  for (const [script, code] of [["exit 3", 3], ["kill -TERM $$", 143]] as const) {
    await withRepository(async (primary, directory) => {
      const s = await conflicted(primary, directory, script);
      // Plain rebase pauses first; --resolve then attaches without fetching.
      expect((await cli(primary, "rebase", s.target)).exitCode).toBe(1);
      const before = await readFile(join(s.target, "tracked.txt"), "utf8");
      const index = await git(s.target, "ls-files", "-s");
      const fetchHead = await git(s.target, "rev-parse", "FETCH_HEAD");
      await advance(s.publisher, "other.txt", "moved on\n");
      const result = await invoke(primary, [s.target, "--resolve"]);
      expect(result.code).toBe(code);
      expect(result.stderr).toContain(code === 3 ? "exited with status 3" : "interrupted by SIGTERM");
      expect(result.stderr).toContain("still paused with unmerged paths");
      expect(result.ask).not.toHaveBeenCalled();
      expect(await paused(s.target)).toBe(true);
      expect(await unmerged(s.target)).toBe("tracked.txt");
      expect(await readFile(join(s.target, "tracked.txt"), "utf8")).toBe(before);
      expect(await git(s.target, "ls-files", "-s")).toBe(index);
      expect(await git(s.target, "rev-parse", "FETCH_HEAD")).toBe(fetchHead);
      expect(await taskFile(s.target)).toBe(false);
    });
  }
});

test("changes outside the conflict set are listed with the backup before the continue offer", async () => {
  await withRepository(async (primary, directory) => {
    const s = await conflicted(primary, directory, "printf 'x\\n' > tracked.txt\ngit add -- tracked.txt\nprintf 'oops\\n' > 'old name.txt'\nprintf 'new\\n' > stray.txt");
    const result = await invoke(primary, [s.target, "--resolve"], { answers: ["n"] });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("outside the conflicts");
    expect(result.stderr).toContain('"old name.txt"');
    expect(result.stderr).toContain('"stray.txt"');
    expect(result.stderr.slice(result.stderr.indexOf("Paths outside"), result.stderr.indexOf("Review them"))).not.toContain("tracked.txt");
    expect(result.stderr).toMatch(/Recovery backup: \S+/u);
    expect(result.ask).toHaveBeenCalledTimes(1);
    expect(await readFile(join(s.target, "old name.txt"), "utf8")).toBe("oops\n");
  });
});

test("a later conflict after the continue prompt stops with guidance; rerunning --resolve attaches", async () => {
  await withRepository(async (primary, directory) => {
    const s = await conflicted(primary, directory, "printf 'first\\n' > tracked.txt\ngit add -- tracked.txt");
    await commit(s.target, "second.txt", "feature second\n");
    await advance(s.publisher, "second.txt", "incoming second\n");
    const first = await invoke(primary, [s.target, "--resolve"], { answers: ["y"] });
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("A later commit conflicts");
    expect(first.stderr).toContain('"second.txt"');
    expect(await paused(s.target)).toBe(true);
    expect((await invoke(primary, [s.target, "--resolve", "--base", "origin/main"])).stderr).toContain("--base cannot be used when attaching");
    await writeAgent(s.agent, "printf 'second\\n' > second.txt\ngit add -- second.txt\nGIT_EDITOR=true git rebase --continue");
    const second = await invoke(primary, ["TIM-28-feature", "--resolve"]);
    expect(second.code).toBe(0);
    expect(await paused(s.target)).toBe(false);
    expect((await backups(primary)).split("\n").filter(Boolean)).toHaveLength(2);
  });
});

test("attach backs up a partial manual resolution and leaves it untouched when the assistant does nothing", async () => {
  await withRepository(async (primary, directory) => {
    const s = await conflicted(primary, directory, "exit 0");
    expect((await cli(primary, "rebase", s.target)).exitCode).toBe(1);
    await writeFile(join(s.target, "tracked.txt"), "half done\n");
    await writeFile(join(s.target, ".env"), "SECRET=1\n");
    const result = await invoke(primary, [s.target, "--resolve"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("The assistant session ended.");
    expect(await readFile(join(s.target, "tracked.txt"), "utf8")).toBe("half done\n");
    const id = /Recovery backup: (\S+)\./u.exec(result.stdout)![1]!;
    const restored = join(directory, "restored");
    expect((await cli(primary, "backup", "restore", id, restored)).exitCode).toBe(0);
    expect(await readFile(join(restored, "tracked.txt"), "utf8")).toBe("half done\n");
    expect(await readFile(join(restored, ".env"), "utf8")).toBe("SECRET=1\n");
    const listed = await cli(primary, "backup", "list");
    expect(listed.stdout).toContain("rebase in progress");
  });
});

test("plain rebase never launches an enabled assistant or creates a backup", async () => {
  await withRepository(async (primary, directory) => {
    const marker = join(directory, "launched");
    const s = await conflicted(primary, directory, `touch ${JSON.stringify(marker)}`, 'enabled = true\nresolve_handoff = "wrapper"');
    const result = await invoke(primary, [s.target]);
    expect(result.code).toBe(1);
    expect(await paused(s.target)).toBe(true);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await backups(primary)).toBe("");
  });
});

test("refusals happen before any Git change: no terminal, no handoff, result file", async () => {
  await withRepository(async (primary, directory) => {
    const marker = join(directory, "launched");
    const s = await conflicted(primary, directory, `touch ${JSON.stringify(marker)}`, "");
    const tip = await git(s.target, "rev-parse", "HEAD");
    const noHandoff = await invoke(primary, [s.target, "--resolve"]);
    expect(noHandoff.code).toBe(1);
    expect(noHandoff.stderr).toContain("resolve_handoff");
    const noTerminal = await invoke(primary, [s.target, "--resolve"], { interactive: false });
    expect(noTerminal.stderr).toContain("interactive terminal");
    const machine = await cli(primary, "rebase", s.target, "--resolve", "--result-file", join(directory, "result.json"));
    expect(machine.exitCode).not.toBe(0);
    const noteOnly = await invoke(primary, [s.target, "--resolve-note", "x"]);
    expect(noteOnly.stderr).toContain("--resolve-note requires --resolve");
    expect(await paused(s.target)).toBe(false);
    expect(await git(s.target, "rev-parse", "HEAD")).toBe(tip);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await backups(primary)).toBe("");
  });
});

test("backup failure stops before the assistant; no conflict means no assistant", async () => {
  await withRepository(async (primary, directory) => {
    const marker = join(directory, "launched");
    const s = await conflicted(primary, directory, `touch ${JSON.stringify(marker)}`);
    const failed = await invoke(primary, [s.target, "--resolve"], { services: { createBackup: async () => { throw new Error("disk full"); } } });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("assistant was not started");
    expect(failed.stderr).toContain("rebase --abort");
    expect(await paused(s.target)).toBe(true);
    expect(await Bun.file(marker).exists()).toBe(false);
    await git(s.target, "rebase", "--abort");
    await git(s.target, "reset", "-q", "--hard", "HEAD~1");
    const clean = await invoke(primary, [s.target, "--resolve"]);
    expect(clean.code).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await backups(primary)).toBe("");
  });
});

test("--resolve refuses other in-progress operations without launching", async () => {
  await withRepository(async (primary, directory) => {
    const marker = join(directory, "launched");
    const s = await conflicted(primary, directory, `touch ${JSON.stringify(marker)}`);
    await git(s.target, "fetch", "-q", "origin", "main");
    await git(s.target, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "merge", "--no-edit", "FETCH_HEAD").catch(() => {});
    const result = await invoke(primary, [s.target, "--resolve"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("merge operation is in progress");
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

test("an assistant that aborts, or leaves stray edits after completing, is reported; a skip warns about lost commits", async () => {
  await withRepository(async (primary, directory) => {
    const s = await conflicted(primary, directory, "git rebase --abort");
    const tip = await git(s.target, "rev-parse", "HEAD");
    const aborted = await invoke(primary, [s.target, "--resolve"]);
    expect(aborted.code).toBe(1);
    expect(aborted.stderr).toContain("may have been aborted");
    expect(aborted.stderr).toContain(tip);
    expect(await git(s.target, "rev-parse", "HEAD")).toBe(tip);
  });
  await withRepository(async (primary, directory) => {
    const s = await conflicted(primary, directory, "printf 'r\\n' > tracked.txt\ngit add -- tracked.txt\nGIT_EDITOR=true git rebase --continue\nprintf 'late\\n' > 'old name.txt'");
    const stray = await invoke(primary, [s.target, "--resolve"]);
    expect(stray.code).toBe(0);
    expect(stray.stderr).toContain('"old name.txt"');
    expect(stray.stdout).toContain("Rebase completed.");
  });
  await withRepository(async (primary, directory) => {
    const s = await conflicted(primary, directory, "GIT_EDITOR=true git rebase --skip");
    const skipped = await invoke(primary, [s.target, "--resolve"]);
    expect(skipped.code).toBe(0);
    expect(skipped.stderr).toContain("it had 1");
  });
});

test("unstaged conflict edits and ref moves are seen; odd conflict names render safely", async () => {
  await withRepository(async (primary, directory) => {
    const { publisher, target } = await fixture(primary, directory);
    const name = "odd \"name\"\n.txt";
    await commit(target, name, "feature\n");
    await advance(publisher, name, "incoming\n");
    const agent = join(directory, "agent.sh");
    await writeAgent(agent, `printf 'edited\\n' > "$(printf 'odd "name"\\n.txt')"\ngit branch moved-by-agent`);
    await writeFile(join(primary, ".timber.toml"), `base_branch = "main"\n[agent]\ncommand = ${JSON.stringify(agent)}\nresolve_handoff = "wrapper"\n`);
    const result = await invoke(primary, [target, "--resolve"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Changed conflict paths:\n  \"odd \\\"name\\\"\\n.txt\"");
    expect(result.stderr).toContain("refs/heads/moved-by-agent");
    expect(result.stderr).not.toContain("\n.txt");
    expect(result.ask).not.toHaveBeenCalled();
  });
});

test("missing executable, absent assistant, bad notes and attach with nothing unmerged launch nothing", async () => {
  await withRepository(async (primary, directory) => {
    const s = await conflicted(primary, directory, "exit 0");
    const tip = await git(s.target, "rev-parse", "HEAD");
    for (const note of ["  ", "x".repeat(4001)]) {
      const bad = await invoke(primary, [s.target, "--resolve", "--resolve-note", note]);
      expect(bad.stderr).toContain("--resolve-note must be nonempty");
    }
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "main"\nagent = false\n');
    expect((await invoke(primary, [s.target, "--resolve"])).stderr).toContain("configured [agent]");
    expect(await git(s.target, "rev-parse", "HEAD")).toBe(tip);
    await writeFile(join(primary, ".timber.toml"), `base_branch = "main"\n[agent]\ncommand = ${JSON.stringify(join(directory, "missing-agent"))}\nresolve_handoff = "claude"\n`);
    const missing = await invoke(primary, [s.target, "--resolve"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Could not start the configured assistant");
    expect(await paused(s.target)).toBe(true);
    expect(await taskFile(s.target)).toBe(false);
    await git(s.target, "checkout", "--theirs", "tracked.txt");
    await git(s.target, "add", "tracked.txt");
    const before = (await backups(primary)).split("\n").filter(Boolean).length;
    const staged = await invoke(primary, [s.target, "--resolve"]);
    expect(staged.code).toBe(1);
    expect(staged.stderr).toContain("no unmerged paths");
    expect((await backups(primary)).split("\n").filter(Boolean)).toHaveLength(before);
  });
});
