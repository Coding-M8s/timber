import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigSource } from "../src/config";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

async function terminal(cwd: string, directory: string, args: string[], input: string, sendAt = "Enter select") {
  let output = ""; let sent = false;
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, "setup", ...args], {
    cwd, env: { ...process.env, CI: "false", HOME: directory,
      XDG_CONFIG_HOME: join(directory, "machine/config"), XDG_STATE_HOME: join(directory, "machine/state") },
    timeout: 5000,
    terminal: { data(terminal, bytes) {
      output += Buffer.from(bytes).toString("utf8");
      if (!sent && output.includes(sendAt)) { sent = true; terminal.write(input); }
    } },
  });
  try { return { code: await child.exited, output, sent }; }
  finally { child.kill(); child.terminal?.close(); }
}

test("real terminal setup accepts defaults, saves excluded local TOML, and preserves Git refs/index", async () => {
  await withRepository(async (primary, directory) => {
    const refs = await git(primary, "show-ref");
    const index = await readFile(join(primary, ".git/index"));
    const result = await terminal(primary, directory, [], "\n".repeat(4) + "1");
    expect(result.code).toBe(0);
    expect(result.sent).toBe(true);
    expect(result.output).toContain("Saved repository settings");
    expect(result.output).toContain("work ticket tracker");
    expect(result.output).not.toContain("alias");
    expect(parseConfigSource(await readFile(join(primary, ".timber.toml"), "utf8"), "test")).toEqual({});
    expect(await git(primary, "status", "--porcelain=v1")).toBe("");
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await readFile(join(primary, ".git/index"))).toEqual(index);
  });
});

test("arrow keys navigate setup choices and Enter confirms the highlighted item", async () => {
  await withRepository(async (primary, directory) => {
    const result = await terminal(primary, directory, [], "\u001b[A\u001b[B\u001b[A\r\r\u001b[A\r\r1");
    expect(result.code).toBe(0);
    expect(result.output).toContain("↑/↓");
    expect(parseConfigSource(await readFile(join(primary, ".timber.toml"), "utf8"), "test"))
      .toEqual({ editor: false, jira: false });
    expect(await git(primary, "status", "--porcelain=v1")).toBe("");
  });
});

test("number shortcuts advance immediately alongside arrows", async () => {
  await withRepository(async (primary, directory) => {
    const result = await terminal(primary, directory, [], "5\r\r\r1");
    expect(result.code).toBe(0);
    expect(parseConfigSource(await readFile(join(primary, ".timber.toml"), "utf8"), "test"))
      .toEqual({ editor: false });
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
    const result = await terminal(directory, directory, ["--global"], "\n".repeat(4) + "1");
    expect(result.code).toBe(0);
    expect(result.output).toContain("Saved machine defaults");
    expect(parseConfigSource(await readFile(join(directory, "machine/config/timber/config.toml"), "utf8"), "test")).toEqual({});
    expect(await git(primary, "status", "--porcelain=v1")).toBe("");
  });
});

test("review edits only the selected section and saves the revised draft in a real terminal", async () => {
  await withRepository(async (primary, directory) => {
    const result = await terminal(primary, directory, [], "\r".repeat(4) + "42" + "https://example.atlassian.net\r\r1");
    expect(result.code).toBe(0);
    expect(result.output).toContain("Saved repository settings");
    expect(parseConfigSource(await readFile(join(primary, ".timber.toml"), "utf8"), "test"))
      .toEqual({ jira: { site_url: "https://example.atlassian.net" } });
    expect(result.output.match(/Which editor should open/g)).toHaveLength(1);
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
    const result = await terminal(primary, directory, [], "\r".repeat(4) + "259");
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
