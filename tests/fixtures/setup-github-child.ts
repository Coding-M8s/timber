import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
console.log("CHILD_READY");
for await (const answer of input) {
  console.log(`CHILD_RESULT:${JSON.stringify({ tty: process.stdin.isTTY === true && process.stdin.isRaw !== true, answer })}`);
  input.close();
  break;
}
process.exit(7);
