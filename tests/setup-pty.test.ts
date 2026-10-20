import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigSource } from "../src/config";
import { git, withRepository } from "./helpers/git";
import { loadSavedCredentials } from "../src/jira/credentials";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("real setup saves a pasted token outside Git without echoing it", async () => {
  await withRepository(async (primary, directory) => {
    // Hub → Jira (4) → configure (2) → site → unscoped → replace credentials (2) → email
    const result = await terminal(primary, directory, [],
      "42https://example.atlassian.net\r\r2person@example.invalid\r", "SYNTHETIC_PASTED_TOKEN");
    expect(result.code).toBe(0);
    expect(result.output).toContain("Saved repository settings");
    expect(result.output).not.toContain("SYNTHETIC_PASTED_TOKEN");
    expect(await loadSavedCredentials({ siteUrl: "https://example.atlassian.net" }, {
      HOME: directory, XDG_CONFIG_HOME: join(directory, "machine/config"),
    })).toEqual({ email: "person@example.invalid", token: "SYNTHETIC_PASTED_TOKEN" });
    expect(await git(primary, "status", "--porcelain=v1")).toBe("");
  });
});

for (const [input, length] of [["SYNTHETIC_TOKEN\r", 15], ["SYNTHETIC_TOKEN\u001b", null], ["SYNTHETIC_TOKEN\u0003", null]] as const) {
  test(`real secret prompt hides paste and restores terminal (result length ${length}, input ${input.at(-1)?.charCodeAt(0)})`, async () => {
    const fixture = fileURLToPath(new URL("./fixtures/setup-secret-parent.ts", import.meta.url));
    let output = ""; let sent = false;
    const child = Bun.spawn([process.execPath, "--no-env-file", fixture], { timeout: 3000,
      terminal: { data(terminal, bytes) {
        output += Buffer.from(bytes).toString("utf8");
        if (!sent && output.includes("Input hidden")) { sent = true; terminal.write(input); }
      } },
    });
    try {
      expect(await child.exited).toBe(0);
      expect(output).not.toContain("SYNTHETIC_TOKEN");
      expect(JSON.parse(output.match(/RESULT:(.*)/u)![1]!)).toEqual({ length, rawRestored: true });
    } finally { child.kill(); child.terminal?.close(); }
  });
}

async function terminal(cwd: string, directory: string, args: string[], input: string, secret?: string) {
  let output = ""; let sent = false;
  let remaining = input; let scanned = 0; let answeredHeader = "";
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, "setup", ...args], {
    cwd, env: { ...process.env, NO_COLOR: undefined, TERM: "xterm-256color", CI: "false", HOME: directory,
      XDG_CONFIG_HOME: join(directory, "machine/config"), XDG_STATE_HOME: join(directory, "machine/state") },
    timeout: 5000,
    terminal: { data(terminal, bytes) {
      output += Buffer.from(bytes).toString("utf8");
      const markers = /Enter select|Type a value|Input hidden/gu;
      markers.lastIndex = scanned;
      let marker: RegExpExecArray | null;
      while ((marker = markers.exec(output))) {
        scanned = markers.lastIndex;
        const screen = output.lastIndexOf("\u001b[2J", marker.index);
        const prefix = output.slice(screen, marker.index);
        const menu = prefix.indexOf("\r\u001b[2K");
        const header = menu < 0 ? prefix : prefix.slice(0, menu);
        if (marker[0] === "Enter select" && header === answeredHeader) continue;
        answeredHeader = header;
        if (marker[0] === "Input hidden" && secret) {
          terminal.write(`${secret}\r`);
          remaining = "\r1"; // Skip the optional check, then save at the hub.
          continue;
        }
        if (!remaining) continue;
        let length: number;
        if (marker[0] === "Type a value" || remaining.startsWith("\u001b[")) {
          const end = remaining.search(/[\r\n]/u);
          length = end < 0 ? remaining.length : end + 1;
        } else length = remaining.startsWith("q\n") ? 2 : 1;
        const answer = remaining.slice(0, length);
        remaining = remaining.slice(length);
        sent = true;
        terminal.write(answer);
      }
    } },
  });
  try { return { code: await child.exited, output, sent }; }
  finally { child.kill(); child.terminal?.close(); }
}

test("real terminal setup accepts defaults, saves excluded local TOML, and preserves Git refs/index", async () => {
  await withRepository(async (primary, directory) => {
    const refs = await git(primary, "show-ref");
    const index = await readFile(join(primary, ".git/index"));
    const result = await terminal(primary, directory, [], "1");
    expect(result.code).toBe(0);
    expect(result.sent).toBe(true);
    expect(result.output).toContain("Saved repository settings");
    expect(result.output).toContain("Timber setup");
    expect(result.output).toContain("Settings -");
    expect(result.output).not.toContain("Summary -");
    expect(result.output).not.toContain("Enter to continue");
    expect(parseConfigSource(await readFile(join(primary, ".timber.toml"), "utf8"), "test")).toEqual({});
    expect(await git(primary, "status", "--porcelain=v1")).toBe("");
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await readFile(join(primary, ".git/index"))).toEqual(index);
  });
});

