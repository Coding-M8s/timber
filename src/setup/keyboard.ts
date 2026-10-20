import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { searchChoices } from "../search";
import { safeDiagnostic } from "../display";
import { terminalStyle } from "../terminal-style";
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

function terminalSize(output: Writable): { width: number; rows: number } {
  const terminal = output as Writable & { columns?: number; rows?: number };
  return { width: Math.max(1, (terminal.columns ?? 80) - 1), rows: terminal.rows || 24 };
}

function wrapNotice(message: string, width: number): string[] {
  return message.trimEnd().split("\n").flatMap(line => {
    const lines: string[] = [];
    let current = "";
    let cells = 0;
    for (const { segment } of graphemes.segment(safeDiagnostic(line))) {
      const size = Bun.stringWidth(segment);
      if (cells + size > width && current) { lines.push(current); current = ""; cells = 0; }
      current += size > width ? "?" : segment;
      cells += Math.min(size, width);
    }
    lines.push(current);
    return lines;
  });
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
  let altScreen = false;
  let notices = "";
  let errors = "";
  const color = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
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
  const enterAlt = () => {
    if (altScreen) return;
    output.write("\u001b[?1049h\u001b[?25l");
    altScreen = true;
  };
  const leaveAlt = () => {
    if (!altScreen) return;
    output.write("\u001b[?25h\u001b[?1049l");
    altScreen = false;
  };
  const clear = () => {
    enterAlt();
    output.write("\u001b[H\u001b[2J\u001b[?25l");
  };
  const next = async (): Promise<Key | null> => {
    while (!queue.length && !ended) { await new Promise<void>(resolve => { wake = resolve; }); wake = undefined; }
    return cancelled ? null : queue.shift() ?? null;
  };
  const style = terminalStyle((output as Writable & { isTTY?: boolean }).isTTY === true);
  const title = (message: string, headingLines: readonly number[] = [], labelLines: readonly number[] = []) => {
    leaveAlt();
    const lines = message.split("\n").map((line, index) => {
      if (headingLines.includes(index)) return style.heading(line);
      const text = safeDiagnostic(line);
      const field = labelLines.includes(index) ? /^( *)([^ ]+)( +)(.*)$/u.exec(text) : null;
      return field ? `${field[1]}${style.label(field[2]!)}${field[3]}${field[4]}` : text;
    });
    output.write(`\n\n${lines.join("\n")}\n`);
  };
  const createFrame = (message: string, reservedRows: number) => {
    const { width, rows } = terminalSize(output);
    const [title = "", ...help] = message.split("\n");
    const wrappedTitle = wrapNotice(title, width);
    const titleHeight = Math.max(1, rows - reservedRows - 5);
    const titles = wrappedTitle.slice(0, titleHeight);
    const details = [notices.trim(), help.join("\n")].filter(Boolean).join("\n");
    const errorLines = errors.trim() ? wrapNotice(`ERROR: ${errors.trim()}`, Math.max(1, width - 2))
      .map(line => fitLine(`! ${line}`, width)) : [];
    const lines = [...errorLines, ...wrappedTitle.slice(titleHeight), ...(details.trim() ? wrapNotice(details, width) : [])];
    notices = errors = "";
    const height = Math.min(lines.length, Math.max(1, rows - reservedRows - titles.length - 4));
    const scrollable = lines.length > height;
    let first = 0;
    return {
      rows: 3 + titles.length + height + Number(scrollable),
      draw() {
        clear();
        output.write(`${fitLine("Timber setup", width)}\n${"─".repeat(Math.min(width, 40))}\n`);
        for (const line of titles) output.write(`${line}\n`);
        for (const [offset, line] of lines.slice(first, first + height).entries()) {
          const highlighted = color && first + offset < errorLines.length;
          output.write(highlighted
            ? `\u001b[1;37;41m${line}${" ".repeat(Math.max(0, width - Bun.stringWidth(line)))}\u001b[0m\n`
            : `${line}\n`);
        }
        if (scrollable) output.write(`${fitLine(`PgUp/PgDn details · ${first + 1}–${first + height}/${lines.length}`, width)}\n`);
        output.write("\n");
      },
      scroll(key: Key) {
        if (!scrollable || (key.name !== "pageup" && key.name !== "pagedown")) return false;
        first = Math.max(0, Math.min(lines.length - height, first + (key.name === "pageup" ? -height : height)));
        return true;
      },
    };
  };
  const readLine = async (message: string, frame?: ReturnType<typeof createFrame>, hidden = false): Promise<string | null> => {
    let value = "";
    let pasting = false;
    const drawMask = () => {
      const count = [...graphemes.segment(value)].length;
      const { width } = terminalSize(output);
      output.write(`\r\u001b[2K${fitLine(`› ${"*".repeat(Math.min(count, Math.max(0, width - 2)))}`, width)}`);
    };
    const draw = () => {
      if (!frame) { output.write(message); return; }
      frame.draw();
      output.write(`\u001b[?25h${fitLine(message, terminalSize(output).width)}\n› `);
      if (hidden && value) drawMask(); else if (!hidden) output.write(value);
    };
    draw();
    while (true) {
      const key = await next();
      if (key && frame?.scroll(key)) { draw(); continue; }
      if (hidden && key?.sequence === "\u001b[200~") { pasting = true; continue; }
      if (hidden && key?.sequence === "\u001b[201~") { pasting = false; continue; }
      if (key === null || key.name === "escape") return null;
      if (hidden && pasting && (key.name === "return" || key.name === "enter")) { value += "\n"; drawMask(); continue; }
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
            errors += "Extra pasted input discarded. Paste a single-line token and wait for each prompt.\n";
            return "";
          }
        }
        output.write("\n"); return value === "/cancel" ? null : value;
      }
      if (key.name === "backspace") {
        if (value) {
          value = hidden ? [...graphemes.segment(value)].slice(0, -1).map(part => part.segment).join("")
            : Array.from(value).slice(0, -1).join("");
          if (hidden) drawMask(); else output.write("\b \b");
        }
      } else if (!key.ctrl && !key.meta && key.sequence && !/[\u0000-\u001f\u007f-\u009f]/u.test(key.sequence)) {
        value += key.sequence;
        if (hidden) drawMask(); else output.write(key.sequence);
      }
    }
  };
  return {
    signal: controller.signal,
    notice(message, kind) { if (kind === "error") errors += message; else notices += message; },
    async select(message, choices, defaultValue, options) {
      if (options?.search) {
        title(message);
        const terminal = output as Writable & { columns?: number; rows?: number };
        const width = Math.max(1, (terminal.columns ?? 80) - 1);
        const height = Math.min(choices.length, Math.max(1, (terminal.rows || 24) - message.split("\n").length - 5));
        let query = options.query ?? "";
        let matches = searchChoices(query, choices);
        let selected = Math.max(0, matches.findIndex(choice => choice.value === defaultValue));
        let first = 0;
        const draw = (redraw: boolean) => {
          if (selected < first) first = selected;
          if (selected >= first + height) first = selected - height + 1;
          if (redraw) output.write(`\u001b[${height + 2}A`);
          output.write(`\r\u001b[2K${fitLine(`Search: ${safeDiagnostic(query)}`, width)}\n`);
          for (let row = 0; row < height; row++) {
            const choice = matches[first + row];
            const label = choice ? `${first + row === selected ? "›" : " "} ${safeDiagnostic(choice.label)}` : row === 0 && !matches.length ? "No matches" : "";
            output.write(`\r\u001b[2K${fitLine(label, width)}\n`);
          }
          output.write(`\r\u001b[2K${fitLine(`Type to search · ↑/↓ · Enter select · Esc cancel · ${matches.length} matches`, width)}\n`);
        };
        draw(false);
        while (true) {
          const key = await next();
          if (key === null || key.name === "escape") return null;
          if (key.name === "return" || key.name === "enter") {
            if (matches[selected]) return matches[selected]!.value;
            continue;
          }
          if (key.name === "up" || key.name === "down") {
            if (matches.length) selected = (selected + (key.name === "up" ? -1 : 1) + matches.length) % matches.length;
          } else {
            if (key.name === "backspace") query = Array.from(query).slice(0, -1).join("");
            else if (!key.ctrl && !key.meta && key.sequence && !/[\u0000-\u001f\u007f-\u009f]/u.test(key.sequence)) query += key.sequence;
            else continue;
            matches = searchChoices(query, choices);
            selected = 0; first = 0;
          }
          draw(true);
        }
      }
      const defaultIndex = choices.findIndex(choice => choice.value === defaultValue);
      if (defaultIndex < 0) throw new Error("Invalid setup default choice.");
      let selected = defaultIndex;
      const { width, rows } = terminalSize(output);
      const frame = createFrame(message, Math.min(choices.length, Math.max(1, Math.floor(rows / 2) - 1)) + 2);
      const visibleCount = Math.min(choices.length, Math.max(1, rows - frame.rows - 2));
      let first = 0;
      const draw = () => {
        frame.draw();
        if (selected < first) first = selected;
        if (selected >= first + visibleCount) first = selected - visibleCount + 1;
        choices.slice(first, first + visibleCount).forEach((choice, offset) => {
          const index = first + offset;
          const shortcut = index < 9 ? `${index + 1}) ` : "   ";
          const marker = index === selected ? "›" : " ";
          const label = `${marker} ${shortcut}${safeDiagnostic(choice.label)}${index === defaultIndex ? "  ← default" : ""}`;
          output.write(`\r\u001b[2K${fitLine(label, width)}\n`);
        });
        const position = visibleCount < choices.length ? ` · ${first + 1}–${first + visibleCount}/${choices.length}` : "";
        output.write(`\r\u001b[2K${fitLine(`↑/↓ move · 1-${Math.min(9, choices.length)} choose · Enter select · Esc cancel${position}`, width)}\n`);
      };
      draw();
      while (true) {
        const key = await next();
        if (key === null || key.name === "escape" || key.sequence?.toLowerCase() === "q") return null;
        if (frame.scroll(key)) { draw(); continue; }
        if (key.name === "return" || key.name === "enter") return choices[selected]!.value;
        if (key.name === "up" || key.name === "down") {
          selected = (selected + (key.name === "up" ? -1 : 1) + choices.length) % choices.length;
        } else if (/^[1-9]$/u.test(key.sequence ?? "")) {
          const index = Number(key.sequence) - 1;
          if (!choices[index]) continue;
          selected = index;
          return choices[selected]!.value;
        } else if (key.name === "backspace") selected = defaultIndex;
        else continue;
        draw();
      }
    },
    async text(message, defaultValue = "") {
      const frame = createFrame(`${message}${defaultValue ? `\nEnter to keep ${safeDiagnostic(defaultValue)}.` : ""}`, 3);
      const answer = await readLine("Type a value · /cancel to cancel", frame);
      return answer === "" ? defaultValue : answer;
    },
    async secret(message) {
      const frame = createFrame(message, 3);
      output.write("\u001b[?2004h");
      try { return await readLine("Input hidden · /cancel to cancel", frame, true); }
      finally { output.write("\u001b[?2004l"); }
    },
    async confirm(message, defaultValue, options) {
      if (options) {
        title(message, options?.headingLines, options?.labelLines);
        while (true) {
          const answer = await readLine(defaultValue ? "[Y/n] " : "[y/N] ");
          if (answer === null || answer.toLowerCase() === "q") return null;
          if (!answer.trim()) return defaultValue;
          if (["y", "yes"].includes(answer.trim().toLowerCase())) return true;
          if (["n", "no"].includes(answer.trim().toLowerCase())) return false;
          output.write("Enter yes or no.\n");
        }
      }
      const result = await this.select(message, [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ], defaultValue ? "yes" : "no");
      if (result === null) return null;
      return result === "yes";
    },
    close() {
      try { leaveAlt(); }
      finally {
        input.removeListener("keypress", keypress);
        input.removeListener("end", end);
        process.removeListener("SIGINT", cancel);
        input.setRawMode(wasRaw);
        if (!wasFlowing) input.pause();
      }
    },
  };
}
