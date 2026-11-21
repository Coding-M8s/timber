import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
type Sample = {
  variant: keyof typeof binaries; command: string; milliseconds: number; gitProcesses: number; peakGitProcesses: number;
};
// Most Git processes alive at once, from Trace2 start/exit times. Trace2 times are
// fixed-width UTC with microseconds, which Date.parse would cut to milliseconds, so
// compare the strings. Exits sort before starts at the same instant, so ties never inflate the count.
function peakGitProcesses(events: { event: string; time: string }[]): number {
  const timeline = events.filter(event => event.event === "start" || event.event === "exit")
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0) || (a.event === "exit" ? -1 : 1));
  let running = 0;
  let peak = 0;
  for (const event of timeline) {
    running += event.event === "start" ? 1 : -1;
    peak = Math.max(peak, running);
  }
  return peak;
}
const scenarios: {
  worktrees: number; trackedFiles: number; untrackedFilesPerSibling: number; ignoredFilesPerWorktree: number;
  siblingMetadata: boolean; samples: Sample[];
}[] = [];
// The 20,000 ignored files scenario puts a large ignored folder (like node_modules) in every worktree.
// The last scenario gives every sibling a saved base and issue link and runs only ls.
const layouts = [
  ...[2, 8].flatMap(worktrees => [0, 1000].map(trackedFiles => ({ worktrees, trackedFiles, ignoredFiles: 0, siblingMetadata: false }))),
  { worktrees: 8, trackedFiles: 0, ignoredFiles: 20_000, siblingMetadata: false },
  { worktrees: 32, trackedFiles: 0, ignoredFiles: 0, siblingMetadata: true },
];
try {
  for (const { worktrees, trackedFiles, ignoredFiles, siblingMetadata } of layouts) {
    const directory = join(root, `trees-${worktrees}-files-${trackedFiles}-ignored-${ignoredFiles}-metadata-${siblingMetadata}`);
    const primary = join(directory, "repo");
    const target = join(directory, "target");
    await mkdir(primary, { recursive: true });
    await git(primary, ["init", "-b", "trunk"]);
    await writeFile(join(primary, ".gitignore"), ".timber.toml\nnode_modules/\n");
    for (let i = 0; i < trackedFiles; i++) await writeFile(join(primary, `tracked-${i}.txt`), `fixture ${i}\n`);
    await git(primary, ["add", "."]);
    await git(primary, ["commit", "-m", "benchmark fixture"]);
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n');
    await git(primary, ["worktree", "add", "-b", "target", target]);
    for (let i = 2; i < worktrees; i++) {
      const sibling = join(directory, `sibling-${i}`);
      await git(primary, ["worktree", "add", "-b", `sibling-${i}`, sibling]);
      for (let j = 0; j < trackedFiles; j++) await writeFile(join(sibling, `untracked-${j}.txt`), "sibling fixture\n");
      if (siblingMetadata) {
        // No benchmark command touches sibling metadata, so it is written once.
        const worktreeGitDir = await realpath(await git(sibling, ["rev-parse", "--absolute-git-dir"]));
        const identity = { worktreePath: await realpath(sibling),
          commonGitDir: await realpath(await git(primary, ["rev-parse", "--path-format=absolute", "--git-common-dir"])), worktreeGitDir };
        await mkdir(join(worktreeGitDir, "timber"), { recursive: true, mode: 0o700 });
        await writeFile(join(worktreeGitDir, "timber", "base.json"),
          JSON.stringify({ version: 1, ref: "refs/heads/trunk", ...identity }) + "\n", { mode: 0o600 });
        await writeFile(join(worktreeGitDir, "timber", "issue.json"), JSON.stringify({ version: 1, tracker: "github", key: String(i),
          url: `https://github.com/example/benchmark/issues/${i}`, ...identity }) + "\n", { mode: 0o600 });
      }
    }
    const fillIgnored = async (tree: string) => {
      for (let folder = 0; folder < ignoredFiles / 100; folder++) {
        const path = join(tree, "node_modules", `package-${folder}`);
        await mkdir(path, { recursive: true });
        await Promise.all(Array.from({ length: 100 }, (_, file) => writeFile(join(path, `file-${file}.js`), "ignored\n")));
      }
    };
    for (const tree of (await git(primary, ["worktree", "list", "--porcelain"])).split("\n")
      .filter(line => line.startsWith("worktree ")).map(line => line.slice("worktree ".length))) await fillIgnored(tree);
    const trace = join(directory, "trace.jsonl");
    const allCommands: Record<string, string[]> = {
      open: ["open", "target", "--no-editor", "--no-agent"],
      new: ["new", "fresh", "--base", "trunk", "--no-editor", "--no-agent"],
      done: ["done", "target", "--base", "trunk", "--keep-branch"],
      rebase: ["rebase", "target", "--base", "refs/heads/trunk"],
      ls: ["ls"],
      "ls-json": ["ls", "--json"],
    };
    const commands: Record<string, string[]> = siblingMetadata
      ? { ls: allCommands.ls!, "ls-json": allCommands["ls-json"]! } : allCommands;
    if (siblingMetadata) {
      // Without valid fixtures the numbers would measure the invalid-metadata path instead.
      for (const variant of Object.keys(binaries) as (keyof typeof binaries)[]) {
        const listed = JSON.parse((await execa(binaries[variant], ["ls", "--json"], { cwd: primary, env: environment })).stdout);
        const siblings = listed.worktrees.filter((row: { path: string }) => /sibling-\d+$/u.test(row.path));
        if (siblings.length !== worktrees - 2 || !siblings.every((row: { base: { kind: string }; issue: { kind: string } }) =>
          row.base.kind === "assigned" && row.issue.kind === "linked")) {
          throw new Error(`${variant} does not read the sibling metadata fixtures as assigned and linked.`);
        }
      }
    }
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
        gitProcesses: events.filter(event => event.event === "start").length, peakGitProcesses: peakGitProcesses(events) });
      if (job.command === "new") {
        await git(primary, ["worktree", "remove", join(directory, "repo-worktrees", "fresh")]);
        await git(primary, ["branch", "-D", "fresh"]);
      } else if (job.command === "done") {
        await git(primary, ["worktree", "add", target, "target"]);
        await fillIgnored(target);
      }
    }
    scenarios.push({ worktrees, trackedFiles, untrackedFilesPerSibling: trackedFiles, ignoredFilesPerWorktree: ignoredFiles,
      siblingMetadata, samples });
    process.stderr.write(`Measured ${worktrees} worktrees, ${trackedFiles} tracked files, ${ignoredFiles} ignored files per worktree, ${siblingMetadata ? "sibling metadata, " : ""}${repetitions} repetitions.\n`);
  }
  process.stdout.write(JSON.stringify({ platform: `${process.platform} ${process.arch}`, bun: Bun.version,
    git: await git(root, ["--version"]), repetitions, randomSeed: 108, binaries,
    timing: "Warm caches, one excluded warmup per command/variant/scenario; randomized order; Git Trace2 enabled during timing. Local synthetic repositories, no remotes. Rebase is already up to date; done retains its branch. Primary and target base and workflow metadata start absent for each run; in the siblingMetadata scenario every sibling keeps a saved base and issue link. peakGitProcesses is the most Git processes alive at once in one run, including status reads, measured inside Git by Trace2, so it leaves out process start and exit and undercounts very short processes.",
    scenarios }, null, 2) + "\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
