import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string) => execa(process.execPath, [entry, "ls"], {
  cwd, reject: false, timeout: 5_000, env: { CI: "true" },
});

test("timber ls works offline from nested and linked paths and preserves real Git state", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "primary repo-worktrees", "feature");
    const detached = join(directory, "manual detached");
    const stale = join(directory, "stale");
    await git(primary, "worktree", "add", "-b", "feature/list", linked);
    await git(primary, "worktree", "add", "--detach", detached);
    await git(primary, "worktree", "add", "-b", "stale", stale);
    await git(primary, "remote", "add", "upstream", join(directory, "unreachable.git"));
    await rm(stale, { recursive: true });
    await writeFile(join(linked, "tracked.txt"), "staged fixture\n");
    await git(linked, "add", "tracked.txt");
    await writeFile(join(linked, "tracked.txt"), "unstaged fixture\n");
    await writeFile(join(linked, "untracked.txt"), "preserve\n");
    await writeFile(join(linked, ".env"), "ignored fixture\n");
    // ls needs no config, editor, or agent; malformed config must not block it.
    await writeFile(join(primary, ".timber.toml"), "invalid [ toml");
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
    expect(fromPrimary.stderr).toBe("");
    expect(fromLinked.stderr).toBe("");
    expect(fromPrimary.stdout).toBe(fromLinked.stdout);
    const rows = fromPrimary.stdout.split("\n");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toBe("WORKTREE\tBRANCH\tSTATUS\tPATH");
    expect(rows[1]).toBe(`primary\ttrunk\tdirty (0 modified, 1 untracked)\t${primary}`);
    expect(rows).toContain(`linked\tfeature/list\tdirty (1 modified, 1 untracked); 1 ignored\t${linked}`);
    expect(rows).toContain(`linked\t(detached HEAD)\tclean\t${detached}`);
    expect(rows.find(row => row.endsWith(`\t${stale}`))).toMatch(/unknown.*missing.*prunable/);
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
