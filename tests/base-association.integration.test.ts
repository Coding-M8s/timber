import { expect, test } from "bun:test";
import { appendFile, chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, ...args: string[]) => execa(process.execPath, ["--no-env-file", entry, ...args], {
  cwd, reject: false, timeout: 10_000, env: { CI: "true" },
});
async function commit(path: string, name: string, bytes: string) {
  await writeFile(join(path, name), bytes);
  await git(path, "add", "--", name);
  await git(path, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "change");
  return git(path, "rev-parse", "HEAD");
}
async function metadata(path: string) {
  return join(await git(path, "rev-parse", "--absolute-git-dir"), "timber", "base.json");
}
async function create(primary: string, branch = "feature", base = "trunk") {
  const result = await cli(primary, "new", branch, "--base", base, "--no-editor", "--no-agent");
  expect(result.exitCode).toBe(0);
  return (await git(primary, "worktree", "list", "--porcelain")).split("\n\n")
    .find(block => block.includes(`branch refs/heads/${branch}\n`) || block.endsWith(`branch refs/heads/${branch}`))!
    .split("\n")[0]!.slice("worktree ".length);
}
async function setup(primary: string) {
  await git(primary, "config", "user.name", "Timber Test");
  await git(primary, "config", "user.email", "test@example.invalid");
  await appendFile(join(primary, ".git/info/exclude"), "\n.timber.toml\n");
  await writeFile(join(primary, ".timber.toml"), 'base_branch = "absent"\n');
}

test("new saves a private local base and ls displays it without guessing bases for other trees", async () => {
  await withRepository(async primary => {
    await setup(primary);
    const target = await create(primary);
    expect(JSON.parse(await readFile(await metadata(target), "utf8")).ref).toBe("refs/heads/trunk");
    expect((await lstat(await metadata(target))).mode & 0o777).toBe(0o600);
    const result = await cli(target, "ls");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/BRANCH\s+BASE\s+WORKFLOW/);
    expect(result.stdout).toMatch(/linked\s+feature\s+refs\/heads\/trunk\s+-/);
    expect(result.stdout).toMatch(/primary\s+trunk\s+-\s+-/);
    expect(await git(target, "status", "--porcelain")).toBe("");
  });
});

test("saved local base overrides config, follows its current tip and warns on every invocation", async () => {
  await withRepository(async primary => {
    await setup(primary);
    const target = await create(primary);
    await commit(target, "feature.txt", "feature\n");
    const incoming = await commit(primary, "incoming.txt", "incoming\n");
    for (let i = 0; i < 2; i++) {
      const result = await cli(primary, "rebase", target);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Using local branch 'trunk' as the base");
      expect(result.stderr).toContain("will not fetch or pull");
      expect(result.stderr).toContain("up to date");
      expect(await git(primary, "rev-parse", "trunk")).toBe(incoming);
    }
    expect(await git(target, "rev-parse", "HEAD^")).toBe(incoming);
  });
});

