import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { discoverRepository } from "../src/git/repository";
import { listWorktreeInventory, uninspectedWorktree } from "../src/git/worktrees";
import { writeBaseAssociation } from "../src/git/base-metadata";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
type Event = { event: string; sid: string; argv?: string[]; worktree?: string };

async function traced(cwd: string, directory: string, args: string[]) {
  const trace = join(directory, "trace.jsonl");
  await writeFile(trace, "");
  const result = await execa(process.execPath, ["--no-env-file", entry, ...args], {
    cwd, reject: false, env: { CI: "true", GIT_TRACE2_EVENT: trace }, timeout: 20_000,
  });
  const events: Event[] = (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const statuses = new Set(events.filter(event => event.event === "start" && event.argv?.includes("status")).map(event => event.sid));
  return { result, events, statusPaths: events.filter(event => event.event === "def_repo" && statuses.has(event.sid)).map(event => event.worktree) };
}

for (const command of ["open", "new", "done", "rebase", "native done preview"] as const) {
  test(`${command} scans only its selected worktree and preserves unrelated files and refs`, async () => {
    await withRepository(async (primary, directory) => {
      const target = join(directory, "target");
      const unrelated = join(directory, "unrelated");
      await git(primary, "worktree", "add", "-b", "GH-108-target", target);
      await git(primary, "worktree", "add", "-b", "unrelated", unrelated);
      await writeFile(join(unrelated, "tracked.txt"), "preserve dirty sibling\n");
      await writeFile(join(unrelated, "untracked.txt"), "preserve untracked sibling\n");
      const siblingTip = await git(unrelated, "rev-parse", "HEAD");
      const args = command === "new" ? ["new", "fresh", "--base", "trunk", "--no-editor", "--no-agent"]
        : command === "rebase" ? ["rebase", "GH-108-target", "--base", "refs/heads/trunk"]
        : command === "native done preview" ? ["__ide-done", "preview", "--base", "trunk", "--keep-branch", "--", target]
        : command === "done" ? ["done", "GH-108-target", "--base", "trunk"]
        : ["open", "GH-108-target", "--no-editor", "--no-agent"];
      const { result, statusPaths } = await traced(primary, directory, args);
      expect(result.stderr).not.toContain("error:");
      expect(result.exitCode).toBe(0);
      expect(statusPaths.length).toBeGreaterThan(0);
      const expectedPath = command === "new" ? join(directory, "primary repo-worktrees", "fresh") : target;
      expect([...new Set(statusPaths)]).toEqual([expectedPath]);
      expect(await readFile(join(unrelated, "tracked.txt"), "utf8")).toBe("preserve dirty sibling\n");
      expect(await readFile(join(unrelated, "untracked.txt"), "utf8")).toBe("preserve untracked sibling\n");
      expect(await git(unrelated, "rev-parse", "HEAD")).toBe(siblingTip);
    });
  });
}

test("list shares verified identity between status and base reads", async () => {
  await withRepository(async (primary, directory) => {
    const target = join(directory, "target");
    await git(primary, "worktree", "add", "-b", "GH-108-target", target);
    const repository = await discoverRepository(primary);
    const tree = uninspectedWorktree((await listWorktreeInventory(repository)).find(tree => tree.path === target)!);
    await writeBaseAssociation(repository, tree, "refs/heads/trunk");
    const { result, events, statusPaths } = await traced(primary, directory, ["ls"]);
    expect(result.stdout).toContain("refs/heads/trunk");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("warning:");
    expect(statusPaths.sort()).toEqual([primary, target].sort());
    const directories = events.filter(event => event.event === "start" && event.argv?.includes("--absolute-git-dir"));
    expect(directories).toHaveLength(2);
  });
});

for (const collision of ["checked-out branch", "existing destination"] as const) {
  test(`new refuses ${collision} without scanning worktree files`, async () => {
    await withRepository(async (primary, directory) => {
      const target = join(directory, "target");
      await git(primary, "worktree", "add", "-b", "feature", target);
      await writeFile(join(target, "tracked.txt"), "keep local changes\n");
      const branch = collision === "checked-out branch" ? "feature" : "fresh";
      const destination = join(directory, "primary repo-worktrees", branch);
      if (collision === "existing destination") {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "sentinel.txt"), "keep destination\n");
      }
      const refs = await git(primary, "show-ref");
      const inventory = await git(primary, "worktree", "list", "--porcelain", "-z");
      const { result, statusPaths } = await traced(primary, directory,
        ["new", branch, "--base", "trunk", "--no-editor", "--no-agent"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(collision === "checked-out branch" ? "already checked out" : "already exists");
      expect(statusPaths).toEqual([]);
      expect(await git(primary, "show-ref")).toBe(refs);
      expect(await git(primary, "worktree", "list", "--porcelain", "-z")).toBe(inventory);
      expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("keep local changes\n");
      if (collision === "existing destination") {
        expect(await readFile(join(destination, "sentinel.txt"), "utf8")).toBe("keep destination\n");
      }
    });
  });
}

test("ambiguous open inspects matching candidates while keeping stale matches visible", async () => {
  await withRepository(async (primary, directory) => {
    const healthy = join(directory, "healthy");
    const stale = join(directory, "stale");
    const sibling = join(directory, "sibling");
    for (const [branch, path] of [["GH-108-one", healthy], ["GH-108-two", stale], ["unrelated", sibling]]) {
      await git(primary, "worktree", "add", "-b", branch!, path!);
    }
    await rm(stale, { recursive: true });
    const refs = await git(primary, "show-ref");
    const { result, statusPaths } = await traced(primary, directory, ["open", "GH-108", "--no-editor", "--no-agent"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("matches 2 targets");
    expect(result.stderr).toContain(healthy);
    expect(result.stderr).toContain(stale);
    expect(statusPaths).toEqual([healthy]);
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});
