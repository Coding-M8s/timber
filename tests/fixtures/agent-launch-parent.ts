import { readFile, writeFile } from "node:fs/promises";
import { launchAgent } from "../../src/agent";
import { worktreeFixture } from "../helpers/services";
import type { ExecutableCommand } from "../../src/types";

const [payloadPath, report] = process.argv.slice(2);
if (!payloadPath || !report) throw new Error("missing fixture paths");
const payload = JSON.parse(await readFile(payloadPath, "utf8")) as {
  cwd: string; command: ExecutableCommand; repeat?: number;
};
const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
const results = [];
for (let i = 0; i < (payload.repeat ?? 1); i++) {
  results.push(await launchAgent(worktreeFixture({ path: payload.cwd }), payload.command));
}
await writeFile(report, JSON.stringify({
  results, before, after: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
}));
const last = results.at(-1);
process.exitCode = last?.kind === "exited" ? last.exitCode : last?.kind === "failed" ? 1 : 0;
