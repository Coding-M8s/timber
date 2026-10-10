import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface ChoiceOption {
  value: string;
  label: string;
}

export type TerminalChooser = (message: string, choices: readonly ChoiceOption[]) => Promise<string | null>;

const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

function escapeControl(character: string): string {
  if (character === "\b") return "\\b";
  if (character === "\t") return "\\t";
  if (character === "\n") return "\\n";
  if (character === "\f") return "\\f";
  if (character === "\r") return "\\r";
  return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
}

function safeText(value: string): string {
  return value.replace(controls, escapeControl);
}

function validateChoices(choices: readonly ChoiceOption[]): void {
  const values = new Set<string>();
  for (const choice of choices) {
    if (!choice.value || values.has(choice.value)) {
      throw new Error("Choice values must be non-empty and unique.");
    }
    values.add(choice.value);
  }
}

export function createTerminalChooser(input: Readable, output: Writable): TerminalChooser {
  return async (message, choices) => {
    validateChoices(choices);
    if (choices.length === 0) return null;

    const readline = createInterface({ input, crlfDelay: Infinity });
    let interrupted = false;
    const cancelOnInterrupt = () => {
      interrupted = true;
      readline.close();
    };
    readline.on("SIGINT", cancelOnInterrupt);
    // In cooked terminal mode, Ctrl-C signals the process rather than readline.
    process.on("SIGINT", cancelOnInterrupt);

    try {
      const lines = readline[Symbol.asyncIterator]();
      const ask = async (prompt: string): Promise<string | null> => {
        output.write(prompt);
        const next = await lines.next();
        if (next.done || interrupted || next.value.includes("\u0003")) return null;
        return next.value.trim();
      };
      const display = (expanded: boolean): void => {
        const visible = expanded ? choices : choices.slice(0, 5);
        for (const [index, choice] of visible.entries()) {
          output.write(`${index + 1}) ${safeText(choice.label)}\n`);
        }
        if (!expanded && choices.length > 5) output.write(`a) Show all ${choices.length} matches\n`);
        output.write("q) Cancel\n");
      };

      output.write(`${message.split("\n").map(safeText).join("\n")}\n`);
      let expanded = false;
      while (true) {
        display(expanded);
        const answer = await ask(expanded
          ? `Choose 1-${choices.length}, or q to cancel: `
          : `Choose 1-${Math.min(choices.length, 5)}${choices.length > 5 ? ", a to expand" : ""}, or q to cancel: `);
        if (answer === null || answer.toLowerCase() === "q" || answer === "\u001b") return null;
        if (!expanded && answer.toLowerCase() === "a" && choices.length > 5) {
          const confirmation = await ask(`This will display all ${choices.length} matches. Continue? [y/N] `);
          if (confirmation === null || confirmation.toLowerCase() === "q" || confirmation === "\u001b") return null;
          expanded = confirmation.toLowerCase() === "y";
          continue;
        }
        if (/^[1-9]\d*$/u.test(answer)) {
          const selected = Number(answer);
          const visibleCount = expanded ? choices.length : Math.min(choices.length, 5);
          if (selected <= visibleCount) return choices[selected - 1]!.value;
        }
        output.write("Invalid choice.\n");
      }
    } finally {
      process.removeListener("SIGINT", cancelOnInterrupt);
      readline.removeListener("SIGINT", cancelOnInterrupt);
      readline.close();
    }
  };
}

export function shouldEnableInteractiveSelection(environment: {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  ci?: string;
}): boolean {
  const continuousIntegration = environment.ci?.toLowerCase();
  return environment.stdinIsTTY && environment.stdoutIsTTY &&
    (continuousIntegration === undefined || continuousIntegration === "false");
}
