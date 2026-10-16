import { createSetupPrompt } from "../../src/setup/terminal";
const initialRaw = process.stdin.isRaw === true;
const prompt = createSetupPrompt(process.stdin, process.stdout);
let length: number | null = null;
try { length = (await prompt.secret!("SYNTHETIC_SECRET_READY"))?.length ?? null; }
finally { prompt.close(); }
process.stdout.write(`RESULT:${JSON.stringify({ length, rawRestored: (process.stdin.isRaw === true) === initialRaw })}\n`);
