import { expect, test } from "bun:test";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { readBaseAssociation, writeBaseAssociation } from "../src/git/base-metadata";
import { readIssueLink, writeIssueLink } from "../src/git/issue-link";
import { readPrivateRecord } from "../src/git/private-record";
import { discoverRepository } from "../src/git/repository";
import { assertPrivateStorage } from "../src/platform/private-storage";
import type { RepositoryConfig } from "../src/types";
import { git, withRepository } from "./helpers/git";

const windows = test.skipIf(process.platform !== "win32");
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const config: RepositoryConfig = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };
const refused = /^Cannot establish private Windows storage\. Use an NTFS directory owned by your account with access limited to you, SYSTEM and Administrators; inspect its ACL privately before retrying\. /u;
const link = { tracker: "github", key: "238", url: "https://github.com/example/repo/issues/238" } as const;

/** A worktree with a saved base and issue link; returns its private record directory. */
async function linkedWorktree(primary: string) {
  const repository = await discoverRepository(primary);
  const base = await resolveBase(repository, config, "trunk");
  const tree = await createWorktree(repository, { kind: "new", branch: "records", base }, config);
  await writeBaseAssociation(repository, tree, base.ref);
  await writeIssueLink(repository, tree, link);
  const directory = join(await git(primary, "rev-parse", "--path-format=absolute", "--git-common-dir"), "worktrees", "records", "timber");
  return { repository, tree, directory, base: join(directory, "base.json") };
}

const icacls = (...args: string[]) => execa("icacls.exe", args, { stdin: "ignore" });

windows("ls --json reads saved records without starting PowerShell", async () => {
  await withRepository(async primary => {
    await linkedWorktree(primary);
    // With SystemRoot pointing at an empty folder, any powershell.exe start fails and the
    // records would be reported unreadable.
    const empty = join(primary, "..", "no windows"); await mkdir(empty);
    const result = await execa(process.execPath, ["--no-env-file", entry, "ls", "--json"], {
      cwd: primary, env: { CI: "true", SystemRoot: empty }, reject: false, timeout: 30_000,
    });
    expect(result.stderr).toBe("");
    const tree = JSON.parse(result.stdout).worktrees.find((row: { branch: string }) => row.branch === "records");
    expect(tree.base).toEqual({ kind: "assigned", ref: "refs/heads/trunk" });
    expect(tree.issue).toMatchObject({ kind: "linked", ...link });
  });
}, 60_000);

windows("a record directory readable by others is refused with the private storage message", async () => {
  await withRepository(async primary => {
    const { repository, tree, directory } = await linkedWorktree(primary);
    await icacls(directory, "/grant", "*S-1-1-0:R");
    await expect(assertPrivateStorage(directory, await lstat(directory), true)).rejects.toThrow(refused);
    expect(await readBaseAssociation(repository, tree)).toMatchObject({ kind: "invalid", reason: "unreadable" });
    expect(await readIssueLink(repository, tree)).toMatchObject({ kind: "invalid", reason: "unreadable" });
  });
}, 60_000);

windows("a record file readable by others is refused while the directory stays private", async () => {
  await withRepository(async primary => {
    const { repository, tree, directory, base } = await linkedWorktree(primary);
    await icacls(base, "/grant", "*S-1-1-0:R");
    await assertPrivateStorage(directory, await lstat(directory), true);
    await expect(assertPrivateStorage(base, await lstat(base), false)).rejects.toThrow(refused);
    expect(await readPrivateRecord(directory, base, 4096)).toEqual({ kind: "invalid", reason: "unreadable" });
    expect(await readBaseAssociation(repository, tree)).toMatchObject({ kind: "invalid", reason: "unreadable" });
    expect(await readIssueLink(repository, tree)).toMatchObject({ kind: "linked" });
  });
}, 60_000);

windows("a grant inherited from the record directory is refused on the file", async () => {
  await withRepository(async primary => {
    const { directory, base } = await linkedWorktree(primary);
    await icacls(directory, "/grant", "*S-1-1-0:(OI)(CI)R");
    // Records are created with inheritance blocked; allow it so the file gets the grant.
    await icacls(base, "/inheritance:e");
    const acl = (await icacls(base)).stdout;
    expect(acl).toContain("(I)(R)");
    await expect(assertPrivateStorage(base, await lstat(base), false)).rejects.toThrow(/ Nonprivate ACL$/u);
  });
}, 60_000);

windows("storage owned by another account is refused", async () => {
  const system = process.env.SystemRoot ?? "C:\\Windows";
  await expect(assertPrivateStorage(system, await lstat(system), true)).rejects.toThrow(/ Unexpected owner$/u);
});
