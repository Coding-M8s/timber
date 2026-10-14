import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { safeDiagnostic } from "../display";
import type { SetupPrompt } from "./types";

export type RawInput = Readable & { setRawMode(mode: boolean): unknown; isRaw?: boolean };
interface Key { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function fitLine(text: string, cells: number): string {
  if (Bun.stringWidth(text) <= cells) return text;
  let clipped = "";
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    const next = Bun.stringWidth(segment);
    if (width + next > cells - 1) break;
    clipped += segment;
    width += next;
  }
  return clipped + "…";
}

/** Keyboard menus own raw mode only while setup runs and restore it on close. */
export function createKeyboardPrompt(input: RawInput, output: Writable): SetupPrompt {
  const wasFlowing = input.readableFlowing === true;
  emitKeypressEvents(input);
  const wasRaw = input.isRaw === true;
  const controller = new AbortController();
  const queue: Key[] = [];
  let ended = false;
  let cancelled = false;
  let wake: (() => void) | undefined;
  let lastWasReturn = false;
  const cancel = () => { cancelled = true; ended = true; controller.abort(); wake?.(); };
  const keypress = (text: string | undefined, key: Key) => {
    if (key.ctrl && (key.name === "c" || key.name === "d")) { cancel(); return; }
    // Pasted CRLF is one Enter, just like readline's cooked input adapter.
    if (lastWasReturn && key.sequence === "\n") { lastWasReturn = false; return; }
    lastWasReturn = key.sequence === "\r";
    queue.push({ ...key, sequence: key.sequence ?? text ?? "" });
    wake?.();
  };
  const end = () => { ended = true; controller.abort(); wake?.(); };
  input.on("keypress", keypress);
  input.on("end", end);
  process.on("SIGINT", cancel);
  input.setRawMode(true);
  input.resume();
  const next = async (): Promise<Key | null> => {
    while (!queue.length && !ended) { await new Promise<void>(resolve => { wake = resolve; }); wake = undefined; }
    return cancelled ? null : queue.shift() ?? null;
  };
  const title = (message: string) => output.write(`\n\n${message.split("\n").map(safeDiagnostic).join("\n")}\n`);
  const readLine = async (message: string): Promise<string | null> => {
    output.write(message);
    let value = "";
    while (true) {
      const key = await next();
      if (key === null || key.name === "escape") return null;
      if (key.name === "return" || key.name === "enter") { output.write("\n"); return value === "/cancel" ? null : value; }
      if (key.name === "backspace") {
        if (value) { value = Array.from(value).slice(0, -1).join(""); output.write("\b \b"); }
      } else if (!key.ctrl && !key.meta && key.sequence && !/[\u0000-\u001f\u007f-\u009f]/u.test(key.sequence)) {
        value += key.sequence;
        output.write(key.sequence);
      }
    }
  };
  return {
    signal: controller.signal,
    async select(message, choices, defaultValue) {
      const defaultIndex = choices.findIndex(choice => choice.value === defaultValue);
      if (defaultIndex < 0) throw new Error("Invalid setup default choice.");
      title(message);
      let selected = defaultIndex;
      let digits = "";
      const width = Math.max(1, ((output as Writable & { columns?: number }).columns ?? 80) - 1);
      const draw = (redraw: boolean) => {
        if (redraw) output.write(`\u001b[${choices.length + 1}A`);
        choices.forEach((choice, index) => {
          const label = `${index === selected ? "›" : " "} ${index + 1}) ${safeDiagnostic(choice.label)}${index === defaultIndex ? " (default)" : ""}`;
          output.write(`\r\u001b[2K${fitLine(label, width)}\n`);
        });
        output.write(`\r\u001b[2K${fitLine(`↑/↓ or 1-${choices.length} · Enter select · Esc cancel`, width)}\n`);
      };
      draw(false);
      while (true) {
        const key = await next();
        if (key === null || key.name === "escape" || key.sequence?.toLowerCase() === "q") return null;
        if (key.name === "return" || key.name === "enter") {
          if (digits && (Number(digits) < 1 || Number(digits) > choices.length)) { digits = ""; continue; }
          return choices[selected]!.value;
        }
        if (key.name === "up" || key.name === "down") {
          digits = "";
          selected = (selected + (key.name === "up" ? -1 : 1) + choices.length) % choices.length;
        } else if (/^\d$/u.test(key.sequence ?? "")) {
          digits += key.sequence;
          const index = Number(digits) - 1;
          if (choices[index]) selected = index;
        } else if (key.name === "backspace") { digits = ""; selected = defaultIndex; }
        else continue;
        draw(true);
      }
    },
    async text(message, defaultValue = "") {
      title(message);
      const answer = await readLine(`${defaultValue ? `Enter to keep ${safeDiagnostic(defaultValue)}. ` : ""}(/cancel to cancel): `);
      return answer === "" ? defaultValue : answer;
    },
    async confirm(message, defaultValue) {
      title(message);
      while (true) {
        const answer = await readLine(defaultValue ? "[Y/n] " : "[y/N] ");
        if (answer === null || answer.toLowerCase() === "q") return null;
        if (!answer.trim()) return defaultValue;
        if (["y", "yes"].includes(answer.trim().toLowerCase())) return true;
        if (["n", "no"].includes(answer.trim().toLowerCase())) return false;
        output.write("Enter yes or no.\n");
      }
    },
    close() {
      input.removeListener("keypress", keypress);
      input.removeListener("end", end);
      process.removeListener("SIGINT", cancel);
      input.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
    },
  };
}
