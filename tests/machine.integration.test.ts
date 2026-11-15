import { expect, test } from "bun:test";
import { access, chmod, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, ...args], {
  cwd, reject: false, timeout: 10_000, env: { CI: "true" },
});
const flags = (path: string) => ["--result-file", path, "--no-editor", "--no-agent"];
const record = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const exists = (path: string) => access(path).then(() => true, () => false);

async function configure(primary: string, hooks: string[] = [], extra = "") {
  await writeFile(join(primary, ".timber.toml"), `base_branch = "trunk"\n${extra}\n[hooks]\npost_create = ${JSON.stringify(hooks)}\n`);
}

test("machine listing preserves all Git rows, identities, raw paths and known/unknown status", async () => {
  await withRepository(async (primary, directory) => {
    const detached = join(directory, "detached space\nand newline");
    const missing = join(directory, "missing tree");
    await git(primary, "worktree", "add", "--detach", detached);
    await git(primary, "worktree", "add", "-b", "missing", missing);
    await git(primary, "worktree", "lock", "--reason", "manual lock", detached);
    await rm(missing, { recursive: true });
    await writeFile(join(detached, "untracked name\n.txt"), "retain");
    const refs = await git(primary, "show-ref");
    const result = await cli(primary, "ls", "--json");
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.schemaVersion).toBe(1);
    expect(data.command).toBe("ls");
    expect(data.outcome).toBe("succeeded");
    expect(data.repository.commonGitDir).toBe(await realpath(join(primary, ".git")));
    expect(data.repository.primaryWorktreeRoot).toBe(await realpath(primary));
    expect(data.worktrees).toHaveLength(3);
    expect(data.worktrees[0].isPrimary).toBe(true);
    const det = data.worktrees.find((tree: { path: string }) => tree.path === detached);
    expect(det).toMatchObject({ branch: null, detached: true, pathExists: true, locked: { reason: "manual lock" } });
    expect(det.status).toMatchObject({ kind: "known", untracked: ["untracked name\n.txt"] });
    expect(data.worktrees.find((tree: { path: string }) => tree.path === missing))
      .toMatchObject({ pathExists: false, status: { kind: "unknown" }, prunable: { reason: expect.any(String) } });
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("original\n");
    expect((await cli(primary, "ls")).stdout).toContain("WORKTREE");
  });
});

test("new result is separate from hook streams and suppresses configured workflow launches", async () => {
  await withRepository(async (primary, directory) => {
    await configure(primary, ['printf \'{"fake":"json"}\\n\'; printf "hook diagnostic\\n" >&2; touch ordinary'],
      '[editor]\ncommand = "must-not-launch"\nenabled = true\nintegration = "orca"\n[agent]\ncommand = "must-not-launch-agent"\nenabled = true\n[workflows.review]\npost_create = ["test -f ordinary && touch workflow"]\n[workflows.review.editor]\ncommand = "must-not-launch-workflow"\n[workflows.review.agent]\ncommand = "must-not-launch-workflow-agent"');
    const output = join(directory, "result file.json");
    const result = await cli(primary, "new", "feature", "space", "--workflow", "review", ...flags(output));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('{"fake":"json"}');
    expect(result.stdout).toContain("Created feature-space at");
    expect(result.stderr).toContain("hook diagnostic");
    const data = await record(output);
    const target = join(directory, "primary repo-worktrees", "feature-space");
    expect(data).toMatchObject({ schemaVersion: 1, command: "new", outcome: "succeeded", exitCode: 0,
      materialized: true, diagnostic: null, worktree: { path: target, branch: "feature-space" } });
    expect(await exists(join(target, "workflow"))).toBe(true);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(await git(primary, "rev-parse", "refs/heads/feature-space")).toBe(await git(target, "rev-parse", "HEAD"));
  });
});

test("open reports actual local materialization and existing detached target without replaying hooks", async () => {
  await withRepository(async (primary, directory) => {
    await configure(primary, ['printf "run\\n" >> runs']);
    await git(primary, "branch", "local");
    const output = join(directory, "created.json");
    expect((await cli(primary, "open", "local", ...flags(output))).exitCode).toBe(0);
    const created = await record(output);
    expect(created.materialized).toBe(true);
    const target = created.worktree.path;
    const existing = join(directory, "existing.json");
    expect((await cli(primary, "open", target, ...flags(existing))).exitCode).toBe(0);
    expect(await record(existing)).toMatchObject({ outcome: "succeeded", materialized: false, worktree: { path: target } });
    expect(await readFile(join(target, "runs"), "utf8")).toBe("run\n");
    const detached = join(directory, "manual detached");
    await git(primary, "worktree", "add", "--detach", detached);
    const detOutput = join(directory, "detached.json");
    expect((await cli(primary, "open", detached, ...flags(detOutput))).exitCode).toBe(0);
    expect(await record(detOutput)).toMatchObject({ materialized: false, worktree: { path: detached, branch: null } });
  });
});

