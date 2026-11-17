import { expect, test } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { withArena, type ArenaFixture } from "./helpers/arena";
import { git } from "./helpers/git";
import { createArenaPickHandler } from "../src/commands/arena-pick";
import { readArena, readArenaPick, openArenaForPick, validateArenaAttempt } from "../src/arena/storage";
import { summarizeArenaAttempt, inspectArenaRemoval } from "../src/arena/summary";
import { archiveArenaAttempt } from "../src/arena/archive";
import { discoverRepository } from "../src/git/repository";
import { cleanupWorktree } from "../src/git/cleanup";
import type { CommandContext } from "../src/services";
import type { ArenaPickServices } from "../src/arena/services";

function harness(f: ArenaFixture, overrides: Partial<ArenaPickServices> = {}) {
  let stdout = "", stderr = "";
  const context: CommandContext = { cwd: f.primary,
    io: { stdout(s) { stdout += s; }, stderr(s) { stderr += s; } } };
  const services: ArenaPickServices = { discoverRepository, loadConfig: async () => ({ ...f.config, baseBranch: "trunk" }),
    readArena, readArenaPick, openArenaForPick, validateArenaAttempt, summarizeArenaAttempt, inspectArenaRemoval,
    archiveArenaAttempt, cleanupWorktree, ...overrides };
  return { run: createArenaPickHandler(services), context, output: () => stdout + stderr };
}

const commit = (cwd: string) => git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "attempt work");

test("pick keeps winner bytes, removes loser, deletes branch and safely repeats", async () => {
  await withArena(async f => {
    const [winner, loser] = f.manifest.attempts;
    await writeFile(join(winner!.path, "tracked.txt"), "winning edit\n");
    const manifest = await readFile(f.manifestPath), task = await readFile(f.taskPath);
    const h = harness(f);
    expect(await h.run("demo", { winner: winner!.label }, h.context)).toBe(0);
    expect(await readFile(join(winner!.path, "tracked.txt"), "utf8")).toBe("winning edit\n");
    expect(existsSync(loser!.path)).toBe(false);
    expect((await inspectArenaRemoval(f.repository, loser!)).branch).toBe("absent");
    expect(await readFile(f.manifestPath)).toEqual(manifest); expect(await readFile(f.taskPath)).toEqual(task);
    expect((await readArenaPick(f.repository, "demo", f.manifest))?.winnerId).toBe(winner!.id);
    expect(h.output()).toContain("no unique work");
    expect(await h.run("demo", { winner: winner!.label }, h.context)).toBe(0);
    expect(h.output()).toContain("removed");
  });
});

for (const mode of ["committed", "modified", "untracked", "everything"] as const)
test(`pick archives ${mode} loser work restorably before removal`, async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[1]!;
    if (mode === "committed" || mode === "everything") {
      await writeFile(join(a.path, "tracked.txt"), "committed\n"); await git(a.path, "add", "."); await commit(a.path);
    }
    if (mode === "modified" || mode === "everything") await writeFile(join(a.path, "tracked.txt"), "modified\n");
    if (mode === "untracked" || mode === "everything") await writeFile(join(a.path, "new.txt"), "untracked\n");
    await writeFile(join(a.path, ".env"), "secret\n");
    const h = harness(f);
    expect(await h.run("demo", { winner: f.manifest.attempts[0]!.label }, h.context)).toBe(0);
    expect(existsSync(a.path)).toBe(false);
    const archive = (await readArenaPick(f.repository, "demo", f.manifest))!.archives[0]!;
    expect(archive.ref).toBe(`refs/timber/arena/demo/${a.label}`);
    expect(await git(f.primary, "rev-parse", archive.ref)).toBe(archive.commit);
    const show = (path: string) => git(f.primary, "show", `${archive.ref}:${path}`);
    if (mode !== "untracked") expect(await show("tracked.txt")).toBe(mode === "committed" ? "committed" : "modified");
    if (mode === "untracked" || mode === "everything") expect(await show("new.txt")).toBe("untracked");
    await expect(show(".env")).rejects.toThrow();
    // Printed restore recipe works.
    const restored = join(f.directory, "restored");
    await git(f.primary, "worktree", "add", "-b", "restored", restored, archive.ref);
    expect(existsSync(join(restored, "tracked.txt"))).toBe(true);
    expect(h.output()).toContain("git worktree add");
  });
});

