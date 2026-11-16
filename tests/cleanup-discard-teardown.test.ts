import { expect, test } from "bun:test";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupWorktree } from "../src/git/cleanup";
import { git, withRepository } from "./helpers/git";
import { addModule, config, dirty, fixture, options, quiet, retained } from "./helpers/cleanup-discard";

test("keep-ignored protects ignored files in initialized submodules (confirmation)", async () => {
  await withRepository(async (primary, directory) => {
    await addModule(primary, directory);
    const f = await fixture(primary, directory);
    await git(f.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
    await dirty(f.path);
    const ignored = join(f.path, "module", ".env");
    await writeFile(ignored, "private module fixture\n");
    let prompts = 0;
    await expect(cleanupWorktree(f.repository, f.tree, config, { ...options, discardIgnored: false }, quiet,
      async () => { prompts++; return true; })).rejects.toThrow("--keep-ignored");
    expect(prompts).toBe(0);
    expect(await readFile(ignored, "utf8")).toBe("private module fixture\n");
    await retained(primary, f.path, f.head);
  });
});

test("confirmed discard removes populated submodules and their ignored files by default", async () => {
  await withRepository(async (primary, directory) => {
    await addModule(primary, directory);
    const f = await fixture(primary, directory);
    await git(f.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
    await dirty(f.path);
    await writeFile(join(f.path, "module", ".env"), "disposable ignored fixture\n");
    await writeFile(join(f.path, "module", "module.txt"), "dirty module\n");
    const result = await cleanupWorktree(f.repository, f.tree, config, options, quiet, async () => true);
    expect(result.deletedLocalBranch).toBe(f.branch);
    expect(await lstat(f.path).then(() => true, () => false)).toBe(false);
  });
});

test("Git index stat refresh during teardown permits confirmation cleanup on the first try", async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory);
    await dirty(f.path);
    const result = await cleanupWorktree(f.repository, f.tree, { ...config,
      hooks: { postCreate: [], preDelete: ["touch -m -d '2000-01-01 00:00:00Z' local.txt; GIT_OPTIONAL_LOCKS=1 git status --porcelain > /dev/null"] },
    }, options, quiet, async () => true);
    expect(result.deletedLocalBranch).toBe(f.branch);
    expect(await lstat(f.path).then(() => true, () => false)).toBe(false);
  });
});

test("submodule index stat refresh during teardown permits confirmation cleanup on the first try", async () => {
  await withRepository(async (primary, directory) => {
    await addModule(primary, directory);
    const f = await fixture(primary, directory);
    await git(f.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
    await dirty(f.path);
    const result = await cleanupWorktree(f.repository, f.tree, { ...config,
      hooks: { postCreate: [], preDelete: ["touch -m -d '2000-01-01 00:00:00Z' module/module.txt; GIT_OPTIONAL_LOCKS=1 git -C module status --porcelain > /dev/null"] },
    }, options, quiet, async () => true);
    expect(result.deletedLocalBranch).toBe(f.branch);
    expect(await lstat(f.path).then(() => true, () => false)).toBe(false);
  });
});

for (const change of ["create", "remove"] as const) test(`ignored runtime file ${change} during hooks permits confirmation cleanup on the first try`, async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory);
    await dirty(f.path);
    if (change === "remove") await writeFile(join(f.path, ".env"), "disposable runtime state\n");
    let prompts = 0;
    const result = await cleanupWorktree(f.repository, f.tree, { ...config,
      hooks: { postCreate: [], preDelete: [change === "create" ? "printf 'runtime state' > .env" : "rm .env"] },
    }, options, quiet, async () => { prompts++; return true; });
    expect(prompts).toBe(1);
    expect(result.deletedLocalBranch).toBe(f.branch);
    expect(await lstat(f.path).then(() => true, () => false)).toBe(false);
  });
});

test("ignored files changed inside a populated submodule do not invalidate discard", async () => {
  await withRepository(async (primary, directory) => {
    await addModule(primary, directory);
    const f = await fixture(primary, directory);
    await git(f.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
    await writeFile(join(f.path, "module", "module.txt"), "dirty module\n");
    const result = await cleanupWorktree(f.repository, f.tree, { ...config,
      hooks: { postCreate: [], preDelete: ["printf 'runtime state' > module/.env"] },
    }, options, quiet, async () => true);
    expect(result.deletedLocalBranch).toBe(f.branch);
    expect(await lstat(f.path).then(() => true, () => false)).toBe(false);
  });
});

test("ignored files created by a hook remain protected by keep-ignored", async () => {
  await withRepository(async (primary, directory) => {
    const f = await fixture(primary, directory);
    await dirty(f.path);
    await expect(cleanupWorktree(f.repository, f.tree, { ...config,
      hooks: { postCreate: [], preDelete: ["printf 'runtime state' > .env"] },
    }, { ...options, discardIgnored: false }, quiet, async () => true)).rejects.toThrow("--keep-ignored");
    await retained(primary, f.path, f.head);
    expect(await readFile(join(f.path, ".env"), "utf8")).toBe("runtime state");
  });
});

test("untracked submodule file edits during hooks still invalidate discard", async () => {
  await withRepository(async (primary, directory) => {
    await addModule(primary, directory);
    const f = await fixture(primary, directory);
    await git(f.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
    const scratch = join(f.path, "module", "scratch.txt");
    await writeFile(scratch, "initial submodule scratch\n");
    await expect(cleanupWorktree(f.repository, f.tree, { ...config,
      hooks: { postCreate: [], preDelete: ["printf 'new scratch' > module/scratch.txt"] },
    }, options, quiet, async () => true)).rejects.toThrow(/changed/i);
    expect(await readFile(scratch, "utf8")).toBe("new scratch");
    expect(await git(primary, "rev-parse", f.branch)).toBe(f.head);
    expect(await git(primary, "worktree", "list", "--porcelain")).toContain(f.path);
  });
});

test("ignored files created in submodules by hooks remain protected by keep-ignored", async () => {
  await withRepository(async (primary, directory) => {
    await addModule(primary, directory);
    const f = await fixture(primary, directory);
    await git(f.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
    await expect(cleanupWorktree(f.repository, f.tree, { ...config,
      hooks: { postCreate: [], preDelete: ["printf 'runtime state' > module/.env"] },
    }, { ...options, discardIgnored: false }, quiet, async () => true)).rejects.toThrow("--keep-ignored");
    expect(await readFile(join(f.path, "module", ".env"), "utf8")).toBe("runtime state");
    expect(await git(primary, "rev-parse", f.branch)).toBe(f.head);
    expect(await git(primary, "worktree", "list", "--porcelain")).toContain(f.path);
  });
});