test("arrow keys navigate setup choices and Enter confirms the highlighted item", async () => {
  await withRepository(async (primary, directory) => {
    // Hub → editor → Down/Up to None → hub → Jira → Down/Up to None → save
    const result = await terminal(primary, directory, [], "2\u001b[B\u001b[A\r4\u001b[B\u001b[A\r1");
    expect(result.code).toBe(0);
    expect(result.output).toContain("↑/↓");
    expect(parseConfigSource(await readFile(join(primary, ".timber.toml"), "utf8"), "test"))
      .toEqual({});
    expect(await git(primary, "status", "--porcelain=v1")).toBe("");
  });
});

test("number shortcuts advance immediately alongside arrows", async () => {
  await withRepository(async (primary, directory) => {
    // Hub editor (2) → none (1) → save (1)
    const result = await terminal(primary, directory, [], "211");
    expect(result.code).toBe(0);
    expect(parseConfigSource(await readFile(join(primary, ".timber.toml"), "utf8"), "test"))
      .toEqual({});
  });
});

test("long keyboard menus support arrows and preserve literal text and terminal mode", async () => {
  await withRepository(async (primary, directory) => {
    const fixture = fileURLToPath(new URL("./fixtures/setup-prompt-parent.ts", import.meta.url));
    let output = ""; let sent = false;
    const child = Bun.spawn([process.execPath, fixture], {
      cwd: primary, env: { ...process.env }, timeout: 3000,
      terminal: { data(terminal, bytes) {
        output += Buffer.from(bytes).toString("utf8");
        if (!sent && output.includes("Enter select")) {
          sent = true;
          terminal.write("\u001b[B".repeat(11) + "\r\nhello wörld 'quotes'\r\n");
        }
      } },
    });
    try {
      expect(await child.exited).toBe(0);
      const result = JSON.parse(output.match(/RESULT:(.*)/u)![1]!);
      expect(result).toEqual({ selected: "12", text: "hello wörld 'quotes'", rawRestored: true });
    } finally { child.kill(); child.terminal?.close(); }
  });
});

test("global setup saves outside Git in a real terminal", async () => {
  await withRepository(async (primary, directory) => {
    const result = await terminal(directory, directory, ["--global"], "1");
    expect(result.code).toBe(0);
    expect(result.output).toContain("Saved machine defaults");
    expect(parseConfigSource(await readFile(join(directory, "machine/config/timber/config.toml"), "utf8"), "test")).toEqual({});
    expect(await git(primary, "status", "--porcelain=v1")).toBe("");
  });
});

test("review edits only the selected section and saves the revised draft in a real terminal", async () => {
  await withRepository(async (primary, directory) => {
    // Hub → Jira → configure → site → unscoped → keep credentials (1) → save (1)
    const result = await terminal(primary, directory, [], "42https://example.atlassian.net\r\r11");
    expect(result.code).toBe(0);
    expect(result.output).toContain("Saved repository settings");
    expect(parseConfigSource(await readFile(join(primary, ".timber.toml"), "utf8"), "test"))
      .toEqual({ jira: { site_url: "https://example.atlassian.net" } });
    expect(result.output).not.toContain("Which editor should open");
    expect(await git(primary, "status", "--porcelain=v1")).toBe("");
  });
});

test("cancelling from review after an edit preserves existing files, exclusions, and index", async () => {
  await withRepository(async (primary, directory) => {
    const configPath = join(primary, ".timber.toml");
    await writeFile(configPath, 'remote = "upstream"\n');
    const exclude = await readFile(join(primary, ".git/info/exclude"));
    const index = await readFile(join(primary, ".git/index"));
    const refs = await git(primary, "show-ref");
    // Hub → editor → none → cancel with q
    const result = await terminal(primary, directory, [], "21q");
    expect(result.code).toBe(0);
    expect(result.output).toContain("Cancelled.");
    expect(await readFile(configPath, "utf8")).toBe('remote = "upstream"\n');
    expect(await readFile(join(primary, ".git/info/exclude"))).toEqual(exclude);
    expect(await readFile(join(primary, ".git/index"))).toEqual(index);
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

for (const input of ["\u0003", "\u0004", "q\n"]) {
  test(`terminal cancellation ${JSON.stringify(input)} leaves configuration/exclusions/index untouched`, async () => {
    await withRepository(async (primary, directory) => {
      const configPath = join(primary, ".timber.toml");
      await writeFile(configPath, 'remote = "upstream"\n');
      const exclude = await readFile(join(primary, ".git/info/exclude"));
      const index = await readFile(join(primary, ".git/index"));
      const result = await terminal(primary, directory, [], input);
      expect(result.code).toBe(0);
      expect(result.output).toContain("Cancelled.");
      expect(await readFile(configPath, "utf8")).toBe('remote = "upstream"\n');
      expect(await readFile(join(primary, ".git/info/exclude"))).toEqual(exclude);
      expect(await readFile(join(primary, ".git/index"))).toEqual(index);
    });
  });
}
