import { expect } from "bun:test";
import { tmpdir } from "node:os";
import { runCli } from "../../src/cli";

export async function candidates(line: string, cwd = tmpdir()): Promise<string[]> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["__complete", "--", line], {
    context: { cwd, io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } } },
  });
  expect(code).toBe(0);
  expect(stderr).toBe("");
  return stdout.split("\0").filter(Boolean);
}
