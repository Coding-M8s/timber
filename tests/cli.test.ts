import { expect, test } from "bun:test";
import { execa } from "execa";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (...args: string[]) => execa(process.execPath, [entry, ...args], {
  reject: false, timeout: 5_000, env: { CI: "true" },
});

test("help succeeds on stdout and names every explicit placeholder", async () => {
  const result = await cli("--help");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Usage: timber");
  for (const name of ["new", "open", "ls", "done"]) expect(result.stdout).toContain(name);
  expect(result.stdout.match(/placeholder/g)?.length).toBe(4);
});

test("no arguments displays help without waiting for input", async () => {
  const result = await cli();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage: timber");
  expect(result.stderr).toBe("");
});

for (const [command, args, ticket] of [
  ["new", ["feature"], "TIM-12"], ["open", ["feature"], "TIM-13"],
  ["ls", [], "TIM-14"], ["done", ["feature"], "TIM-15"],
] as const) {
  test(`${command} placeholder fails honestly without claiming success`, async () => {
    const result = await cli(command, ...args);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not implemented");
    expect(result.stderr).toContain(ticket);
    expect(result.stderr).not.toContain(" at ");
  });
  test(`${command} help succeeds`, async () => {
    const result = await cli(command, "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("placeholder");
  });
}

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
