import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createSetupPrompt } from "../src/setup/terminal";
import { createKeyboardPrompt } from "../src/setup/keyboard";

test("secret entry hides pasted text and editing, preserves later answers, and restores raw mode", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = new PassThrough(); let displayed = "";
  output.on("data", bytes => { displayed += bytes.toString(); });
  const prompt = createKeyboardPrompt(input, output);
  try {
    const secret = prompt.secret!("API token (hidden)");
    input.write("SYNTHETIC_TOKENx\u007f\r\n");
    expect(await secret).toBe("SYNTHETIC_TOKEN");
    input.end("next\r");
    expect(await prompt.text("Next")).toBe("next");
    expect(displayed).not.toContain("SYNTHETIC_TOKEN");
    expect(displayed).not.toContain("TOKENx");
  } finally { prompt.close(); }
  expect(input.isRaw).toBe(false);
});

test("cancelling secret input restores terminal and non-TTY secret input fails closed", async () => {
  for (const cancel of ["\u001b", "\u0003", "\u0004"]) {
    const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
    const output = new PassThrough(); let displayed = "";
    output.on("data", bytes => { displayed += bytes.toString(); });
    const prompt = createKeyboardPrompt(input, output);
    try {
      const answer = prompt.secret!("Token");
      input.end("SYNTHETIC_TOKEN" + cancel);
      expect(await answer).toBeNull();
      expect(displayed).not.toContain("SYNTHETIC_TOKEN");
    } finally { prompt.close(); }
    expect(input.isRaw).toBe(false);
  }
  const prompt = createSetupPrompt(new PassThrough(), new PassThrough());
  try { await expect(prompt.secret!("Token")).rejects.toThrow(/terminal/); }
  finally { prompt.close(); }
});

test("bracketed multiline paste stays hidden until the paste ends and a rendering failure allows terminal restoration", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: true, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = new PassThrough(); let displayed = "";
  output.on("data", bytes => { displayed += bytes.toString(); });
  const prompt = createKeyboardPrompt(input, output);
  try {
    const answer = prompt.secret!("Hidden token");
    input.end("\u001b[200~SYNTHETIC\nMULTILINE\u001b[201~\r");
    expect(await answer).toBe("SYNTHETIC\nMULTILINE");
    expect(displayed).not.toContain("SYNTHETIC"); expect(displayed).not.toContain("MULTILINE");
  } finally { prompt.close(); }
  expect(input.isRaw).toBe(true);
  const broken = new PassThrough(); broken.write = () => { throw new Error("Synthetic output failure"); };
  const failingPrompt = createKeyboardPrompt(input, broken);
  try { await expect(failingPrompt.secret!("Token")).rejects.toThrow("Synthetic output failure"); }
  finally { failingPrompt.close(); }
  expect(input.isRaw).toBe(true);
});

test("unbracketed multiline secret paste cannot echo leftover fragments in later prompts", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = new PassThrough(); let displayed = "";
  output.on("data", bytes => { displayed += bytes.toString(); });
  const prompt = createKeyboardPrompt(input, output);
  try {
    const secret = prompt.secret!("Token");
    input.end("SYNTHETIC_FIRST\nSYNTHETIC_SECOND\n");
    await secret;
    await prompt.confirm("Check?", false);
    expect(displayed).not.toContain("SYNTHETIC_FIRST");
    expect(displayed).not.toContain("SYNTHETIC_SECOND");
  } finally { prompt.close(); }
});

test("delayed unbracketed paste after secret Enter is rejected before the next visible prompt", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = new PassThrough(); let displayed = "";
  output.on("data", bytes => { displayed += bytes.toString(); });
  const prompt = createKeyboardPrompt(input, output);
  try {
    const secret = prompt.secret!("Token");
    input.write("SYNTHETIC_TOKEN\r");
    // Arrives after one setImmediate but inside the quiet drain window.
    await new Promise(resolve => setTimeout(resolve, 15));
    input.write("y");
    expect(await secret).toBe("");
    expect(displayed).toMatch(/Extra pasted input discarded/i);
    const confirm = prompt.confirm("Check this draft login?", false);
    input.end("\r");
    expect(await confirm).toBe(false);
    expect(displayed).not.toContain("SYNTHETIC_TOKEN");
  } finally { prompt.close(); }
});

test("Escape aborts an in-flight connection check while arrows do not cancel setup", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const prompt = createKeyboardPrompt(input, new PassThrough());
  try {
    input.write("\u001b[B");
    expect(prompt.signal?.aborted).toBe(false);
    input.write("\u001b");
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(prompt.signal?.aborted).toBe(true);
  } finally { prompt.close(); }
});

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