test("explicit local override is saved on no-op and failures preserve that association and user files", async () => {
  await withRepository(async primary => {
    await setup(primary);
    const target = await create(primary);
    await git(primary, "branch", "alternate");
    expect((await cli(primary, "rebase", target, "--base", "refs/heads/alternate")).exitCode).toBe(0);
    const record = await readFile(await metadata(target), "utf8");
    expect(JSON.parse(record).ref).toBe("refs/heads/alternate");
    await writeFile(join(target, "untracked.txt"), "keep\n");
    const refs = await git(primary, "show-ref");
    expect((await cli(primary, "rebase", target, "--base", "refs/heads/trunk")).exitCode).toBe(1);
    expect(await readFile(await metadata(target), "utf8")).toBe(record);
    expect(await readFile(join(target, "untracked.txt"), "utf8")).toBe("keep\n");
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

test("conflicts save the new base while native abort restores commits without reverting the saved choice", async () => {
  await withRepository(async primary => {
    await setup(primary);
    const target = await create(primary);
    const original = await commit(target, "tracked.txt", "feature\n");
    await git(primary, "branch", "alternate");
    const incoming = await commit(primary, "tracked.txt", "base\n");
    await git(primary, "update-ref", "refs/heads/alternate", incoming);
    const result = await cli(primary, "rebase", target, "--base", "refs/heads/alternate");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("paused with conflicts");
    expect(result.stderr).toContain("rebase --continue");
    expect(JSON.parse(await readFile(await metadata(target), "utf8")).ref).toBe("refs/heads/alternate");
    expect((await cli(primary, "ls")).stdout).toContain("refs/heads/alternate");
    await git(target, "rebase", "--abort");
    expect(await git(target, "rev-parse", "HEAD")).toBe(original);
    expect(JSON.parse(await readFile(await metadata(target), "utf8")).ref).toBe("refs/heads/alternate");
  });
});

test("a rejected Git hook preserves the previous association, refs and files", async () => {
  await withRepository(async primary => {
    await setup(primary);
    const target = await create(primary);
    await commit(target, "feature.txt", "feature\n");
    await commit(primary, "incoming.txt", "incoming\n");
    const hook = join(primary, ".git/hooks/pre-rebase");
    await writeFile(hook, "#!/bin/sh\nexit 1\n"); await chmod(hook, 0o755);
    const record = await readFile(await metadata(target), "utf8");
    const refs = await git(primary, "show-ref");
    const result = await cli(primary, "rebase", target, "--base", "refs/heads/trunk");
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain("Git rebase failed");
    expect(await readFile(await metadata(target), "utf8")).toBe(record);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await readFile(join(target, "feature.txt"), "utf8")).toBe("feature\n");
  });
});

test("deleted saved base fails without falling back and explicit replacement repairs the choice", async () => {
  await withRepository(async primary => {
    await setup(primary);
    await git(primary, "branch", "alternate");
    const target = await create(primary, "feature", "alternate");
    await git(primary, "branch", "-d", "alternate");
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n');
    const record = await readFile(await metadata(target), "utf8");
    const refs = await git(primary, "show-ref");
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--base");
    expect(await readFile(await metadata(target), "utf8")).toBe(record);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect((await cli(primary, "rebase", target, "--base", "refs/heads/trunk")).exitCode).toBe(0);
  });
});

test.each(["malformed", "stale"])("ls retains %s base rows and rebase refuses before mutation", async scenario => {
  await withRepository(async primary => {
    await setup(primary);
    const target = await create(primary);
    const file = await metadata(target);
    const record = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, scenario === "malformed" ? "not JSON" : JSON.stringify({ ...record, worktreePath: primary }));
    const result = await cli(primary, "ls");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/linked\s+feature\s+\?\s+-/);
    expect(result.stderr).toContain("base association");
    expect((await cli(primary, "rebase", target)).exitCode).toBe(1);
    expect(await git(target, "status", "--porcelain")).toBe("");
  });
});

test("saved remote identity overrides config and same-named local branches while fetching fresh tips", async () => {
  await withRepository(async (primary, directory) => {
    await setup(primary);
    const remote = join(directory, "remote.git");
    await git(directory, "init", "--bare", remote);
    await git(primary, "remote", "add", "origin", remote);
    await git(primary, "push", "origin", "trunk:main");
    await git(primary, "branch", "main");
    const localMain = await git(primary, "rev-parse", "main");
    const target = await create(primary, "feature", "origin/main");
    const incoming = await commit(primary, "incoming.txt", "incoming\n");
    await git(primary, "push", "origin", "trunk:main");
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("origin/main");
    expect(result.stderr).not.toContain("Using local branch");
    expect(await git(target, "rev-parse", "HEAD")).toBe(incoming);
    expect(await git(primary, "rev-parse", "main")).toBe(localMain);
    expect(JSON.parse(await readFile(await metadata(target), "utf8")).ref).toBe("refs/remotes/origin/main");
  });
});

test("local base movement during safety reads stops rebase and retains files and metadata", async () => {
  await withRepository(async (primary, directory) => {
    await setup(primary);
    const target = await create(primary);
    const original = await commit(target, "feature.txt", "keep\n");
    const initialBase = await git(primary, "rev-parse", "trunk");
    const incoming = await commit(primary, "incoming.txt", "incoming\n");
    await git(primary, "branch", "base", initialBase);
    const record = await readFile(await metadata(target), "utf8");
    const bin = join(directory, "bin"); await mkdir(bin);
    const realGit = (await execa("which", ["git"])).stdout;
    const wrapper = join(bin, "git");
    await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = merge-base ]; then\n  "$TIMBER_TEST_GIT" -C "$TIMBER_TEST_PRIMARY" update-ref refs/heads/base "$TIMBER_TEST_INCOMING" || exit $?\nfi\nexec "$TIMBER_TEST_GIT" "$@"\n');
    await chmod(wrapper, 0o755);
    const result = await execa(process.execPath, ["--no-env-file", entry, "rebase", target, "--base", "refs/heads/base"], {
      cwd: primary, reject: false, timeout: 10_000,
      env: { CI: "true", PATH: bin + ":" + process.env.PATH, TIMBER_TEST_GIT: realGit,
        TIMBER_TEST_PRIMARY: primary, TIMBER_TEST_INCOMING: incoming },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Local base changed");
    expect(await git(target, "rev-parse", "HEAD")).toBe(original);
    expect(await readFile(join(target, "feature.txt"), "utf8")).toBe("keep\n");
    expect(await readFile(await metadata(target), "utf8")).toBe(record);
    expect(await git(primary, "rev-parse", "base")).toBe(incoming);
  });
});

test.each(["deleted", "fetch-fails"])("saved remote %s stops without replacing metadata or changing refs", async scenario => {
  await withRepository(async (primary, directory) => {
    await setup(primary);
    const remote = join(directory, "remote.git");
    await git(directory, "init", "--bare", remote);
    await git(primary, "remote", "add", "origin", remote);
    await git(primary, "push", "origin", "trunk:main");
    const target = await create(primary, "feature", "origin/main");
    const original = await commit(target, "feature.txt", "keep\n");
    const record = await readFile(await metadata(target), "utf8");
    if (scenario === "deleted") await git(primary, "push", "origin", "--delete", "main");
    else await git(primary, "config", "remote.origin.uploadpack", "/bin/false");
    const refs = await git(primary, "show-ref");
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/base|discover/);
    expect(await readFile(await metadata(target), "utf8")).toBe(record);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(target, "rev-parse", "HEAD")).toBe(original);
    expect(await readFile(join(target, "feature.txt"), "utf8")).toBe("keep\n");
  });
});

