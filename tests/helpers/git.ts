import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd, env: { GIT_OPTIONAL_LOCKS: "0" } })).stdout;
}

export async function withRepository(run: (primary: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "timber list "));
  const primary = join(directory, "primary repo");
  try {
    await mkdir(primary);
    await git(primary, "init", "-b", "trunk");
    await writeFile(join(primary, "tracked.txt"), "original\n");
    await writeFile(join(primary, "old name.txt"), "rename me\n");
    await writeFile(join(primary, ".gitignore"), ".env\n");
    await git(primary, "add", ".");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
    await run(primary, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
