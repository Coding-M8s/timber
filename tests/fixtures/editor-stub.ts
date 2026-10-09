import { writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";

const [mode, capturePath, heartbeatPath, ...args] = process.argv.slice(2);
if (!mode || !capturePath || !heartbeatPath) throw new Error("invalid test fixture input");

await writeFile(capturePath, JSON.stringify({ args, cwd: process.cwd() }));

if (mode === "late-failure") {
  process.on("exit", () => writeFileSync(heartbeatPath, "late-failure-exited"));
  await Bun.sleep(100);
  process.exit(7);
}

if (mode === "linger") {
  await Bun.sleep(750);
  const parentPidArgument = args.find((argument) => argument.startsWith("--parent-pid="));
  let heartbeat = "alive";
  if (parentPidArgument) {
    const parentPid = Number(parentPidArgument.slice("--parent-pid=".length));
    try {
      process.kill(parentPid, 0);
      heartbeat = "parent-alive";
    } catch {
      heartbeat = "parent-exited";
    }
  }
  await writeFile(heartbeatPath, heartbeat);
  await Bun.sleep(750);
  await writeFile(`${heartbeatPath}.finished`, "finished");
}
