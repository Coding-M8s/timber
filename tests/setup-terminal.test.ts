import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createSetupPrompt } from "../src/setup/terminal";
import { createKeyboardPrompt } from "../src/setup/keyboard";
import { createSetupHandler } from "../src/commands/setup";
import { repositoryFixture } from "./helpers/services";
import type { SetupTarget } from "../src/setup/types";

test("errors stay prominent while correcting a field, including without color", async () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = Object.assign(new PassThrough(), { columns: 40, rows: 10 });
  let displayed = "";
  output.on("data", bytes => { displayed += bytes.toString(); });
  const prompt = createKeyboardPrompt(input, output);
  try {
    prompt.notice?.("Optional guidance\n".repeat(8));
    prompt.notice?.("Incorrect URL.\nUse HTTPS.\n", "error");
    const answer = prompt.text("Jira URL");
    input.write("corrected");
    await Bun.sleep(0);
    const screen = displayed.split("\u001b[2J").at(-1)!;
    expect(screen).toContain("! ERROR: Incorrect URL.");
    expect(screen).toContain("! Use HTTPS.");
    expect(screen.indexOf("! ERROR")).toBeLessThan(screen.indexOf("Type a value"));
    expect(screen).not.toMatch(/\u001b\[[0-9;]*m/u);
    expect(screen.split("\n").length).toBeLessThanOrEqual(10);
    input.write("\r");
    expect(await answer).toBe("corrected");
    const next = prompt.text("Next field");
    expect(displayed.split("\u001b[2J").at(-1)).not.toContain("ERROR");
    input.end("\r");
    await next;
  } finally {
    prompt.close();
    if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous;
  }
});

test("setup opens on its menu and returns directly after editing without summary or acknowledgement screens", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = new PassThrough(); let displayed = ""; let saved = false;
  output.on("data", bytes => { displayed += bytes.toString(); });
  const prompt = createKeyboardPrompt(input, output);
  const file = { path: "/repo/.timber.toml", source: null, values: {} };
  const target: SetupTarget = { scope: "repository", path: file.path, file,
    scopes: { local: file, global: { path: "/home/config.toml", source: null, values: {} } },
    repository: repositoryFixture(), branches: ["main"], tracked: false, exclude: null };
  const handler = createSetupHandler({ inspectTarget: async () => target, prompt: () => prompt,
    checkExecutable: async () => true, save: async () => { saved = true; },
    jira: () => ({ async edit() {}, review(io) { io.stdout("Personal credentials: remove example.atlassian.net (shared).\n"); },
      async save(publish) { await publish(); } }),
  });
  const running = handler({ global: false }, { cwd: "/repo", interactive: true,
    io: { stdout: text => output.write(text), stderr: text => output.write(text) } });
  try {
    await Bun.sleep(0);
    const screen = displayed.split("\u001b[2J").at(-1)!;
    expect(screen).toContain("Editor");
    expect(screen).toContain("Save");
    expect(screen).toContain("Personal credentials: remove");
    expect(saved).toBe(false);
    input.write("22\r"); // Editor → VS Code → automatic launch off → menu.
    await Bun.sleep(0);
    expect(saved).toBe(false);
    const updated = displayed.split("\u001b[2J").at(-1)!;
    expect(updated).toContain("Editor");
    expect(updated).toContain("code");
    expect(updated).toContain("Save");
    expect(displayed).not.toContain("Summary -");
    expect(displayed).not.toContain("Enter to continue");
    input.write("\r"); // Save remains the hub default.
    await running;
    expect(saved).toBe(true);
  } finally { input.end("\u0003"); await running; }
});

test("context stays on the input screen and can scroll without an acknowledgement step", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = Object.assign(new PassThrough(), { columns: 30, rows: 10 });
  let displayed = "";
  output.on("data", bytes => { displayed += bytes.toString(); });
  const prompt = createKeyboardPrompt(input, output);
  try {
    const link = "https://id.atlassian.com/manage-profile/security/api-tokens";
    prompt.notice?.(`${link}\n${"界".repeat(45)}\nLast information line\n`);
    const answer = prompt.text("Account email");
    await Bun.sleep(0);
    expect(displayed).toContain("Account email");
    expect(displayed).not.toContain("Enter to continue");
    expect(displayed).toContain("Type a value");
    const firstPage = displayed.split("\u001b[2J").at(-1)!;
    expect(firstPage.split("\n").length).toBeLessThanOrEqual(10);
    for (const line of firstPage.split("\n")) expect(Bun.stringWidth(line)).toBeLessThan(30);
    input.write("\u001b[6~".repeat(5));
    await Bun.sleep(0);
    const lastPage = displayed.split("\u001b[2J").at(-1)!;
    expect(lastPage).toContain("Last information line");
    expect(lastPage).toContain("Account email");
    input.write("person@example.invalid\r");
    expect(await answer).toBe("person@example.invalid");
  } finally { prompt.close(); }
});

