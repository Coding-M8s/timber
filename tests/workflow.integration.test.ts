import { expect, test } from "bun:test";
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, ...args], {
  cwd, reject: false, timeout: 10_000, env: { CI: "true" },
});

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function refStatus(cwd: string, branch: string) {
  return execa("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd, reject: false,
  });
}

test("new, setup retry, open, ls, and safe cleanup work across one real repository workflow", async () => {
  await withRepository(async (primary, directory) => {
    await mkdir(join(primary, "nested"));
    await writeFile(join(primary, "nested", "README.md"), "Nested discovery fixture.\n");
    await writeFile(join(primary, ".gitignore"), ".env\n.setup-log\n.timber.toml\n");
    await git(primary, "add", ".gitignore", "nested/README.md");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid",
      "commit", "-m", "prepare workflow fixtures");
    await git(primary, "branch", "-m", "main");

    const hook = "printf \"%s\\n%s\\n%s\\n%s\\n%s\\n\" \"$PWD\" \"$TIMBER_REPO\" \"$TIMBER_WORKTREE\" \"$TIMBER_BRANCH\" \"$TIMBER_TASK_ID\" >> .setup-log";
    await writeFile(join(primary, ".timber.toml"), [
      'base_branch = "main"',
      'worktree_dir = "../primary repo-worktrees"',
      "",
      "[hooks]",
      `post_create = [${JSON.stringify(hook)}]`,
      "",
    ].join("\n"));

    const worktreeRoot = join(directory, "primary repo-worktrees");
    const workflowBranch = "TIM-16-workflow";
    const workflowTree = join(worktreeRoot, workflowBranch);
    const keepBranch = "TIM-16-keep-branch";
    const keepTree = join(worktreeRoot, keepBranch);
    const integratedBranch = "TIM-16-integrated";
    const integratedTree = join(worktreeRoot, integratedBranch);
    const nested = join(primary, "nested");

    const created = await cli(primary, "new", workflowBranch, "--base", "main", "--no-editor", "--no-agent");
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toBe(`Created ${workflowBranch} at ${workflowTree}`);
    expect(created.stderr).toBe("");
    const setupRows = (await readFile(join(workflowTree, ".setup-log"), "utf8")).trimEnd().split("\n");
    expect(setupRows).toEqual([workflowTree, primary, workflowTree, workflowBranch, "TIM-16"]);

    const opened = await cli(nested, "open", workflowBranch, "--no-editor", "--no-agent");
    expect(opened.exitCode).toBe(0);
    expect(opened.stdout).toBe(`Opened existing worktree at ${workflowTree}`);
    expect(opened.stderr).toBe("");
    expect((await readFile(join(workflowTree, ".setup-log"), "utf8")).trimEnd().split("\n"))
      .toHaveLength(5);

    const retried = await cli(nested, "open", workflowBranch, "--setup", "--no-editor", "--no-agent");
    expect(retried.exitCode).toBe(0);
    expect(retried.stdout).toBe(`Opened existing worktree at ${workflowTree}`);
    expect(retried.stderr).toBe("");
    expect((await readFile(join(workflowTree, ".setup-log"), "utf8")).trimEnd().split("\n"))
      .toHaveLength(10);

    const [fromPrimary, fromNested, fromLinked] = await Promise.all([
      cli(primary, "ls"), cli(nested, "ls"), cli(workflowTree, "ls"),
    ] as const);
    for (const listing of [fromPrimary, fromNested, fromLinked]) {
      expect(listing.exitCode).toBe(0);
      expect(listing.stderr).toBe("");
      const rows = listing.stdout.split("\n");
      expect(rows.find(row => row.endsWith(primary))).toMatch(/primary\s+main\s+-\s+clean\s/);
      expect(rows.find(row => row.endsWith(workflowTree))).toMatch(/linked\s+TIM-16-workflow\s+refs\/heads\/main\s+clean\s/);
    }
    expect(fromNested.stdout).toBe(fromPrimary.stdout);
    expect(fromLinked.stdout).toBe(fromPrimary.stdout);

    const bare = join(directory, "origin.git");
    await git(directory, "init", "--bare", "--initial-branch=main", bare);
    await git(primary, "remote", "add", "origin", bare);
    await git(primary, "push", "-u", "origin", "main");

    await cli(primary, "new", keepBranch, "--base", "main", "--no-editor", "--no-agent").then(result => {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    });
    await cli(primary, "new", integratedBranch, "--base", "main", "--no-editor", "--no-agent").then(result => {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    });

    await appendFile(join(workflowTree, "tracked.txt"), "workflow feature commit\n");
    await git(workflowTree, "add", "--", "tracked.txt");
    await git(workflowTree, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid",
      "commit", "-m", "published workflow feature");
    const workflowOid = await git(workflowTree, "rev-parse", "HEAD");
    await git(workflowTree, "push", "-u", "origin", workflowBranch);

    await writeFile(join(integratedTree, "integration.txt"), "integrated into main\n");
    await git(integratedTree, "add", "--", "integration.txt");
    await git(integratedTree, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid",
      "commit", "-m", "integrated cleanup proof");
    await git(primary, "merge", "--ff-only", integratedBranch);
    await git(primary, "merge-base", "--is-ancestor", integratedBranch, "main");

    const beforePublishedCleanup = await git(primary, "worktree", "list", "--porcelain");
    expect(beforePublishedCleanup).toContain(`worktree ${workflowTree}`);
    expect(beforePublishedCleanup).toContain(`worktree ${keepTree}`);
    expect(beforePublishedCleanup).toContain(`worktree ${integratedTree}`);
    const publishedCleanup = await cli(primary, "done", workflowBranch);
    expect(publishedCleanup.exitCode).toBe(0);
    expect(publishedCleanup.stdout).toContain(`Removed worktree at ${workflowTree}`);
    expect(publishedCleanup.stdout).toContain(`Deleted local branch ${workflowBranch}`);
    expect(publishedCleanup.stderr).toBe("");
    expect(await absent(workflowTree)).toBe(true);
    expect((await refStatus(primary, workflowBranch)).exitCode).toBe(1);
    expect(await git(bare, "rev-parse", `refs/heads/${workflowBranch}`)).toBe(workflowOid);
    let inventory = await git(primary, "worktree", "list", "--porcelain");
    expect(inventory).not.toContain(workflowTree);
    expect(inventory).toContain(keepTree);
    expect(inventory).toContain(integratedTree);

    const keepCleanup = await cli(primary, "done", keepBranch, "--keep-branch");
    expect(keepCleanup.exitCode).toBe(0);
    expect(keepCleanup.stdout).toContain(`Removed worktree at ${keepTree}`);
    expect(keepCleanup.stdout).toContain(`Retained local branch ${keepBranch}`);
    expect(keepCleanup.stderr).toBe("");
    expect(await absent(keepTree)).toBe(true);
    expect((await refStatus(primary, keepBranch)).exitCode).toBe(0);
    inventory = await git(primary, "worktree", "list", "--porcelain");
    expect(inventory).not.toContain(keepTree);
    expect(inventory).toContain(integratedTree);

    const integratedCleanup = await cli(primary, "done", integratedBranch);
    expect(integratedCleanup.exitCode).toBe(0);
    expect(integratedCleanup.stdout).toContain(`Removed worktree at ${integratedTree}`);
    expect(integratedCleanup.stdout).toContain(`Deleted local branch ${integratedBranch}`);
    expect(integratedCleanup.stderr).toBe("");
    expect(await absent(integratedTree)).toBe(true);
    expect((await refStatus(primary, integratedBranch)).exitCode).toBe(1);
    expect(await readFile(join(primary, "integration.txt"), "utf8")).toBe("integrated into main\n");
    expect((await git(primary, "worktree", "list", "--porcelain")).trim())
      .toBe(`worktree ${primary}\nHEAD ${await git(primary, "rev-parse", "HEAD")}\nbranch refs/heads/main`);
  });
}, 30_000);