for (const command of ["new", "open"] as const) {
  test(`${command} reports retained actual worktree after setup failure and preserves original files/refs`, async () => {
    await withRepository(async (primary, directory) => {
      await configure(primary, ['printf "modified\\n" > tracked.txt; touch retained; exit 23', 'touch forbidden']);
      if (command === "open") await git(primary, "branch", "feature");
      const refs = await git(primary, "show-ref");
      const output = join(directory, "failure.json");
      expect((await cli(primary, command, "feature", ...flags(output))).exitCode).toBe(1);
      const data = await record(output);
      expect(data).toMatchObject({ outcome: "failed", exitCode: 1, materialized: true, worktree: { branch: "feature" } });
      expect(data.diagnostic).toContain("post_create step 1");
      expect(await readFile(join(data.worktree.path, "tracked.txt"), "utf8")).toBe("modified\n");
      expect(await exists(join(data.worktree.path, "retained"))).toBe(true);
      expect(await exists(join(data.worktree.path, "forbidden"))).toBe(false);
      expect(await git(primary, "show-ref")).toContain(refs);
      expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("original\n");
    });
  });
}

test("ambiguous and missing opens report failure without inferring a target or changing refs/files", async () => {
  await withRepository(async (primary, directory) => {
    for (const branch of ["TIM-42-one", "TIM-42-two"]) await git(primary, "branch", branch);
    const refs = await git(primary, "show-ref");
    for (const input of ["TIM-42", "absent"]) {
      const output = join(directory, input + ".json");
      const result = await cli(primary, "open", input, ...flags(output));
      expect(result.exitCode).toBe(1);
      expect(await record(output)).toMatchObject({ outcome: "failed", worktree: null, materialized: false });
      if (input === "TIM-42") expect(result.stderr).toContain("TIM-42-one");
    }
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("result transport refuses existing files and symlinks before Git mutation", async () => {
  await withRepository(async (primary, directory) => {
    const protectedFile = join(directory, "protected");
    const link = join(directory, "link");
    await writeFile(protectedFile, "do not overwrite");
    await symlink(protectedFile, link);
    const refs = await git(primary, "show-ref");
    for (const output of [protectedFile, link]) {
      expect((await cli(primary, "new", "blocked", ...flags(output))).exitCode).toBe(1);
      expect(await readFile(protectedFile, "utf8")).toBe("do not overwrite");
    }
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

test("machine result requires explicit launch suppression and parser failures never create a record", async () => {
  await withRepository(async (primary, directory) => {
    const refs = await git(primary, "show-ref");
    for (const [index, args] of [["new", "blocked"], ["new", "blocked", "--no-editor"],
      ["new", "blocked", "--no-agent"], ["new", "blocked", "--editor", "--no-editor", "--no-agent"],
      ["new"], ["open", "blocked", "--unknown"]].entries()) {
      const output = join(directory, `invalid-${index}.json`);
      expect((await cli(primary, ...args, "--result-file", output)).exitCode).toBe(1);
      expect(await exists(output)).toBe(false);
    }
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

test("listing failure emits a failed envelope and stderr; first-use guidance cannot contaminate JSON", async () => {
  await withRepository(async (primary, directory) => {
    const isolated = await execa(process.execPath, [entry, "ls", "--json"], {
      cwd: primary, reject: false, env: { CI: "true", XDG_STATE_HOME: join(directory, "fresh state") },
    });
    expect(JSON.parse(isolated.stdout).outcome).toBe("succeeded");
    expect(await exists(join(directory, "fresh state"))).toBe(false);
    const outside = await cli(directory, "ls", "--json");
    expect(outside.exitCode).toBe(1);
    expect(JSON.parse(outside.stdout)).toMatchObject({ outcome: "failed", exitCode: 1, repository: null, worktrees: [] });
    expect(outside.stderr).toContain("Not a Git repository");
    await writeFile(join(primary, ".timber.toml"), "invalid = [");
    const invalid = await cli(primary, "ls", "--json");
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ outcome: "failed", repository: { commonGitDir: join(primary, ".git") } });
  });
});

test("unknown replaced worktree preserves registered path without adopting symlink destination", async () => {
  await withRepository(async (primary, directory) => {
    const stale = join(directory, "stale tree");
    const other = join(directory, "other directory");
    await git(primary, "worktree", "add", "-b", "stale", stale);
    await rm(stale, { recursive: true });
    await mkdir(other);
    await symlink(other, stale);
    const data = JSON.parse((await cli(primary, "ls", "--json")).stdout);
    expect(data.worktrees.find((tree: { path: string }) => tree.path === stale))
      .toMatchObject({ path: stale, canonicalPath: null, status: { kind: "unknown" } });
    const output = join(directory, "stale.json");
    const refs = await git(primary, "show-ref");
    expect((await cli(primary, "open", stale, ...flags(output))).exitCode).toBe(1);
    expect((await record(output)).outcome).toBe("failed");
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

test("result pathname replacement by a hook fails without overwriting the replacement or removing work", async () => {
  await withRepository(async (primary, directory) => {
    const output = join(directory, "replaced.json");
    await configure(primary, [`rm '${output}'; printf 'replacement' > '${output}'; touch retained`]);
    const result = await cli(primary, "new", "replace", ...flags(output));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Result file was removed or replaced");
    expect(await readFile(output, "utf8")).toBe("replacement");
    const target = join(directory, "primary repo-worktrees", "replace");
    expect(await exists(join(target, "retained"))).toBe(true);
    expect(await git(primary, "rev-parse", "refs/heads/replace")).toBe(await git(target, "rev-parse", "HEAD"));
  });
});

test("missing worktree open fails without recreation; locked existing open keeps its lock", async () => {
  await withRepository(async (primary, directory) => {
    const target = join(directory, "locked tree");
    await git(primary, "worktree", "add", "-b", "locked", target);
    await git(primary, "worktree", "lock", "--reason", "retain lock", target);
    const locked = join(directory, "locked.json");
    expect((await cli(primary, "open", target, ...flags(locked))).exitCode).toBe(0);
    expect(await record(locked)).toMatchObject({ materialized: false, worktree: { locked: { reason: "retain lock" } } });
    await rm(target, { recursive: true });
    const refs = await git(primary, "show-ref");
    const missing = join(directory, "missing.json");
    expect((await cli(primary, "open", target, ...flags(missing))).exitCode).toBe(1);
    expect((await record(missing)).outcome).toBe("failed");
    expect(await exists(target)).toBe(false);
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

test("modification of the reserved result file fails without publishing a corrupt record", async () => {
  await withRepository(async (primary, directory) => {
    const output = join(directory, "modified.json");
    await configure(primary, [`printf 'unexpected preexisting content' > '${output}'`]);
    const result = await cli(primary, "new", "modified-result", ...flags(output));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Result file was modified");
    expect(await readFile(output, "utf8")).toBe("unexpected preexisting content");
  });
});

test("linked nested and symlink invocation share canonical repository identity", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "linked space");
    const alias = join(directory, "repository alias");
    await git(primary, "worktree", "add", "-b", "linked", linked);
    await mkdir(join(linked, "nested"));
    await symlink(primary, alias);
    const inventories = await Promise.all([primary, alias, join(linked, "nested")]
      .map(async cwd => JSON.parse((await cli(cwd, "ls", "--json")).stdout)));
    for (const data of inventories) {
      expect(data.repository.commonGitDir).toBe(await realpath(join(primary, ".git")));
      expect(data.worktrees.map((tree: { path: string }) => tree.path).sort()).toEqual([linked, primary].sort());
      for (const tree of data.worktrees) expect(tree.canonicalPath).toBe(await realpath(tree.path));
    }
    expect(inventories[2].repository.currentWorktreeRoot).toBe(linked);
  });
});

test("existing open setup failure retains selected path with materialized false", async () => {
  await withRepository(async (primary, directory) => {
    const target = join(directory, "existing tree");
    await git(primary, "worktree", "add", "-b", "existing", target);
    await configure(primary, ['printf "retain me" > setup-file; exit 19']);
    const refs = await git(primary, "show-ref");
    const output = join(directory, "existing-failure.json");
    expect((await cli(primary, "open", target, "--setup", ...flags(output))).exitCode).toBe(1);
    expect(await record(output)).toMatchObject({ outcome: "failed", materialized: false, worktree: { path: target, branch: "existing" } });
    expect(await readFile(join(target, "setup-file"), "utf8")).toBe("retain me");
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

const savedBase = async (tree: string) => join(await git(tree, "rev-parse", "--absolute-git-dir"), "timber", "base.json");
const listed = (data: { worktrees: { path: string }[] }, path: string) =>
  data.worktrees.find(tree => tree.path === path);

test("listing reports saved canonical bases offline without changing files or refs", async () => {
  await withRepository(async (primary, directory) => {
    await configure(primary, [], "[workflows.review]\npost_create = []");
    const remote = join(directory, "remote.git");
    await git(directory, "init", "--bare", remote);
    await git(primary, "remote", "add", "origin", remote);
    await git(primary, "push", "origin", "trunk:main");
    const output = join(directory, "new.json");
    expect((await cli(primary, "new", "feature", "--base", "origin/main", "--workflow", "review", ...flags(output))).exitCode).toBe(0);
    const created = await record(output);
    const assigned = { kind: "assigned", ref: "refs/remotes/origin/main" };
    expect(created.worktree.base).toEqual(assigned);
    // A workflow applies to one invocation; it is neither saved nor reported.
    expect(created.worktree).not.toHaveProperty("workflow");
    const manual = join(directory, "manual tree");
    await git(primary, "worktree", "add", "-b", "manual", manual);
    // Neither the remote nor the saved ref has to exist for an offline listing.
    await rm(remote, { recursive: true });
    await git(primary, "update-ref", "-d", "refs/remotes/origin/main");
    const refs = await git(primary, "show-ref");
    const saved = await readFile(await savedBase(created.worktree.path), "utf8");
    const statuses = () => Promise.all([primary, manual, created.worktree.path]
      .map(tree => git(tree, "status", "--porcelain", "--ignored")));
    const before = await statuses();
    const result = await cli(primary, "ls", "--json");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const data = JSON.parse(result.stdout);
    expect(listed(data, created.worktree.path)).toMatchObject({ base: assigned });
    for (const tree of data.worktrees) expect(tree).not.toHaveProperty("workflow");
    expect(listed(data, manual)).toEqual(expect.objectContaining({ base: { kind: "unassigned" } }));
    expect(listed(data, primary)).toEqual(expect.objectContaining({ base: { kind: "unassigned" } }));
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await readFile(await savedBase(created.worktree.path), "utf8")).toBe(saved);
    expect(await statuses()).toEqual(before);
  });
});

test.each(["malformed", "stale", "unreadable"] as const)("listing keeps a row whose saved base is %s and reports the reason", async reason => {
  if (reason === "unreadable" && process.getuid?.() === 0) return; // root ignores file modes
  await withRepository(async (primary, directory) => {
    await configure(primary);
    expect((await cli(primary, "new", "feature", "--base", "trunk", "--no-editor", "--no-agent")).exitCode).toBe(0);
    const target = join(directory, "primary repo-worktrees", "feature");
    const file = await savedBase(target);
    if (reason === "malformed") await writeFile(file, "not JSON");
    if (reason === "stale") await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), worktreePath: primary }));
    if (reason === "unreadable") await chmod(file, 0o000);
    const refs = await git(primary, "show-ref");
    const result = await cli(primary, "ls", "--json");
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.worktrees).toHaveLength(2);
    expect(listed(data, target)).toMatchObject({ branch: "feature", status: { kind: "known" },
      base: { kind: "invalid", reason } });
    expect(result.stderr).toBe(`warning: Cannot read base association for ${target} (${reason}); Git worktree remains listed.`);
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

test("new, open and done records carry the saved base of their worktree", async () => {
  await withRepository(async (primary, directory) => {
    await configure(primary);
    const created = join(directory, "created.json");
    expect((await cli(primary, "new", "feature", "--base", "trunk", ...flags(created))).exitCode).toBe(0);
    const target = (await record(created)).worktree.path;
    const saved = { kind: "assigned", ref: "refs/heads/trunk" };
    expect((await record(created)).worktree.base).toEqual(saved);

    const reopened = join(directory, "reopened.json");
    expect((await cli(primary, "open", target, ...flags(reopened))).exitCode).toBe(0);
    expect(await record(reopened)).toMatchObject({ materialized: false, worktree: { path: target, base: saved } });

    await git(primary, "branch", "local");
    const opened = join(directory, "opened.json");
    expect((await cli(primary, "open", "local", ...flags(opened))).exitCode).toBe(0);
    expect(await record(opened)).toMatchObject({ materialized: true, worktree: { branch: "local" } });
    expect((await record(opened)).worktree.base).toEqual({ kind: "unassigned" });

    const preview = await cli(primary, "__ide-done", "preview", "--", target);
    expect(preview.exitCode).toBe(0);
    const approval = join(directory, "approval.json");
    await writeFile(approval, preview.stdout);
    const removed = join(directory, "removed.json");
    const applied = await cli(primary, "__ide-done", "apply", "--approval-file", approval, "--result-file", removed, "--", target);
    expect(applied.stderr).toBe("");
    expect(applied.exitCode).toBe(0);
    expect(await record(removed)).toMatchObject({ command: "done", outcome: "succeeded", worktree: { path: target, base: saved } });
    expect(await exists(target)).toBe(false);
  });
});
