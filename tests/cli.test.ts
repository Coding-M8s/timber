import { expect, test } from "bun:test";
import { execa } from "execa";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (...args: string[]) => execa(process.execPath, [entry, ...args], {
  reject: false, timeout: 5_000, env: { CI: "true" },
});

test("help succeeds on stdout and describes all implemented commands", async () => {
  const result = await cli("--help");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Usage: timber");
  for (const name of ["new", "open", "ls", "done"]) expect(result.stdout).toContain(name);
  expect(result.stdout).not.toContain("placeholder");
  expect(result.stdout).toContain("Open an existing branch or worktree");
});

test("no arguments displays help without waiting for input", async () => {
  const result = await cli();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage: timber");
  expect(result.stderr).toBe("");
});

test("done help describes safe cleanup and explicit preservation options", async () => {
  const result = await cli("done", "--help");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Remove a linked worktree");
  expect(result.stdout).toContain("published or integrated");
  expect(result.stdout).toContain("--keep-ignored");
  expect(result.stdout).toContain("--keep-branch");
  expect(result.stdout).toContain("Retain the local branch");
  expect(result.stdout).toContain("--discard-ignored");
  expect(result.stdout).not.toContain("--force");
  expect(result.stdout).not.toContain("placeholder");
});

test("new help describes implemented command and supported options", async () => {
  const result = await cli("new", "--help");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Create a worktree");
  expect(result.stdout).toContain("--base <ref>");
  expect(result.stdout).toContain("--no-editor");
  expect(result.stdout).toContain("configured Jira ticket IDs");
  expect(result.stdout).not.toContain("placeholder");
});

test("ls help describes a real read-only worktree command", async () => {
  const result = await cli("ls", "--help");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("List this repository's worktrees");
  expect(result.stdout).not.toContain("placeholder");
});

test("open help describes the implemented existing-target behavior", async () => {
  const result = await cli("open", "--help");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Open an existing branch or worktree");
  expect(result.stdout).toContain("--no-editor");
  expect(result.stdout).not.toContain("placeholder");
});

for (const args of [
  ["new"], ["open"], ["done"], ["unknown"], ["ls", "extra"],
  ["new", "one", "two"], ["done", "feature", "--force"],
  ["new", "feature", "--base"], ["ls", "--unknown"],
]) {
  test(`invalid invocation fails on stderr: ${args.join(" ")}`, async () => {
    const result = await cli(...args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error:");
    expect(result.stderr).not.toContain("not implemented");
  });
}
