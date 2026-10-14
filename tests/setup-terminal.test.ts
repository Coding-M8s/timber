import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createSetupPrompt } from "../src/setup/terminal";
import { createKeyboardPrompt } from "../src/setup/keyboard";

test("setup prompts keep pasted answers across questions and use selectable defaults", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let displayed = "";
  output.on("data", chunk => { displayed += chunk.toString(); });
  const prompt = createSetupPrompt(input, output);
  input.end('2\n["--flag"]\n\n');
  try {
    expect(await prompt.select("Editor", [{ value: "off", label: "Off" }, { value: "custom", label: "Custom" }], "off")).toBe("custom");
    expect(await prompt.text("Args", "[]")).toBe('["--flag"]');
    expect(await prompt.confirm("Enable agent?", false)).toBe(false);
    expect(await prompt.text("Next")).toBeNull();
    expect(prompt.signal?.aborted).toBe(true);
    expect(displayed).toContain("2) Custom");
    expect(displayed).toContain("\n\nEditor");
    expect(displayed).toContain("\n\nArgs");
  } finally { prompt.close(); }
});

test("Ctrl-C cancels prompts without executing later questions", async () => {
  const input = new PassThrough();
  const prompt = createSetupPrompt(input, new PassThrough());
  input.end("\u0003\n");
  try {
    expect(await prompt.text("Question")).toBeNull();
    expect(prompt.signal?.aborted).toBe(true);
  } finally { prompt.close(); }
});

test("keyboard menu rows fit narrow terminals including wide Unicode labels and navigation hints", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = Object.assign(new PassThrough(), { columns: 40 });
  let displayed = "";
  output.on("data", bytes => { displayed += bytes.toString(); });
  const prompt = createKeyboardPrompt(input, output);
  try {
    const answer = prompt.select("Choose", [
      { value: "skip", label: "Skip" }, { value: "wide", label: "界".repeat(30) },
    ], "skip");
    input.write("\u001b[B\r");
    expect(await answer).toBe("wide");
    const rows = [...displayed.matchAll(/\r\u001b\[2K([^\n]*)\n/gu)].map(match => match[1]!);
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(39);
    expect(rows.some(row => row.startsWith("› 2) 界"))).toBe(true);
  } finally { prompt.close(); }
});

test("number keys select immediately without consuming the next answer", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const prompt = createKeyboardPrompt(input, new PassThrough());
  try {
    input.end("2literal next answer\r\n");
    expect(await prompt.select("Editor", [{ value: "skip", label: "Skip" }, { value: "custom", label: "Custom" }], "skip"))
      .toBe("custom");
    expect(await prompt.text("Next")).toBe("literal next answer");
  } finally { prompt.close(); }
});

test("a lone number selects immediately even in a long menu", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const prompt = createKeyboardPrompt(input, new PassThrough());
  try {
    input.end("2");
    expect(await prompt.select("Branch", Array.from({ length: 12 }, (_, index) => ({
      value: String(index + 1), label: `Branch ${index + 1}`,
    })), "1")).toBe("2");
  } finally { prompt.close(); }
});

test("long menus keep the arrow-selected option visible within terminal height", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 12 });
  let displayed = "";
  output.on("data", bytes => { displayed += bytes.toString(); });
  const prompt = createKeyboardPrompt(input, output);
  try {
    const answer = prompt.select("Branch", Array.from({ length: 40 }, (_, index) => ({
      value: String(index + 1), label: `Branch ${index + 1}`,
    })), "1");
    input.end("\u001b[B".repeat(9) + "\r");
    expect(await answer).toBe("10");
    const lastDraw = displayed.split(/\u001b\[\d+A/u).at(-1)!;
    const rows = [...lastDraw.matchAll(/\r\u001b\[2K([^\n]*)\n/gu)].map(match => match[1]!);
    expect(rows.length).toBeLessThan(12);
    expect(rows.some(row => row.startsWith("› ") && row.includes("Branch 10"))).toBe(true);
    expect(rows.some(row => row.includes("Branch 40"))).toBe(false);
  } finally { prompt.close(); }
});
