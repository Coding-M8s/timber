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
    if (key.name === "escape" && key.sequence === "\u001b") { cancel(); return; }
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
  const readLine = async (message: string, hidden = false): Promise<string | null> => {
    output.write(message);
    let value = "";
    let pasting = false;
    while (true) {
      const key = await next();
      if (hidden && key?.sequence === "\u001b[200~") { pasting = true; continue; }
      if (hidden && key?.sequence === "\u001b[201~") { pasting = false; continue; }
      if (key === null || key.name === "escape") return null;
      if (hidden && pasting && (key.name === "return" || key.name === "enter")) { value += "\n"; continue; }
      if (key.name === "return" || key.name === "enter") {
        if (hidden) {
          // Unbracketed paste may arrive in later PTY chunks after Enter. Drain
          // until the queue stays idle; never hand a burst tail to a visible prompt.
          const quietMs = 75;
          const sliceMs = 10;
          let contaminated = false;
          let idleUntil = Date.now() + quietMs;
          while (Date.now() < idleUntil) {
            if (queue.length) {
              contaminated = true;
              queue.length = 0;
              idleUntil = Date.now() + quietMs;
            }
            const wait = Math.min(sliceMs, Math.max(0, idleUntil - Date.now()));
            if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
          }
          if (queue.length) { contaminated = true; queue.length = 0; }
          if (contaminated) {
            output.write("\nExtra pasted input discarded. Paste a single-line token and wait for each prompt.\n");
            return "";
          }
        }
        output.write("\n"); return value === "/cancel" ? null : value;
      }
      if (key.name === "backspace") {
        if (value) { value = Array.from(value).slice(0, -1).join(""); if (!hidden) output.write("\b \b"); }
      } else if (!key.ctrl && !key.meta && key.sequence && !/[\u0000-\u001f\u007f-\u009f]/u.test(key.sequence)) {
        value += key.sequence;
        if (!hidden) output.write(key.sequence);
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
      const terminal = output as Writable & { columns?: number; rows?: number };
      const width = Math.max(1, (terminal.columns ?? 80) - 1);
      const visibleCount = Math.min(choices.length, Math.max(1, (terminal.rows || 24) - message.split("\n").length - 4));
      let first = 0;
      const draw = (redraw: boolean) => {
        if (selected < first) first = selected;
        if (selected >= first + visibleCount) first = selected - visibleCount + 1;
        if (redraw) output.write(`\u001b[${visibleCount + 1}A`);
        choices.slice(first, first + visibleCount).forEach((choice, offset) => {
          const index = first + offset;
          const shortcut = index < 9 ? `${index + 1}) ` : "   ";
          const label = `${index === selected ? "›" : " "} ${shortcut}${safeDiagnostic(choice.label)}${index === defaultIndex ? " (default)" : ""}`;
          output.write(`\r\u001b[2K${fitLine(label, width)}\n`);
        });
        const position = visibleCount < choices.length ? ` · ${first + 1}–${first + visibleCount}/${choices.length}` : "";
        output.write(`\r\u001b[2K${fitLine(`↑/↓ · 1-${Math.min(9, choices.length)} choose now · Enter select · Esc cancel${position}`, width)}\n`);
      };
      draw(false);
      while (true) {
        const key = await next();
        if (key === null || key.name === "escape" || key.sequence?.toLowerCase() === "q") return null;
        if (key.name === "return" || key.name === "enter") return choices[selected]!.value;
        if (key.name === "up" || key.name === "down") {
          selected = (selected + (key.name === "up" ? -1 : 1) + choices.length) % choices.length;
        } else if (/^[1-9]$/u.test(key.sequence ?? "")) {
          const index = Number(key.sequence) - 1;
          if (!choices[index]) continue;
          selected = index;
          draw(true);
          return choices[selected]!.value;
        } else if (key.name === "backspace") selected = defaultIndex;
        else continue;
        draw(true);
      }
    },
    async text(message, defaultValue = "") {
      title(message);
      const answer = await readLine(`${defaultValue ? `Enter to keep ${safeDiagnostic(defaultValue)}. ` : ""}(/cancel to cancel): `);
      return answer === "" ? defaultValue : answer;
    },
    async secret(message) {
      title(message);
      output.write("\u001b[?2004h");
      try { return await readLine("Input hidden (/cancel to cancel): ", true); }
      finally { output.write("\u001b[?2004l"); }
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
