import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { discoverRepository } from "../src/git/repository";
import { inspectWorktree, listWorktreeInventory } from "../src/git/worktrees";
import { git, withRepository } from "./helpers/git";
import { expectColumnPositions } from "./helpers/columns";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string) => execa(process.execPath, [entry, "ls"], {
  cwd, reject: false, timeout: 30_000, env: { CI: "true" },
});

test("timber ls works offline from nested and linked paths and preserves real Git state", async () => {
  await withRepository(async (primary, directory) => {
    const unicode = "界e\u0301🇺🇸1️⃣";
    const linked = join(directory, "primary repo-worktrees", `feature ${unicode}`);
    const detached = join(directory, "manual\tdetached");
    const stale = join(directory, "stale");
    const branch = `feature/list-${unicode}`;
    await git(primary, "worktree", "add", "-b", branch, linked);
    await git(primary, "worktree", "add", "--detach", detached);
    await git(primary, "worktree", "add", "-b", "stale", stale);
    await git(primary, "remote", "add", "upstream", join(directory, "unreachable.git"));
    await rm(stale, { recursive: true });
    await writeFile(join(linked, "tracked.txt"), "staged fixture\n");
    await git(linked, "add", "tracked.txt");
    await writeFile(join(linked, "tracked.txt"), "unstaged fixture\n");
    await writeFile(join(linked, "untracked.txt"), "preserve\n");
    await writeFile(join(linked, ".env"), "ignored fixture\n");
    // A minimal valid config enables no optional tools.
    await writeFile(join(primary, ".timber.toml"), "# Optional features off\n");
    const nested = join(primary, "nested");
    const linkedNested = join(linked, "nested");
    await mkdir(nested);
    await mkdir(linkedNested);
    const refs = await git(primary, "show-ref");
    const inventory = await git(primary, "worktree", "list", "--porcelain", "-z");
    const indexPath = (await git(linked, "rev-parse", "--absolute-git-dir")) + "/index";
    const index = await readFile(indexPath);

    const fromPrimary = await cli(nested);
    const fromLinked = await cli(linkedNested);
    expect(fromPrimary.exitCode).toBe(0);
    expect(fromLinked.exitCode).toBe(0);
    expect(fromPrimary.stderr).toContain("warning: Cannot read base association");
    expect(fromLinked.stderr).toBe(fromPrimary.stderr);
    expect(fromPrimary.stdout).toBe(fromLinked.stdout);
    const linkedRows = [
      { path: linked, cells: ["linked", branch, "-", "dirty (1 modified, 1 untracked)", linked] },
      { path: detached, cells: ["linked", "(detached HEAD)", "-", "clean", JSON.stringify(detached)] },
      { path: stale, cells: ["linked", "stale", "?", "unknown (Worktree path is missing); missing; prunable", stale] },
    ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const cells = [
      ["WORKTREE", "BRANCH", "BASE", "STATUS", "PATH"],
      ["primary", "trunk", "-", "dirty (0 modified, 1 untracked)", primary],
      ...linkedRows.map(row => row.cells),
    ];
    // Known fixture text has seven display cells but ten UTF-16 code units.
    const widths = cells.map(row => row.map(cell => cell.includes(unicode) ? cell.length - unicode.length + 7 : cell.length));
    expectColumnPositions(fromPrimary.stdout + "\n", cells, widths);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(inventory);
    expect(await readFile(indexPath)).toEqual(index);
    expect(await readFile(join(linked, "tracked.txt"), "utf8")).toBe("unstaged fixture\n");
    expect(await readFile(join(linked, "untracked.txt"), "utf8")).toBe("preserve\n");
    expect(await readFile(join(linked, ".env"), "utf8")).toBe("ignored fixture\n");
  });
});

test("timber ls outside a repository fails once without changing files", async () => {
  await withRepository(async (_primary, directory) => {
    const outside = join(directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "keep\n");
    const result = await cli(outside);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^error: Not a Git repository:/);
    expect(result.stderr.split("\n")).toHaveLength(1);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  });
});

