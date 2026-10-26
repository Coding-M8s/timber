import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { createWorktree } from "../src/git/create-worktree";
import { resolveBase } from "../src/git/branches";
import { discoverRepository } from "../src/git/repository";
import { readBaseAssociation, writeBaseAssociation } from "../src/git/base-metadata";
import { privateDirectory, assertPrivateStorage } from "../src/platform/private-storage";
import { samePath } from "../src/platform/paths";
import { lstat } from "node:fs/promises";
import { launchAgent } from "../src/agent";
import { launchEditor } from "../src/editor";
import { readCredentialStore, withCredentialSave } from "../src/jira/credentials";
import type { RepositoryConfig } from "../src/types";
import { git, withRepository } from "./helpers/git";

const windows = test.skipIf(process.platform !== "win32");
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const config: RepositoryConfig = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };

windows("native paths with spaces and Unicode preserve saved identity across separators", async () => {
  await withRepository(async (primary, directory) => {
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config, "trunk");
    const tree = await createWorktree(repository, { kind: "new", branch: "native/topic", base },
      { ...config, worktreeDir: join(directory, "Équipe worktrees") });
    await writeBaseAssociation(repository, tree, base.ref);
    const alias = { ...tree, path: tree.path.replaceAll("\\", "/") };
    expect(await readBaseAssociation(repository, alias)).toEqual({ kind: "assigned", ref: base.ref });
    expect(await git(tree.path, "rev-parse", "HEAD")).toBe(base.commit);
  });
});

windows("case-only branch collisions and reserved paths preserve refs and files", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "branch", "Topic");
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config, "trunk");
    const refs = await git(primary, "show-ref");
    const inventory = await git(primary, "worktree", "list", "--porcelain");
    await expect(createWorktree(repository, { kind: "new", branch: "topic", base }, config)).rejects.toThrow();
    await expect(createWorktree(repository, { kind: "new", branch: "CON", base }, config)).rejects.toThrow();
    const root = join(directory, "destinations"); await mkdir(root);
    await mkdir(join(root, "Already-Here")); await writeFile(join(root, "Already-Here", "keep.txt"), "preserve");
    await expect(createWorktree(repository, { kind: "new", branch: "already-here", base }, { ...config, worktreeDir: root })).rejects.toThrow();
    expect(await readFile(join(root, "Already-Here", "keep.txt"), "utf8")).toBe("preserve");
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(inventory);
  });
});

windows("native hook failure and cleanup refusal retain files, refs and registration", async () => {
  await withRepository(async (primary, directory) => {
    const env = { CI: "true", XDG_CONFIG_HOME: join(directory, "config"), XDG_STATE_HOME: join(directory, "state") };
    const cli = (...args: string[]) => execa(process.execPath, ["--no-env-file", entry, ...args], { cwd: primary, env, reject: false, timeout: 30_000 });
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n[hooks]\npost_create = ["printf preserved > retained.txt; exit 23"]\n');
    const failed = await cli("new", "hook-failure", "--no-agent", "--no-editor");
    expect(failed.exitCode).toBe(1); expect(failed.stderr).toContain("exit code 23");
    const tree = join(directory, "primary repo-worktrees", "hook-failure");
    const refs = await git(primary, "show-ref");
    const inventory = await git(primary, "worktree", "list", "--porcelain");
    expect((await cli("done", "hook-failure")).exitCode).toBe(1);
    expect(await readFile(join(tree, "retained.txt"), "utf8")).toBe("preserved");
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(inventory);
  });
}, 60_000);

windows("new Windows private directories have an account-owned private ACL", async () => {
  await withRepository(async (_primary, directory) => {
    const path = join(directory, "private Équipe");
    await privateDirectory(path);
    await assertPrivateStorage(path, await lstat(path), true);
  });
}, 30_000);

windows("broadened Windows ACLs are refused without deleting stored files", async () => {
  await withRepository(async (_primary, directory) => {
    const path = join(directory, "private metadata");
    await privateDirectory(path);
    const sentinel = join(path, "retained.txt");
    await writeFile(sentinel, "preserve");
    await execa("icacls.exe", [path, "/grant", "*S-1-1-0:(OI)(CI)R"], { stdin: "ignore" });
    await expect(assertPrivateStorage(path, await lstat(path), true)).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("preserve");
  });
}, 30_000);

windows("Windows saved credentials use a private ACL and retain the synthetic pair on reread", async () => {
  await withRepository(async (_primary, directory) => {
    const env = { XDG_CONFIG_HOME: join(directory, "user-config") };
    const store = await readCredentialStore(env);
    const jira = { siteUrl: "https://example.atlassian.net" };
    const pair = { email: "fixture@example.invalid", token: "SYNTHETIC_WINDOWS_FIXTURE" };
    store.set(jira, pair);
    await withCredentialSave(store, async () => {});
    expect((await readCredentialStore(env)).get(jira)).toEqual(pair);
    await assertPrivateStorage(store.path, await lstat(store.path), false);
  });
}, 120_000);

windows("native PowerShell agent argv stays literal and startup failures preserve its worktree", async () => {
  await withRepository(async (primary, directory) => {
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config, "trunk");
    const tree = await createWorktree(repository, { kind: "new", branch: "native-launch", base }, config);
    const script = join(directory, "wrapper with spaces.ps1");
    const capture = join(directory, "capture.json");
    await writeFile(script, '$ErrorActionPreference = "Stop"\n@{ cwd = [Environment]::CurrentDirectory; args = @($args) } | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:TIMBER_TEST_CAPTURE -Encoding UTF8\nexit 7\n');
    const command = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const args = ["space and Unicode é", "$HOME; literal", "apostrophe's", "back`tick"];
    const refs = await git(primary, "show-ref");
    const inventory = await git(primary, "worktree", "list", "--porcelain");
    const result = await launchAgent(tree, { command, args: ["-NoProfile", "-File", script, ...args] }, { TIMBER_TEST_CAPTURE: capture });
    expect(result).toMatchObject({ kind: "exited", exitCode: 7 });
    const recorded = JSON.parse((await readFile(capture, "utf8")).replace(/^\uFEFF/u, ""));
    expect(recorded.args).toEqual(args);
    expect(samePath(recorded.cwd, tree.path)).toBe(true);
    expect((await launchAgent(tree, { command: "missing-native-fixture.exe", args: [] })).kind).toBe("failed");
    expect((await launchAgent(tree, { command: "fixture.cmd", args: [] })).kind).toBe("failed");
    expect((await launchEditor(tree, { ...config, editor: { command: "missing-native-fixture.exe", args: [], enabled: true } }, false)).kind).toBe("failed");
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(inventory);
    expect(await readFile(join(tree.path, "tracked.txt"), "utf8")).toBe("original\n");
  });
}, 60_000);