test("explicit local bases work offline despite a configured remote and preserve ignored collisions", async () => {
  await withRepository(async primary => {
    await setup(primary);
    const target = await create(primary);
    await git(primary, "remote", "add", "origin", "/nonexistent/timber-remote");
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "main"\nremote = "origin"\n');
    expect((await cli(primary, "rebase", target, "--base", "refs/heads/trunk")).exitCode).toBe(0);
    await writeFile(join(target, ".env"), "keep local bytes\n");
    await writeFile(join(primary, ".env"), "incoming\n");
    await git(primary, "add", "-f", ".env");
    await git(primary, "commit", "-m", "track env");
    const refs = await git(primary, "show-ref");
    const record = await readFile(await metadata(target), "utf8");
    const result = await cli(primary, "rebase", target);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ignored content");
    expect(await readFile(join(target, ".env"), "utf8")).toBe("keep local bytes\n");
    expect(await readFile(await metadata(target), "utf8")).toBe(record);
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

test("symbolic local bases fail before changing refs, files or the saved base", async () => {
  await withRepository(async primary => {
    await setup(primary);
    const target = await create(primary);
    await git(primary, "symbolic-ref", "refs/heads/alias", "refs/heads/trunk");
    const record = await readFile(await metadata(target), "utf8");
    const refs = await git(primary, "show-ref");
    const result = await cli(primary, "rebase", target, "--base", "refs/heads/alias");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("direct branch ref");
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await readFile(await metadata(target), "utf8")).toBe(record);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test.each([false, true])("metadata publication failure reports actual Git outcome and preserves it, conflicts=%s", async conflict => {
  await withRepository(async primary => {
    await setup(primary);
    const target = await create(primary);
    const original = await commit(target, conflict ? "tracked.txt" : "feature.txt", "feature\n");
    const incoming = await commit(primary, conflict ? "tracked.txt" : "incoming.txt", "incoming\n");
    await git(primary, "branch", "alternate", incoming);
    const file = await metadata(target);
    const record = await readFile(file, "utf8");
    const hook = join(primary, ".git/hooks/pre-rebase");
    await writeFile(hook, '#!/bin/sh\nchmod 755 "$TIMBER_TEST_METADATA_DIR"\n');
    await chmod(hook, 0o755);
    const result = await execa(process.execPath, ["--no-env-file", entry, "rebase", target, "--base", "refs/heads/alternate"], {
      cwd: primary, reject: false, timeout: 10_000,
      env: { CI: "true", TIMBER_TEST_METADATA_DIR: join(await git(target, "rev-parse", "--absolute-git-dir"), "timber") },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("base association could not be saved");
    expect(result.stderr).toContain(conflict ? "paused with conflicts" : "completed (or was already up to date)");
    expect(await readFile(file, "utf8")).toBe(record);
    expect(await git(primary, "rev-parse", "alternate")).toBe(incoming);
    if (conflict) {
      expect(result.stderr).toContain("rebase --continue");
      expect(await git(target, "diff", "--name-only", "--diff-filter=U")).toBe("tracked.txt");
      await git(target, "rebase", "--abort");
      expect(await git(target, "rev-parse", "HEAD")).toBe(original);
    } else {
      expect(await git(target, "rev-parse", "HEAD^")).toBe(incoming);
      expect(await readFile(join(target, "feature.txt"), "utf8")).toBe("feature\n");
    }
  });
});