const json = (cwd: string) => execa(process.execPath, [entry, "ls", "--json"], {
  cwd, reject: false, timeout: 30_000, env: { CI: "true" },
});

test("timber ls --json skips a large ignored folder, keeps file state, and writes nothing with stale file times", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "linked");
    await git(primary, "worktree", "add", "-b", "feature/large", linked);
    await writeFile(join(linked, ".gitignore"), ".env\nnode_modules/\n");
    await writeFile(join(linked, "tracked.txt"), "staged\n");
    await git(linked, "add", ".gitignore", "tracked.txt");
    await writeFile(join(linked, "tracked.txt"), "staged and unstaged\n");
    await writeFile(join(linked, "untracked.txt"), "keep\n");
    await mkdir(join(linked, "new folder"));
    await writeFile(join(linked, "new folder", "file.txt"), "keep\n");
    for (let folder = 0; folder < 100; folder++) {
      const path = join(linked, "node_modules", `package-${folder}`, "lib");
      await mkdir(path, { recursive: true });
      await Promise.all(Array.from({ length: 100 }, (_, file) => writeFile(join(path, `file-${file}.js`), "ignored\n")));
    }
    // Stale times on unchanged tracked files would make an ordinary status rewrite the index.
    const later = new Date(Date.now() + 60_000);
    for (const tree of [primary, linked]) await utimes(join(tree, "old name.txt"), later, later);
    const admin = async (tree: string) => git(tree, "rev-parse", "--absolute-git-dir");
    const indexes = await Promise.all([primary, linked].map(async tree => join(await admin(tree), "index")));
    const indexBefore = await Promise.all(indexes.map(index => readFile(index)));
    const adminBefore = await Promise.all([primary, linked].map(async tree => (await readdir(await admin(tree))).sort()));
    const refs = await git(primary, "show-ref");

    const result = await json(primary);
    expect(result.exitCode).toBe(0);
    const record = JSON.parse(result.stdout) as { worktrees: { path: string; status: unknown }[] };
    expect(record.worktrees.find(tree => tree.path === primary)?.status)
      .toEqual({ kind: "known", modified: [], untracked: [], ignored: [] });
    const status = record.worktrees.find(tree => tree.path === linked)?.status as
      { kind: string; modified: string[]; untracked: string[]; ignored: string[] };
    expect(status.kind).toBe("known");
    expect([...status.modified].sort()).toEqual([".gitignore", "tracked.txt"]);
    expect([...status.untracked].sort()).toEqual(["new folder/file.txt", "untracked.txt"]);
    expect(status.ignored).toEqual([]);
    expect(result.stdout).not.toContain("node_modules");

    expect(await Promise.all(indexes.map(index => readFile(index)))).toEqual(indexBefore);
    expect(await Promise.all([primary, linked].map(async tree => (await readdir(await admin(tree))).sort()))).toEqual(adminBefore);
    expect(await git(primary, "show-ref")).toBe(refs);

    // Cleanup and rebase inspect the same worktree with ignored files, as their safety checks need.
    const repository = await discoverRepository(primary);
    const inventory = (await listWorktreeInventory(repository)).find(tree => tree.path === linked)!;
    const timed = async (includeIgnored: boolean) => {
      const started = performance.now();
      const tree = await inspectWorktree(repository, inventory, undefined, true, includeIgnored);
      return { tree, milliseconds: performance.now() - started };
    };
    // Warm the file cache once so neither timing pays for the first directory walk.
    await timed(true);
    const listing = await timed(false);
    const full = await timed(true);
    expect(full.tree.status.kind === "known" && full.tree.status.ignored.length).toBe(10_000);
    expect(listing.tree.status).toEqual({ kind: "known", modified: status.modified, untracked: status.untracked, ignored: [] });
    console.log(`Worktree status with 10,000 ignored files: ${full.milliseconds.toFixed(1)} ms with ignored files, ` +
      `${listing.milliseconds.toFixed(1)} ms without`);
    expect(await Promise.all(indexes.map(index => readFile(index)))).toEqual(indexBefore);
  });
});
