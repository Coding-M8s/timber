import { appendFile, readFile } from "node:fs/promises";
const taskFile = process.env.TIMBER_TASK_FILE!;
await appendFile(
  process.env.ARENA_CAPTURE!,
  JSON.stringify({
    task: await readFile(taskFile, "utf8"),
    taskFile,
    args: process.argv.slice(2),
    cwd: process.cwd(),
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    worktree: process.env.TIMBER_WORKTREE,
    workflow: process.env.TIMBER_WORKFLOW ?? null,
  }) + "\n",
);
if (process.argv.at(-1) === "interrupt") process.kill(process.pid, "SIGINT");
