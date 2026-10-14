import { createSetupPrompt } from "../../src/setup/terminal";

const original = process.stdin.isRaw === true;
const prompt = createSetupPrompt(process.stdin, process.stdout);
try {
  const selected = await prompt.select("Pick a number", Array.from({ length: 12 }, (_, index) => ({
    value: String(index + 1), label: `Choice ${index + 1}`,
  })), "1");
  const text = await prompt.text("A value with spaces", "");
  prompt.close();
  process.stdout.write(`RESULT:${JSON.stringify({ selected, text, rawRestored: (process.stdin.isRaw === true) === original })}\n`);
} finally { prompt.close(); }