test("scrolling menu details keeps Save visible without selecting it", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = Object.assign(new PassThrough(), { columns: 40, rows: 12 });
  let displayed = ""; let selected = false;
  output.on("data", bytes => { displayed += bytes.toString(); });
  const prompt = createKeyboardPrompt(input, output);
  try {
    prompt.notice?.("Pending credential changes\n".repeat(10) + "Last change\n");
    const answer = prompt.select("Settings", [{ value: "save", label: "Save and exit" },
      { value: "cancel", label: "Cancel" }], "save").then(value => { selected = true; return value; });
    input.write("\u001b[6~".repeat(10));
    await Bun.sleep(0);
    const screen = displayed.split("\u001b[2J").at(-1)!;
    expect(selected).toBe(false);
    expect(screen).toContain("Save and exit");
    expect(screen).toContain("Last change");
    expect(screen.split("\n").length).toBeLessThanOrEqual(12);
    input.write("\r");
    expect(await answer).toBe("save");
  } finally { prompt.close(); }
});

test("long questions reserve space for choices in a small terminal", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = Object.assign(new PassThrough(), { columns: 20, rows: 10 });
  let displayed = "";
  output.on("data", bytes => { displayed += bytes.toString(); });
  const prompt = createKeyboardPrompt(input, output);
  try {
    const answer = prompt.confirm("Wait for setup scripts to finish before starting the assistant? Choose no to start it alongside setup.", false);
    const screen = displayed.split("\u001b[2J").at(-1)!;
    expect(screen.split("\n").length).toBeLessThanOrEqual(10);
    expect(screen).toContain("Yes");
    expect(screen).toContain("No");
    input.write("\r");
    expect(await answer).toBe(false);
  } finally { prompt.close(); }
});

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
    displayed = "";
    const confirm = prompt.confirm("Check this draft login?", false);
    await new Promise(resolve => setImmediate(resolve));
    expect(displayed).toMatch(/! ERROR: Extra pasted input discarded/i);
    input.end("\r");
    expect(await confirm).toBe(false);
    expect(displayed).not.toContain("SYNTHETIC_TOKEN");
  } finally { prompt.close(); }
});

test("close restores raw mode even when leaving the alternate screen fails", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = new PassThrough();
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (String(chunk).includes("1049l")) throw new Error("Synthetic leave failure");
    return write(chunk, ...rest as []);
  }) as typeof output.write;
  const prompt = createKeyboardPrompt(input, output);
  try {
    const pending = prompt.select("Menu", [{ value: "a", label: "A" }], "a");
    input.write("\r");
    await pending;
  } finally {
    expect(() => prompt.close()).toThrow(/Synthetic leave failure/);
  }
  expect(input.isRaw).toBe(false);
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
    const lastDraw = displayed.split("\u001b[2J").at(-1)!;
    const rows = [...lastDraw.matchAll(/\r\u001b\[2K([^\n]*)\n/gu)].map(match => match[1]!);
    expect(rows.length).toBeLessThan(12);
    expect(rows.some(row => row.startsWith("› ") && row.includes("Branch 10"))).toBe(true);
    expect(rows.some(row => row.includes("Branch 40"))).toBe(false);
  } finally { prompt.close(); }
});

test("search picker treats q and digits as query text, ignores empty matches, and preserves later pasted answers", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = Object.assign(new PassThrough(), { columns: 38, rows: 9 });
  let displayed = "";
  output.on("data", bytes => { displayed += bytes.toString(); });
  const prompt = createKeyboardPrompt(input, output);
  try {
    const result = prompt.select("Model", [{ value: "a", label: "Qwen 3" }, { value: "b", label: "Other" }], "b", { search: true });
    input.end("zz\r\u007f\u007fq3\rnext\r");
    expect(await result).toBe("a");
    expect(await prompt.text("Next")).toBe("next");
    expect(displayed).toContain("No matches");
  } finally { prompt.close(); }
  expect(input.isRaw).toBe(false);
});
