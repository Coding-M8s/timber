import { readFile } from "node:fs/promises";
import { createArenaResumeHandler } from "../../src/commands/arena-resume";
import { discoverRepository } from "../../src/git/repository";
import { readArena, openArenaForResume, validateArenaAttempt } from "../../src/arena/storage";
import { checkExecutable } from "../../src/setup/executable";
import { runSetup } from "../../src/hooks";

const config = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const handler = createArenaResumeHandler({
  discoverRepository, loadConfig: async () => config, readArena, openArenaForResume,
  validateArenaAttempt, checkExecutable, runSetup,
  launchEditor: async () => {
    process.kill(process.pid, "SIGTERM");
    return await new Promise<never>(() => {});
  },
  launchAgent: async () => { throw new Error("Agent must never start during interrupted editor handoff"); },
});
await handler("demo", { attempt: "worker-1" }, {
  cwd: process.cwd(), interactive: true,
  io: { stdout(s) { process.stdout.write(s); }, stderr(s) { process.stderr.write(s); } },
});
