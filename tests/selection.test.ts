import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { createTerminalChooser, shouldEnableInteractiveSelection } from "../src/selection";

const choices = Array.from({ length: 8 }, (_, index) => ({
  value: `stable-${index + 1}`,
  label: `Branch feature/${index + 1}`,
}));

async function choose(inputText: string, options = choices, message = "Several branches match.") {
  const input = new PassThrough();
  const output: string[] = [];
  const display = new Writable({
    write(chunk, _encoding, callback) {
      output.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      callback();
    },
  });
  const pending = createTerminalChooser(input, display)(message, options);
  input.end(inputText);
  return { value: await pending, screen: output.join("") };
}

function menuLines(screen: string): string[] {
  // Stream fixtures do not echo Enter; remove prompts to recover menu line boundaries.
  return screen.replace(/Choose [^\n]+: |This will display all \d+ matches\. Continue\? \[y\/N\] /gu, "\n")
    .split("\n").filter(line => /^ *(?:\d+|[aq])\) /u.test(line));
}

test.each([9, 10, 99, 100])("aligns collapsed and expanded labels for %i choices", async count => {
  const options = Array.from({ length: count }, (_, index) => ({
    value: `stable-${index + 1}`, label: `Option ${index + 1}`,
  }));
  const result = await choose(`a\ny\n${count}\n`, options);
  const lines = menuLines(result.screen);
  const width = String(count).length;
  expect(result.value).toBe(`stable-${count}`);
  expect(lines.slice(0, 5).map(line => line.trimStart())).toEqual(
    options.slice(0, 5).map((choice, index) => `${index + 1}) ${choice.label}`));
  expect(lines[5]?.trimStart()).toBe(`a) Show all ${count} matches`);
  expect(lines[6]?.trimStart()).toBe("q) Cancel");
  expect(lines.slice(7, -1).map(line => line.trimStart())).toEqual(
    options.map((choice, index) => `${index + 1}) ${choice.label}`));
  expect(lines.at(-1)?.trimStart()).toBe("q) Cancel");
  for (const line of lines) expect(line.indexOf(") ") + 2).toBe(width + 2);
});

test("declined expansion and invalid answers retain three-digit padding and five choices", async () => {
  const options = Array.from({ length: 100 }, (_, index) => ({
    value: `stable-${index + 1}`, label: `Option ${index + 1}`,
  }));
  const result = await choose("a\nn\n10\n0\n101\n1\n", options);
  expect(result.value).toBe("stable-1");
  expect(result.screen.match(/Invalid choice\./gu)).toHaveLength(3);
  expect(result.screen).not.toContain("Option 6");
  for (const line of menuLines(result.screen)) expect(line.indexOf(") ") + 2).toBe(5);
});

test("cancels a padded menu or its expansion confirmation without choosing", async () => {
  const options = Array.from({ length: 100 }, (_, index) => ({
    value: `stable-${index + 1}`, label: `界e\u0301 ${index + 1}\n\u001b[2J`,
  }));
  for (const input of ["q\n", "a\nq\n", "a\n", "\u001b\n", "\u0003\n", ""]) {
    const result = await choose(input, options);
    expect(result.value).toBeNull();
    expect(result.screen).toContain("  1) 界e\u0301 1\\n\\u001b[2J");
    expect(result.screen).not.toContain("\u001b[2J");
  }
});

test("empty choices cancel without printing or waiting", async () => {
  expect(await choose("", [])).toEqual({ value: null, screen: "" });
});

test("shows five initial suggestions and returns the stable value for a numeric choice", async () => {
  const result = await choose("3\n");

  expect(result.value).toBe("stable-3");
  expect(result.screen).toContain("Several branches match.");
  expect(result.screen).toContain("1) Branch feature/1");
  expect(result.screen).toContain("5) Branch feature/5");
  expect(result.screen).not.toContain("Branch feature/6");
  expect(result.screen).toContain("a) Show all 8 matches");
});

test("preserves prompt line breaks while escaping other terminal controls", async () => {
  const result = await choose("q\n", choices, "Issue is complete.\nDid you mean one of these?\u001b[2J");

  expect(result.screen).toStartWith("Issue is complete.\nDid you mean one of these?\\u001b[2J\n1) ");
  expect(result.screen).not.toContain("\\n");
});

test("expands to all suggestions only after warning and confirmation", async () => {
  const result = await choose("a\ny\n8\n");

  expect(result.value).toBe("stable-8");
  expect(result.screen).toContain("This will display all 8 matches. Continue? [y/N]");
  expect(result.screen).toContain("8) Branch feature/8");
});

test("declining expansion returns to the five suggestions without printing the rest", async () => {
  const result = await choose("a\nn\n2\n");

  expect(result.value).toBe("stable-2");
  expect(result.screen).toContain("This will display all 8 matches. Continue? [y/N]");
  expect(result.screen).not.toContain("Branch feature/6");
});

test("q, Escape, Ctrl-C, and EOF cancel without selecting an option", async () => {
  for (const inputText of ["q\n", "\u001b\n", "\u0003\n", ""]) {
    expect((await choose(inputText)).value).toBeNull();
  }
});

test("selection and cancellation restore the process SIGINT listeners", async () => {
  const listeners = process.listeners("SIGINT");
  for (const input of ["1\n", "q\n", "\u0003\n", ""]) {
    await choose(input);
    expect(process.listeners("SIGINT")).toEqual(listeners);
  }
});

test("invalid numeric answers are rejected and labels cannot inject terminal controls", async () => {
  const result = await choose("9\n1\n", [{ value: "worktree:/unsafe", label: "Worktree /tmp/a\u001b[2J\nsecond row" }]);

  expect(result.value).toBe("worktree:/unsafe");
  expect(result.screen).toContain("Invalid choice");
  expect(result.screen).toContain("/tmp/a\\u001b[2J\\nsecond row");
  expect(result.screen.replace(/\n/gu, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
});

test("rejects empty or duplicate stable choice values", async () => {
  await expect(choose("1\n", [{ value: "", label: "one" }])).rejects.toThrow(/choice values/i);
  await expect(choose("1\n", [
    { value: "same", label: "one" }, { value: "same", label: "two" },
  ])).rejects.toThrow(/choice values/i);
});

test.each([
  ["both streams are TTYs and CI is unset", true, true, undefined, true],
  ["both streams are TTYs and CI is false", true, true, "false", true],
  ["CI is enabled", true, true, "true", false],
  ["stdin is not a TTY", false, true, undefined, false],
  ["stdout is not a TTY", true, false, undefined, false],
] as const)("interactive selection gate: %s", (_name, stdinIsTTY, stdoutIsTTY, ci, expected) => {
  expect(shouldEnableInteractiveSelection({
    stdinIsTTY, stdoutIsTTY, ...(ci === undefined ? {} : { ci }),
  })).toBe(expected);
});

test("Enter selects an explicitly designated default without accepting deletion", async () => {
  const options = [
    { value: "cancel", label: "No, keep worktree", default: true },
    { value: "delete", label: "Yes, delete anyway" },
  ];
  expect((await choose("\n", options)).value).toBe("cancel");
});
