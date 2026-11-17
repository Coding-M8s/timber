import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { createBackup } from "../src/backup/service";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const secret = "SYNTHETIC_TOKEN=before-copy\n";
const editedSecret = "SYNTHETIC_TOKEN=edited-during-copy\n";

async function sourceFixture(primary: string, directory: string) {
  const target = join(directory, "source worktree");
  await git(primary, "worktree", "add", "-b", "feature/backup-failure", target);
  await fs.writeFile(join(target, "tracked.txt"), "staged work\n");
  await git(target, "add", "tracked.txt");
  await fs.writeFile(join(target, "untracked.txt"), "untracked work\n");
  await fs.writeFile(join(target, ".env"), secret);
  const indexPath = await git(target, "rev-parse", "--path-format=absolute", "--git-path", "index");
  return { target, indexPath, index: await fs.readFile(indexPath) };
}

test("concurrent source edits during backup remove all incomplete storage without changing source refs or index", async () => {
  await withRepository(async (primary, directory) => {
    const { target, indexPath, index } = await sourceFixture(primary, directory);
    const repository = await discoverRepository(primary);
    const selected = (await listWorktrees(repository)).find(tree => tree.path === target)!;
    const refs = await git(primary, "for-each-ref", "--format=%(refname) %(objectname)");
    const registration = await git(primary, "worktree", "list", "--porcelain");
    const status = await git(target, "status", "--porcelain=v1", "--ignored");
    const root = join(primary, ".git/timber/backups");
    const output: string[] = [];
    const actualOpen = fs.open;
    let edited = false;
    // Change an already copied file when the copier opens a later source file.
    // Real reads, hashing, the final rewalk, and failure cleanup all still run.
    const intercept = spyOn(fs, "open").mockImplementation(async (...args) => {
      if (!edited && args[0] === join(target, "tracked.txt")) {
        const incomplete = (await fs.readdir(root)).filter(name => name.startsWith(".incomplete-"));
        expect(incomplete).toHaveLength(1);
        const storage = join(root, incomplete[0]!);
        const blobs = await Promise.all((await fs.readdir(storage)).map(name => fs.readFile(join(storage, name), "utf8")));
        expect(blobs).toContain(secret);
        await fs.writeFile(join(target, ".env"), editedSecret);
        edited = true;
      }
      return actualOpen(...args);
    });
    try {
      await expect(createBackup(repository, selected, {
        stdout: text => { output.push(text); }, stderr: text => { output.push(text); },
      })).rejects.toThrow("The worktree changed while it was being backed up");
    } finally { intercept.mockRestore(); }

    expect(edited).toBe(true);
    expect(output).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
    expect(await git(primary, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(registration);
    expect(await fs.readFile(indexPath)).toEqual(index);
    expect(await git(target, "status", "--porcelain=v1", "--ignored")).toBe(status);
    expect(await fs.readFile(join(target, ".env"), "utf8")).toBe(editedSecret);
    expect(await fs.readFile(join(target, "tracked.txt"), "utf8")).toBe("staged work\n");
    expect(await fs.readFile(join(target, "untracked.txt"), "utf8")).toBe("untracked work\n");
  });
});

test("restore failure after creating a recovery worktree retains it and permits retry after explicit cleanup", async () => {
  await withRepository(async (primary, directory) => {
    const { target, indexPath, index } = await sourceFixture(primary, directory);
    const cli = (...args: string[]) => execa(process.execPath, ["--no-env-file", entry, ...args], {
      cwd: primary, reject: false, timeout: 15_000, env: { CI: "true" },
    });
    const created = await cli("backup", "create", target);
    expect(created.exitCode).toBe(0);
    const id = /^Backup created: (\S+)$/mu.exec(created.stdout)?.[1];
    expect(id).toBeDefined();
    const branch = `recovery/${id}`;
    const backup = join(primary, ".git/timber/backups", id!);
    const names = (await fs.readdir(backup)).sort();
    const bytes = await Promise.all(names.map(name => fs.readFile(join(backup, name))));
    const refs = await git(primary, "for-each-ref", "--format=%(refname) %(objectname)");
    const status = await git(target, "status", "--porcelain=v1", "--ignored");
    const commit = await git(target, "rev-parse", "HEAD");
    const destination = join(directory, "partial recovery");
    const bin = join(directory, "git wrapper");
    await fs.mkdir(bin);
    await fs.writeFile(join(bin, "git"), [
      "#!/bin/sh",
      'for arg do',
      '  if [ "$arg" = read-tree ]; then',
      '    printf injected > "$TIMBER_TEST_FAILURE_MARKER"',
      '    exit 73',
      '  fi',
      'done',
      'exec "$TIMBER_REAL_GIT" "$@"',
      "",
    ].join("\n"));
    await fs.chmod(join(bin, "git"), 0o755);
    const marker = join(directory, "read-tree failed");
    const failed = await execa(process.execPath, ["--no-env-file", entry, "backup", "restore", id!, destination], {
      cwd: primary, reject: false, timeout: 15_000,
      env: { CI: "true", PATH: bin + delimiter + process.env.PATH,
        TIMBER_REAL_GIT: (await execa("which", ["git"])).stdout, TIMBER_TEST_FAILURE_MARKER: marker },
    });

    expect(await fs.readFile(marker, "utf8")).toBe("injected");
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).not.toContain("Restored backup");
    expect(failed.stderr).toContain("incomplete and must not be used");
    expect(failed.stderr).toContain(`git worktree remove --force -- '${destination}'`);
    expect(failed.stderr).toContain(`git branch -D -- '${branch}'`);
    expect(await git(destination, "symbolic-ref", "HEAD")).toBe(`refs/heads/${branch}`);
    expect(await git(destination, "rev-parse", "HEAD")).toBe(commit);
    expect(await git(primary, "worktree", "list", "--porcelain")).toContain(`worktree ${destination}\n`);
    expect(await fs.readFile(join(destination, ".env"), "utf8")).toBe(secret);
    expect(await fs.readFile(join(destination, "tracked.txt"), "utf8")).toBe("staged work\n");
    expect(await fs.readFile(join(destination, "untracked.txt"), "utf8")).toBe("untracked work\n");
    expect(await git(primary, "for-each-ref", "--format=%(refname) %(objectname)", "--exclude", `refs/heads/${branch}`)).toBe(refs);
    expect(await fs.readFile(indexPath)).toEqual(index);
    expect(await git(target, "status", "--porcelain=v1", "--ignored")).toBe(status);
    expect(await fs.readFile(join(target, ".env"), "utf8")).toBe(secret);
    expect(await fs.readFile(join(target, "tracked.txt"), "utf8")).toBe("staged work\n");
    expect(await fs.readFile(join(target, "untracked.txt"), "utf8")).toBe("untracked work\n");
    expect((await fs.readdir(backup)).sort()).toEqual(names);
    expect(await Promise.all(names.map(name => fs.readFile(join(backup, name))))).toEqual(bytes);

    // Perform the two advertised cleanup operations, then restore from the same backup.
    await git(primary, "worktree", "remove", "--force", "--", destination);
    await git(primary, "branch", "-D", "--", branch);
    const restored = await cli("backup", "restore", id!, destination);
    expect(restored.exitCode).toBe(0);
    expect(restored.stderr).toBe("");
    expect(await git(destination, "rev-parse", "HEAD")).toBe(commit);
    expect(await fs.readFile(join(destination, ".env"), "utf8")).toBe(secret);
    expect(await fs.readFile(join(destination, "tracked.txt"), "utf8")).toBe("staged work\n");
    expect(await fs.readFile(join(destination, "untracked.txt"), "utf8")).toBe("untracked work\n");
    expect(await Promise.all(names.map(name => fs.readFile(join(backup, name))))).toEqual(bytes);
  });
});
