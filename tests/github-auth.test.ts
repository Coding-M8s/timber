import { expect, test } from "bun:test";
import { readGithubToken } from "../src/github/auth";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("GitHub auth uses explicit precedence without fallback on blank or bad tokens", async () => {
  const signal = new AbortController().signal;
  const run = async () => { throw new Error("must not invoke gh"); };
  expect(await readGithubToken(signal, { env: { GH_TOKEN: "first", GITHUB_TOKEN: "second" }, run })).toBe("first");
  expect(await readGithubToken(signal, { env: { GITHUB_TOKEN: "second" }, run })).toBe("second");
  for (const token of ["", " ", "bad\ntoken"]) {
    await expect(readGithubToken(signal, { env: { GH_TOKEN: token, GITHUB_TOKEN: "second" }, run })).rejects.toThrow("nonblank");
  }
});

test.skipIf(process.platform === "win32")("real gh subprocess gets literal host arguments and sanitized environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber-gh-auth-"));
  try {
    const executable = join(directory, "gh");
    await writeFile(executable, '#!/bin/sh\n[ "$*" = "auth token --hostname github.com" ] || exit 2\n[ "$GH_PROMPT_DISABLED" = 1 ] || exit 3\n[ -z "$GH_DEBUG" ] || exit 4\nprintf "SYNTHETIC_GH_TOKEN\\n"\n');
    await chmod(executable, 0o700);
    expect(await readGithubToken(new AbortController().signal, { env: { PATH: directory, GH_DEBUG: "api" } })).toBe("SYNTHETIC_GH_TOKEN");
    await writeFile(executable, '#!/bin/sh\nprintf "PRIVATE_ERROR" >&2\nexit 1\n');
    try { await readGithubToken(new AbortController().signal, { env: { PATH: directory } }); throw new Error("expected rejection"); }
    catch (error) { expect(String(error)).toContain("timber setup"); expect(String(error)).not.toContain("PRIVATE_ERROR"); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stored gh token is captured privately for the fixed host and failures are sanitized", async () => {
  const signal = new AbortController().signal;
  let argumentsUsed: readonly string[] = [];
  expect(await readGithubToken(signal, { env: {}, run: async (args) => { argumentsUsed = args; return "secret-token\n"; } })).toBe("secret-token");
  expect(argumentsUsed).toEqual(["auth", "token", "--hostname", "github.com"]);
  try {
    await readGithubToken(signal, { env: {}, run: async () => { throw new Error("secret-token raw transport"); } });
    throw new Error("expected refusal");
  } catch (error) {
    expect(String(error)).toContain("timber setup");
    expect(String(error)).not.toContain("secret-token");
    expect(String(error)).not.toContain("raw transport");
  }
});
