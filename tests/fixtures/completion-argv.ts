import { appendFile } from "node:fs/promises";

const output = process.env.TIMBER_ARGV_OUT;
if (!output) throw new Error("missing argv output path");
await appendFile(output, `${JSON.stringify(process.argv.slice(2))}\n`);
