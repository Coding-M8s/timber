import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";

// Only disposable repositories below the fresh temporary root are mutated.
const [baselineInput, candidateInput, repetitionsInput = "7"] = process.argv.slice(2);
const repetitions = Number(repetitionsInput);
if (!baselineInput || !candidateInput || !Number.isSafeInteger(repetitions) || repetitions < 3) {
  throw new Error("Usage: bun scripts/benchmark-worktree-reads.ts <baseline-cli> <candidate-cli> [repetitions >= 3]");
}
const binaries = { baseline: resolve(baselineInput), candidate: resolve(candidateInput) };
const root = await mkdtemp(join(tmpdir(), "timber-worktree-benchmark-"));
const environment = {
  ...process.env, CI: "true", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(root, "no-global-config"), XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"), GIT_AUTHOR_NAME: "Timber Benchmark", GIT_COMMITTER_NAME: "Timber Benchmark",
  GIT_AUTHOR_EMAIL: "benchmark@example.invalid", GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
};
const git = async (cwd: string, args: string[]) => (await execa("git", args, { cwd, env: environment })).stdout;
let seed = 108;
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}
type Sample = { variant: keyof typeof binaries; command: string; milliseconds: number; gitProcesses: number };
const scenarios: { worktrees: number; trackedFiles: number; untrackedFilesPerSibling: number; samples: Sample[] }[] = [];
try {
  for (const worktrees of [2, 8]) for (const trackedFiles of [0, 1000]) {
    const directory = join(root, `trees-${worktrees}-files-${trackedFiles}`);
    const primary = join(directory, "repo");
    const target = join(directory, "target");
    await mkdir(primary, { recursive: true });
    await git(primary, ["init", "-b", "trunk"]);
    await writeFile(join(primary, ".gitignore"), ".timber.toml\n");
    for (let i = 0; i < trackedFiles; i++) await writeFile(join(primary, `tracked-${i}.txt`), `fixture ${i}\n`);
    await git(primary, ["add", "."]);
    await git(primary, ["commit", "-m", "benchmark fixture"]);
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n');
    await git(primary, ["worktree", "add", "-b", "target", target]);
    for (let i = 2; i < worktrees; i++) {
      const sibling = join(directory, `sibling-${i}`);
      await git(primary, ["worktree", "add", "-b", `sibling-${i}`, sibling]);
      for (let j = 0; j < trackedFiles; j++) await writeFile(join(sibling, `untracked-${j}.txt`), "sibling fixture\n");
    }
    const trace = join(directory, "trace.jsonl");
    const commands: Record<string, string[]> = {
      open: ["open", "target", "--no-editor", "--no-agent"],
      new: ["new", "fresh", "--base", "trunk", "--no-editor", "--no-agent"],
      done: ["done", "target", "--base", "trunk", "--keep-branch"],
      rebase: ["rebase", "target", "--base", "refs/heads/trunk"],
      ls: ["ls"],
    };
    const samples: Sample[] = [];
    const jobs = Object.keys(binaries).flatMap(variant => Object.keys(commands).map(command => ({
      variant: variant as keyof typeof binaries, command,
    })));
    for (let repeat = -1; repeat < repetitions; repeat++) for (const job of shuffle([...jobs])) {
      // Keep metadata identical across variants and repetitions, outside the timer.
      for (const tree of [primary, target]) {
        const admin = await git(tree, ["rev-parse", "--absolute-git-dir"]);
        await mkdir(join(admin, "timber"), { recursive: true, mode: 0o700 });
        await chmod(join(admin, "timber"), 0o700);
        for (const file of ["base.json", "workflow.json"]) await rm(join(admin, "timber", file), { force: true });
      }
      await writeFile(trace, "");
      const started = performance.now();
      const result = await execa(binaries[job.variant], commands[job.command]!, {
        cwd: primary, env: { ...environment, GIT_TRACE2_EVENT: trace }, reject: false, timeout: 30_000,
      });
      const milliseconds = performance.now() - started;
      if (result.exitCode !== 0) throw new Error(`${job.variant} ${job.command} failed: ${result.stderr}`);
      const events = (await readFile(trace, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      if (repeat >= 0) samples.push({ ...job, milliseconds,
        gitProcesses: events.filter(event => event.event === "start").length });
      if (job.command === "new") {
        await git(primary, ["worktree", "remove", join(directory, "repo-worktrees", "fresh")]);
        await git(primary, ["branch", "-D", "fresh"]);
      } else if (job.command === "done") await git(primary, ["worktree", "add", target, "target"]);
    }
    scenarios.push({ worktrees, trackedFiles, untrackedFilesPerSibling: trackedFiles, samples });
    process.stderr.write(`Measured ${worktrees} worktrees, ${trackedFiles} tracked files, ${repetitions} repetitions.\n`);
  }
  process.stdout.write(JSON.stringify({ platform: `${process.platform} ${process.arch}`, bun: Bun.version,
    git: await git(root, ["--version"]), repetitions, randomSeed: 108, binaries,
    timing: "Warm caches, one excluded warmup per command/variant/scenario; randomized order; Git Trace2 enabled during timing. Local synthetic repositories, no remotes. Rebase is already up to date; done retains its branch. Metadata starts absent for each run.",
    scenarios }, null, 2) + "\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
