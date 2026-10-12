import { writeFile } from "node:fs/promises";

const [mode, capture, ...args] = process.argv.slice(2);
if (!capture) throw new Error("missing agent capture");
await writeFile(capture, JSON.stringify({
  cwd: process.cwd(), args, pid: process.pid,
  stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true,
}));
if (mode === "exit") process.exit(Number(args[0] ?? 0));
if (mode === "delay") { await Bun.sleep(200); process.exit(0); }
if (mode === "signal") process.kill(process.pid, args[0] as NodeJS.Signals);
if (mode === "hold" || mode === "stdin") {
  process.stdout.write("AGENT_READY\n");
  if (mode === "stdin") {
    for await (const input of process.stdin) {
      process.stdout.write("AGENT_INPUT:" + input.toString());
      break;
    }
  } else {
    setInterval(() => {}, 1000);
  }
}

if (mode === "catch-interrupt") {
  let count = 0;
  const keepAlive = setInterval(() => {}, 1000);
  process.on("SIGINT", () => {
    process.stdout.write(`AGENT_INTERRUPT:${++count}\n`);
    if (count === 1) setTimeout(() => { clearInterval(keepAlive); process.exit(0); }, 100);
  });
  process.stdout.write("AGENT_READY\n");
}