for (const mode of ["ignored", "active", "stale", "primary"] as const)
test(`pick keeps protected ${mode} loser with files and refs intact`, async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[1]!;
    await writeFile(join(a.path, "tracked.txt"), "keep modified\n");
    if (mode === "ignored") await writeFile(join(a.path, ".env"), "keep ignored\n");
    if (mode === "active") a.stage = "launch-running";
    if (mode === "stale") {
      await git(f.primary, "worktree", "remove", "--force", a.path);
      await git(f.primary, "worktree", "add", a.path, a.branch);
      await writeFile(join(a.path, "tracked.txt"), "keep modified\n");
    }
    if (mode === "primary") { a.path = f.primary; a.worktreeGitDir = f.repository.commonGitDir; }
    if (mode === "active" || mode === "primary") await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    const refs = await git(f.primary, "show-ref"), status = await git(a.path, "status", "--porcelain=v1", "--ignored");
    const bytes = await readFile(join(a.path, "tracked.txt"));
    const h = harness(f);
    expect(await h.run("demo", { winner: f.manifest.attempts[0]!.label, keepIgnored: true }, h.context)).toBe(1);
    expect(existsSync(a.path)).toBe(true);
    expect(await git(f.primary, "show-ref")).toBe(refs);
    expect(await git(a.path, "status", "--porcelain=v1", "--ignored")).toBe(status);
    expect(await readFile(join(a.path, "tracked.txt"))).toEqual(bytes);
    expect(h.output()).toContain(`Kept ${a.label}`);
    expect(h.output()).toContain("rerun");
  });
});

test("keep-branch retains loser ref and ignored files are deleted by default", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[1]!;
    await writeFile(join(a.path, ".env"), "ignored\n");
    const head = await git(a.path, "rev-parse", "HEAD");
    const h = harness(f);
    expect(await h.run("demo", { winner: f.manifest.attempts[0]!.label, keepBranch: true }, h.context)).toBe(0);
    expect(existsSync(a.path)).toBe(false);
    expect(await git(f.primary, "rev-parse", `refs/heads/${a.branch}`)).toBe(head);
  });
});

for (const cancelAt of [1, 2]) test(`pick cancellation at chooser ${cancelAt} changes no records, files or refs`, async () => {
  await withArena(async f => {
    const h = harness(f), before = await readFile(f.manifestPath), refs = await git(f.primary, "show-ref");
    let calls = 0;
    h.context.interactive = true;
    h.context.choose = async (_message, choices) => ++calls === cancelAt ? null : choices[0]!.value;
    expect(await h.run("demo", {}, h.context)).toBe(0);
    expect(await readFile(f.manifestPath)).toEqual(before); expect(await git(f.primary, "show-ref")).toBe(refs);
    expect(existsSync(join(dirname(f.manifestPath), "pick.json"))).toBe(false);
    expect(existsSync(f.lockPath)).toBe(false);
    for (const a of f.manifest.attempts) expect(existsSync(a.path)).toBe(true);
  });
});

test("confirmation defaults to cancel when the default choice is taken", async () => {
  await withArena(async f => {
    const h = harness(f);
    h.context.interactive = true;
    h.context.choose = async (_m, choices) => (choices.find(c => c.default) ?? choices[0]!).value;
    expect(await h.run("demo", {}, h.context)).toBe(0);
    for (const a of f.manifest.attempts) expect(existsSync(a.path)).toBe(true);
  });
});

test("inspect is read-only and unattended pick requires exact winner", async () => {
  await withArena(async f => {
    const h = harness(f);
    const refs = await git(f.primary, "show-ref");
    expect(await h.run("demo", { inspect: true }, h.context)).toBe(0);
    expect(h.output()).toContain("git -C"); expect(h.output()).toContain("timber open");
    expect(h.output()).toContain("no changes");
    expect(h.output()).not.toContain("PRIVATE_TASK_SENTINEL");
    await expect(h.run("demo", {}, h.context)).rejects.toThrow("--winner");
    await expect(h.run("demo", { winner: "manual" }, h.context)).rejects.toThrow("No attempt named");
    expect(existsSync(join(dirname(f.manifestPath), "pick.json"))).toBe(false);
    expect(await git(f.primary, "show-ref")).toBe(refs);
  });
});

test("partial cleanup keeps blocked loser and repeat removes it once unblocked", async () => {
  await withArena(async f => {
    const [winner, blocked, eligible] = f.manifest.attempts;
    await writeFile(join(blocked!.path, ".env"), "keep\n");
    const h = harness(f);
    expect(await h.run("demo", { winner: winner!.label, keepIgnored: true }, h.context)).toBe(1);
    expect(existsSync(blocked!.path)).toBe(true); expect(existsSync(eligible!.path)).toBe(false);
    const { unlink } = await import("node:fs/promises"); await unlink(join(blocked!.path, ".env"));
    expect(await h.run("demo", { winner: winner!.label, keepIgnored: true }, h.context)).toBe(0);
    expect(existsSync(winner!.path)).toBe(true); expect(existsSync(blocked!.path)).toBe(false);
  }, undefined, [{ kind: "harness", harness: "manual", model: null, count: 3 }]);
});

