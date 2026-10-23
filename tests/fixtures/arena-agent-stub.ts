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
    taskId: process.env.TIMBER_TASK_ID ?? null,
    effort: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null,
    pid: process.pid,
  }) + "\n",
);
if (process.argv.at(-1) === "interrupt") process.kill(process.pid, "SIGINT");

if (process.argv.at(-1) === "nonzero") process.exit(17);
if (process.argv.at(-1) === "hold" || process.argv.at(-1) === "parent-terminate") {
  setInterval(() => {}, 1000);
  process.stdout.write("AGENT_READY\n");
  if (process.argv.at(-1) === "parent-terminate") process.kill(process.ppid, "SIGTERM");
}
