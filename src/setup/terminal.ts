import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { safeDiagnostic } from "../display";
import type { SetupPrompt } from "./types";
import { createKeyboardPrompt } from "./keyboard";
import type { RawInput } from "./keyboard";

/** One readline lifetime preserves buffered/pasted answers between questions. */
export function createSetupPrompt(input: Readable, output: Writable): SetupPrompt {
  const terminalInput = input as RawInput & { isTTY?: boolean };
  if (terminalInput.isTTY && (output as Writable & { isTTY?: boolean }).isTTY
    && typeof terminalInput.setRawMode === "function") return createKeyboardPrompt(terminalInput, output);
  const readline = createInterface({ input, crlfDelay: Infinity });
  const controller = new AbortController();
  const queued: string[] = [];
  let ended = false;
  let interrupted = false;
  let wake: (() => void) | undefined;
  readline.on("line", line => { queued.push(line); wake?.(); });
  readline.on("close", () => { ended = true; controller.abort(); wake?.(); });
  const cancel = () => { interrupted = true; controller.abort(); readline.close(); wake?.(); };
  readline.on("SIGINT", cancel);
  process.on("SIGINT", cancel);
  const ask = async (message: string): Promise<string | null> => {
    if (interrupted || (ended && queued.length === 0)) return null;
    output.write(message);
    while (queued.length === 0 && !ended && !interrupted) {
      await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
    }
    if (interrupted || queued.length === 0) return null;
    const answer = queued.shift()!;
    if (answer.includes("\u0003") || answer === "\u001b" || answer === "/cancel") {
      cancel();
      return null;
    }
    return answer;
  };
  return {
    signal: controller.signal,
    async select(message, choices, defaultValue) {
      if (!choices.some(choice => choice.value === defaultValue)) throw new Error("Invalid setup default choice.");
      output.write(`\n\n${message.split("\n").map(safeDiagnostic).join("\n")}\n`);
      choices.forEach((choice, index) => output.write(`${index + 1}) ${safeDiagnostic(choice.label)}${choice.value === defaultValue ? " (default)" : ""}\n`));
      while (true) {
        const answer = await ask("Choose a number, Enter for default, or q to cancel: ");
        if (answer === null || answer.trim().toLowerCase() === "q") return null;
        if (!answer.trim()) return defaultValue;
        const index = /^[1-9]\d*$/u.test(answer.trim()) ? Number(answer.trim()) - 1 : -1;
        if (choices[index]) return choices[index]!.value;
        output.write("Invalid choice.\n");
      }
    },
    async text(message, defaultValue = "") {
      const answer = await ask(`\n\n${safeDiagnostic(message)}${defaultValue ? ` [${safeDiagnostic(defaultValue)}]` : ""} (/cancel to cancel): `);
      return answer === "" ? defaultValue : answer;
    },
    async secret() { throw new Error("Secret input requires an interactive terminal with raw input support; no credentials were read or saved."); },
    async confirm(message, defaultValue) {
      while (true) {
        const answer = await ask(`\n\n${safeDiagnostic(message)} ${defaultValue ? "[Y/n]" : "[y/N]"} `);
        if (answer === null) return null;
        const normalized = answer.trim().toLowerCase();
        if (!normalized) return defaultValue;
        if (["y", "yes"].includes(normalized)) return true;
        if (["n", "no"].includes(normalized)) return false;
        if (normalized === "q") return null;
        output.write("Enter yes or no.\n");
      }
    },
    close() {
      process.removeListener("SIGINT", cancel);
      readline.removeListener("SIGINT", cancel);
      readline.close();
    },
  };
}
