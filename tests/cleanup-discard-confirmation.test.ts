import { expect, test } from "bun:test";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupWorktree, inspectCleanup } from "../src/git/cleanup";
import { git, withRepository } from "./helpers/git";
import { addModule, config, dirty, fixture, options, quiet, retained } from "./helpers/cleanup-discard";

for (const pruned of [false, true]) test(`confirmed missing upstream discards local commits and files (pruned=${pruned})`, async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory);
    await dirty(f.path);
    await git(f.bare, "update-ref", "-d", `refs/heads/${f.branch}`);
    if (pruned) await git(primary, "fetch", "--prune", "origin");
    const inspection = await inspectCleanup(f.repository, f.tree, config);
    expect(inspection.publication).toMatchObject({ kind: "upstream-deleted", upstreamRef: `refs/remotes/origin/${f.branch}` });
    let output = "";
    const result = await cleanupWorktree(f.repository, f.tree, config, options, { ...quiet, stdout: text => { output += text; } });
    expect(result.deletedLocalBranch).toBe(f.branch);
    expect(output).toContain("upstream branch no longer exists");
    expect(await lstat(f.path).then(() => true, () => false)).toBe(false);
    expect(await git(primary, "for-each-ref", "--format=%(refname)", `refs/heads/${f.branch}`)).toBe("");
    expect(await git(f.bare, "for-each-ref", "--format=%(refname)")).toBe("");
  });
});

test("explicit confirmation discards divergent commits and files (upstream=true)", async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory, true);
    await dirty(f.path);
    let prompts = 0;
    const result = await cleanupWorktree(f.repository, f.tree, config, options, quiet, async reason => {
      prompts++;
      expect(reason).toContain("modified");
      return true;
    });
    expect(prompts).toBe(1);
    expect(result.deletedLocalBranch).toBe(f.branch);
    expect(await lstat(f.path).then(() => true, () => false)).toBe(false);
    expect(await git(f.bare, "rev-parse", `refs/heads/${f.branch}`)).not.toBe(f.head);
  });
});

test("declining discard retains files, commits, refs and registration", async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory);
    await dirty(f.path);
    const refs = await git(primary, "show-ref");
    let prompted = false;
    await expect(cleanupWorktree(f.repository, f.tree, config, options, quiet, async () => { prompted = true; return false; }))
      .rejects.toThrow("Cancelled");
    expect(prompted).toBe(true);
    await retained(primary, f.path, f.head);
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

test("unreachable remote never counts as deleted and noninteractive cleanup refuses", async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory);
    await dirty(f.path);
    await git(primary, "remote", "set-url", "origin", join(directory, "unreachable.git"));
    expect((await inspectCleanup(f.repository, f.tree, config)).publication.kind).toBe("unknown");
    await expect(cleanupWorktree(f.repository, f.tree, config, options, quiet)).rejects.toThrow("modified");
    await retained(primary, f.path, f.head);
  });
});

for (const change of ["tracked", "untracked", "staged", "head"] as const) test(`changes to ${change} during confirmation invalidate approval`, async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory);
    await dirty(f.path);
    await expect(cleanupWorktree(f.repository, f.tree, config, options, quiet, async () => {
      if (change === "tracked") await writeFile(join(f.path, "tracked.txt"), "new edit\n");
      if (change === "untracked") await writeFile(join(f.path, "scratch.txt"), "new scratch\n");
      if (change === "staged") await git(f.path, "add", "tracked.txt");
      if (change === "head") await git(f.path, "reset", "--soft", "HEAD^");
      return true;
    })).rejects.toThrow(/changed/i);
    expect(await lstat(f.path).then(() => true, () => false)).toBe(true);
    expect(await git(primary, "worktree", "list", "--porcelain")).toContain(f.path);
    expect(await readFile(join(f.path, "scratch.txt"), "utf8")).toBe(change === "untracked" ? "new scratch\n" : "untracked\n");
  });
});