test("files changed after archiving block removal", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[1]!;
    await writeFile(join(a.path, "tracked.txt"), "first\n");
    const h = harness(f, { archiveArenaAttempt: async (...args) => {
      const archive = await archiveArenaAttempt(...args);
      await writeFile(join(a.path, "tracked.txt"), "edited after archive\n");
      return archive;
    } });
    expect(await h.run("demo", { winner: f.manifest.attempts[0]!.label }, h.context)).toBe(1);
    expect(await readFile(join(a.path, "tracked.txt"), "utf8")).toBe("edited after archive\n");
    expect(h.output()).toContain(`Kept ${a.label}`);
  });
});

test("archive failure keeps loser intact", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[1]!;
    await writeFile(join(a.path, "tracked.txt"), "work\n");
    const refs = await git(f.primary, "show-ref");
    const h = harness(f, { archiveArenaAttempt: async () => { throw new Error("archive exploded"); } });
    expect(await h.run("demo", { winner: f.manifest.attempts[0]!.label }, h.context)).toBe(1);
    expect(await readFile(join(a.path, "tracked.txt"), "utf8")).toBe("work\n");
    expect(await git(f.primary, "show-ref")).toBe(refs);
    expect(h.output()).toContain("archive exploded");
  });
});

test("winner can change later; previous winner is archived like any loser", async () => {
  await withArena(async f => {
    const [first, second] = f.manifest.attempts;
    await writeFile(join(first!.path, "tracked.txt"), "first winner\n");
    await writeFile(join(second!.path, ".env"), "kept by --keep-ignored\n");
    const h = harness(f);
    expect(await h.run("demo", { winner: first!.label, keepIgnored: true }, h.context)).toBe(1);
    expect(existsSync(second!.path)).toBe(true);
    expect(await h.run("demo", { winner: second!.label }, h.context)).toBe(0);
    expect(h.output()).toContain(`Changing the recorded winner from ${first!.label}`);
    expect(existsSync(first!.path)).toBe(false);
    const pick = (await readArenaPick(f.repository, "demo", f.manifest))!;
    expect(pick.winnerId).toBe(second!.id);
    expect(await git(f.primary, "show", `${pick.archives[0]!.ref}:tracked.txt`)).toBe("first winner");
    await expect(h.run("demo", { winner: first!.label }, h.context)).rejects.toThrow();
  });
});

test("hook replacing arena marker blocks cleanup at final membership boundary", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[1]!;
    const marker = join(a.worktreeGitDir!, "timber/arena.json");
    // Hook path supplied literally as trusted configuration, never interpolated into product Git commands.
    const script = join(f.directory, "change-marker.sh");
    await writeFile(script, `#!/bin/sh\nprintf '{}' > '${marker.replaceAll("'", "'\\''")}'\n`); await chmod(script, 0o700);
    const h = harness(f, { loadConfig: async () => ({ ...f.config, baseBranch: "trunk",
      hooks: { postCreate: [], preDelete: [`'${script.replaceAll("'", "'\\''")}'`] } }) });
    const refs = await git(f.primary, "show-ref");
    expect(await h.run("demo", { winner: f.manifest.attempts[0]!.label }, h.context)).toBe(1);
    expect(existsSync(a.path)).toBe(true); expect(await git(f.primary, "show-ref")).toBe(refs);
  });
});

test("repeat never touches a recreated loser branch", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[1]!;
    const h = harness(f);
    const options = { winner: f.manifest.attempts[0]!.label };
    expect(await h.run("demo", options, h.context)).toBe(0);
    await git(f.primary, "branch", a.branch, "trunk");
    const refs = await git(f.primary, "show-ref");
    expect(await h.run("demo", options, h.context)).toBe(0);
    expect(await git(f.primary, "show-ref")).toBe(refs);
  });
});

test("branch deletion failure reports partial removal and exits nonzero", async () => {
  await withArena(async f => {
    const a = f.manifest.attempts[1]!;
    const h = harness(f, { cleanupWorktree: async (repo, tree, config, options, io, confirm, approval, policy) =>
      cleanupWorktree(repo, tree, config, options, io, confirm, approval, { ...policy,
        beforeDeleteBranch: async () => { throw new Error("branch boundary changed"); } }) });
    expect(await h.run("demo", { winner: f.manifest.attempts[0]!.label }, h.context)).toBe(1);
    expect(existsSync(a.path)).toBe(false);
    expect(h.output()).toContain(`Partly removed ${a.label}`);
    expect((await inspectArenaRemoval(f.repository, a)).branch).toBe("present");
  });
});
