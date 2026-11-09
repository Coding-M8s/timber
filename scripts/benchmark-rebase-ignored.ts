import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

// Whole CLI rebases in disposable repositories. Only preserveIgnored differs
// between source snapshots; CLI startup, Git, status and index construction are timed.
const baseline = process.argv[2];
const repetitions = Number(process.argv[3] ?? 9);
if (!baseline || !Number.isSafeInteger(repetitions) || repetitions < 1) {
  throw new Error("Usage: bun --no-env-file scripts/benchmark-rebase-ignored.ts <baseline-ref> [repetitions=9]");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "timber-rebase-benchmark-"));
const env = {
  ...process.env, CI: "true", HOME: temporary,
  XDG_CONFIG_HOME: join(temporary, "config"), XDG_STATE_HOME: join(temporary, "state"),
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Timber Benchmark", GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
  GIT_COMMITTER_NAME: "Timber Benchmark", GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
  GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true",
};
async function git(cwd: string, ...args: string[]) {
  return (await execa("git", args, { cwd, env, stdin: "ignore" })).stdout;
}
function preservation(source: string) {
  const start = source.indexOf("async function preserveIgnored(");
  const end = source.indexOf("\nasync function localBase(", start);
  if (start < 0 || end < 0) throw new Error("Cannot locate baseline preservation function.");
  return source.slice(start, end);
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

try {
  const oldSource = await git(root, "show", `${baseline}:src/git/rebase.ts`);
  const source = await readFile(join(root, "src/git/rebase.ts"), "utf8");
  const oldPreservation = preservation(oldSource);
  if (oldPreservation === preservation(source)) throw new Error("Baseline and current preservation functions are identical.");
  for (const variant of ["before", "after"]) {
    const snapshot = join(temporary, variant);
    await cp(join(root, "src"), join(snapshot, "src"), { recursive: true });
    await cp(join(root, "package.json"), join(snapshot, "package.json"));
    await symlink(join(root, "node_modules"), join(snapshot, "node_modules"), "dir");
    if (variant === "before") {
      await writeFile(join(snapshot, "src/git/rebase.ts"), source.replace(preservation(source), oldPreservation));
    }
  }
  await mkdir(join(temporary, "state/timber"), { recursive: true });
  await writeFile(join(temporary, "state/timber/setup-hint-shown"), "1\n");
  const scenarios = [
    { commits: 1, files: 100, ignored: 10 },
    { commits: 5, files: 1000, ignored: 100 },
    { commits: 10, files: 10000, ignored: 100 },
  ];
  console.log(JSON.stringify({ baseline, repetitions, platform: process.platform, arch: process.arch, bun: Bun.version, git: await git(root, "--version") }));
  for (const scenario of scenarios) {
    const directory = join(temporary, `fixture-${scenario.files}`);
    const primary = join(directory, "primary");
    await mkdir(join(primary, "shared/tree"), { recursive: true });
    await git(primary, "init", "-b", "main");
    for (let i = 0; i < scenario.files; i++) {
      await writeFile(join(primary, "shared/tree", `tracked-${i.toString().padStart(5, "0")}`), "tracked\n");
    }
    await git(primary, "add", ".");
    await git(primary, "commit", "-m", "initial tracked files");
    const fork = await git(primary, "rev-parse", "HEAD");
    const seed = join(directory, "seed");
    await git(primary, "worktree", "add", "-b", "seed", seed, fork);
    for (let i = 0; i < scenario.commits; i++) {
      await writeFile(join(seed, "feature.txt"), `feature ${i}\n`);
      await git(seed, "add", "feature.txt");
      await git(seed, "commit", "-m", `feature ${i}`);
    }
    const original = await git(seed, "rev-parse", "HEAD");
    await git(primary, "worktree", "remove", seed);
    await writeFile(join(primary, "incoming.txt"), "incoming base\n");
    await git(primary, "add", "incoming.txt");
    await git(primary, "commit", "-m", "advance base");
    const base = await git(primary, "rev-parse", "HEAD");
    await writeFile(join(primary, ".git/info/exclude"), "shared/tree/ignored-*\n");
    const samples: Record<string, number[]> = { before: [], after: [] };
    // One unrecorded warm-up per variant, then alternating paired repetitions.
    for (let round = -1; round < repetitions; round++) {
      for (const variant of round % 2 === 0 ? ["after", "before"] : ["before", "after"]) {
        const branch = `${variant}-${round + 1}`;
        const target = join(directory, branch);
        await git(primary, "worktree", "add", "-b", branch, target, original);
        for (let i = 0; i < scenario.ignored; i++) {
          await writeFile(join(target, "shared/tree", `ignored-${i}`), "private ignored bytes\n");
        }
        const started = performance.now();
        await execa(process.execPath, ["--no-env-file", join(temporary, variant, "src/index.ts"), "rebase", target, "--base", "refs/heads/main"], {
          cwd: primary, env, stdin: "ignore", timeout: 120_000,
        });
        const elapsed = performance.now() - started;
        // Verify an actual rewrite and preservation, outside the measured window.
        if (await git(target, "rev-parse", `HEAD~${scenario.commits}`) !== base
          || await git(target, "rev-parse", "HEAD") === original
          || await git(target, "status", "--porcelain=v1") !== "") throw new Error("Rebase verification failed.");
        for (let i = 0; i < scenario.ignored; i++) {
          if (await readFile(join(target, "shared/tree", `ignored-${i}`), "utf8") !== "private ignored bytes\n") throw new Error("Ignored content changed.");
        }
        if (round >= 0) samples[variant]!.push(elapsed);
        await git(primary, "worktree", "remove", "--force", target);
        await git(primary, "branch", "-D", branch);
      }
    }
    console.log(JSON.stringify({ ...scenario, samples, medianMs: { before: median(samples.before!), after: median(samples.after!) } }));
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