for (const mode of ["confirmation", "deleted"] as const) test(`keep-branch and keep-ignored apply to ${mode} cleanup`, async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory);
    await dirty(f.path);
    await writeFile(join(f.path, ".env"), "private fixture\n");
    if (mode === "deleted") await git(f.bare, "update-ref", "-d", `refs/heads/${f.branch}`);
    await expect(cleanupWorktree(f.repository, f.tree, config, { ...options, discardIgnored: false }, quiet,
      async () => { throw new Error("must not prompt for keep-ignored"); })).rejects.toThrow("--keep-ignored");
    await retained(primary, f.path, f.head);
    const result = await cleanupWorktree(f.repository, f.tree, config, { ...options, keepBranch: true }, quiet, async () => true);
    expect(result.retainedLocalBranch).toBe(f.branch);
    expect(await git(primary, "rev-parse", f.branch)).toBe(f.head);
  });
});

test("pre-delete hook changing dirty file content stops confirmed removal", async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory);
    await dirty(f.path);
    await expect(cleanupWorktree(f.repository, f.tree, { ...config, hooks: { postCreate: [], preDelete: ["printf 'hook edit' > tracked.txt"] } },
      options, quiet, async () => true)).rejects.toThrow(/changed/i);
    expect(await readFile(join(f.path, "tracked.txt"), "utf8")).toBe("hook edit");
    expect(await git(primary, "rev-parse", f.branch)).toBe(f.head);
  });
});

test("recreated upstream during hooks stops automatic discard", async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory);
    await git(f.bare, "update-ref", "-d", `refs/heads/${f.branch}`);
    await dirty(f.path);
    await expect(cleanupWorktree(f.repository, f.tree, { ...config,
      hooks: { postCreate: [], preDelete: ["git push origin HEAD"] } }, options, quiet)).rejects.toThrow(/upstream.*changed/i);
    await retained(primary, f.path, f.head);
  });
});

for (const remote of [true, false]) test(`clean unpublished commits require explicit confirmation (upstream=${remote})`, async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory, remote);
    let reason = "";
    const result = await cleanupWorktree(f.repository, f.tree, config, options, quiet, async message => { reason = message; return true; });
    expect(reason).toMatch(/unpublished|Cannot verify/);
    expect(reason).toContain(f.head);
    expect(result.deletedLocalBranch).toBe(f.branch);
    expect(await lstat(f.path).then(() => true, () => false)).toBe(false);
  });
});

for (const blocked of ["operation", "base"] as const) test(`discard never prompts for hard failure: ${blocked}`, async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory);
    await dirty(f.path);
    if (blocked === "operation") await writeFile(join(await git(f.path, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"), f.head + "\n");
    let prompts = 0;
    await expect(cleanupWorktree(f.repository, f.tree, config, { ...options, ...(blocked === "base" ? { base: "missing-base" } : {}) }, quiet,
      async () => { prompts++; return true; })).rejects.toThrow();
    expect(prompts).toBe(0);
    await retained(primary, f.path, f.head);
  });
});

test("submodule index changes during confirmation invalidate discard even when files stay identical", async () => {
  await withRepository(async (primary, directory) => {
    await addModule(primary, directory);
    const f = await fixture(primary, directory);
    await git(f.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
    const module = join(f.path, "module");
    await writeFile(join(module, "module.txt"), "dirty module\n");
    let staged = "";
    await expect(cleanupWorktree(f.repository, f.tree, config, options, quiet, async () => {
      const blob = join(directory, "new staged blob");
      await writeFile(blob, "new index-only content\n");
      staged = await git(module, "hash-object", "-w", blob);
      await git(module, "update-index", "--cacheinfo", `100644,${staged},module.txt`);
      return true;
    })).rejects.toThrow(/changed/i);
    expect(await git(module, "show", ":module.txt")).toBe("new index-only content");
    expect(await readFile(join(module, "module.txt"), "utf8")).toBe("dirty module\n");
    expect(await git(primary, "rev-parse", f.branch)).toBe(f.head);
  });
});

test("index flag --skip-worktree changed during confirmation still invalidates discard", async () => {
  const flag = "--skip-worktree";
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory);
    await dirty(f.path);
    const refs = await git(primary, "show-ref");
    await expect(cleanupWorktree(f.repository, f.tree, config, options, quiet, async () => {
      await git(f.path, "update-index", flag, "local.txt");
      return true;
    })).rejects.toThrow(/changed/i);
    await retained(primary, f.path, f.head);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(f.path, "ls-files", "-v", "--", "local.txt")).toBe("S local.txt");
  });
});
