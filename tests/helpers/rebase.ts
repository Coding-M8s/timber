import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git } from "./git";

// Shared fixtures for the tests/rebase-*.integration.test.ts files.
export const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
export const cli = (cwd: string, ...args: string[]) => execa(process.execPath, ["--no-env-file", entry, ...args], {
  cwd, reject: false, timeout: 10_000, env: { CI: "true", GIT_EDITOR: "false", GIT_SEQUENCE_EDITOR: "false" },
});

export async function commit(cwd: string, name: string, contents: string | Uint8Array) {
  await writeFile(join(cwd, name), contents);
  await git(cwd, "add", "-f", "--", name);
  await git(cwd, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "test change");
  return git(cwd, "rev-parse", "HEAD");
}

export async function fixture(primary: string, directory: string) {
  await git(primary, "config", "user.name", "Timber Test");
  await git(primary, "config", "user.email", "test@example.invalid");
  const remote = join(directory, "remote.git");
  await git(directory, "init", "--bare", remote);
  await git(primary, "remote", "add", "origin", remote);
  await git(primary, "push", "origin", "trunk:main");
  await git(primary, "branch", "main");
  const publisher = join(directory, "publisher");
  await git(directory, "clone", "--branch", "main", remote, publisher);
  const target = join(directory, "feature 'worktree");
  await git(primary, "worktree", "add", "-b", "TIM-28-feature", target);
  await writeFile(join(primary, ".timber.toml"), 'base_branch = "main"\n');
  await appendFile(join(primary, ".git/info/exclude"), '\n.timber.toml\n');
  return { remote, publisher, target };
}

export async function advance(publisher: string, name = "incoming.txt", contents: string | Uint8Array = "new base\n") {
  const oid = await commit(publisher, name, contents);
  await git(publisher, "push", "origin", "main");
  return oid;
}

export async function paused(target: string) {
  const path = await git(target, "rev-parse", "--git-path", "rebase-merge");
  return Bun.file(join(path, "head-name")).exists();
}

export async function gitWrapper(directory: string, body: string) {
  const real = (await execa("which", ["git"])).stdout;
  const bin = join(directory, "wrapper"); await mkdir(bin);
  await writeFile(join(bin, "git"), "#!/bin/sh\n" + body + '\nexec "$TIMBER_TEST_GIT" "$@"\n');
  await chmod(join(bin, "git"), 0o755);
  return { PATH: bin + ":" + process.env.PATH, TIMBER_TEST_GIT: real };
}
