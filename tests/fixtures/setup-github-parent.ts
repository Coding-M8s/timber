import { execa } from "execa";
import { createKeyboardPrompt } from "../../src/setup/keyboard";
import { createGithubSetupSession } from "../../src/setup/github";
import { SetupCancelled } from "../../src/setup/types";

const initial = process.stdin.isRaw === true;
const prompt = createKeyboardPrompt(process.stdin, process.stdout);
const session = createGithubSetupSession({ env: {}, available: async () => true,
  check: async () => { throw new Error("No login"); },
  login: async () => {
    const child = await execa(process.execPath, ["--no-env-file", new URL("./setup-github-child.ts", import.meta.url).pathname], { stdio: "inherit", reject: false });
    if (child.signal || child.exitCode === 130) throw new SetupCancelled();
    return child.exitCode === 0;
  },
});
let answer: string | null = null;
let cancelled = false;
try {
  await session.edit(prompt, { stdout: text => process.stdout.write(text), stderr: text => process.stdout.write(text) });
  answer = await prompt.text("Parent resumed");
} catch (error) {
  if (!(error instanceof SetupCancelled)) throw error;
  cancelled = true;
} finally { prompt.close(); }
console.log(`PARENT_RESULT:${JSON.stringify({ answer, cancelled, rawRestored: (process.stdin.isRaw === true) === initial })}`);
