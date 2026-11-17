import { expect, test } from "bun:test";
import { execa } from "execa";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { placeholderHandlers, runCli } from "../src/cli";
import { candidates } from "./helpers/completion";
import { withArena } from "./helpers/arena";
import { git } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const runner = fileURLToPath(new URL("./helpers/pty-runner.py", import.meta.url));

test("pick CLI normalizes options and propagates partial-cleanup status", async () => {
  let received: unknown; let stderr = "";
  const context = { cwd: "/repo", io: { stdout(_s: string) {}, stderr(s: string) { stderr += s; } } };
  const handlers = { ...placeholderHandlers, arenaPick: async (...args: unknown[]) => { received = args; return 1; } };
  expect(await runCli(["arena", "pick", "demo", "--winner", "manual-1", "--keep-branch", "--keep-ignored"], { context, handlers })).toBe(1);
  expect(received).toEqual(["demo", { winner: "manual-1", keepBranch: true, keepIgnored: true }, context]);
  for (const removed of ["--force", "--base"])
    expect(await runCli(["arena", "pick", "demo", removed, "x"], { context, handlers })).toBe(1);
  expect(stderr).toContain("unknown option");
});

test("pick help and completion expose inspection and preservation options", async () => {
  expect(await candidates("timber arena ")).toEqual(["help", "new", "pick", "resume"]);
  expect(await candidates("timber arena pick demo --win")).toEqual(["--winner"]);
  const result = await execa(process.execPath, [entry, "arena", "pick", "--help"]);
  for (const text of ["BETA", "incomplete", "--inspect", "--winner", "--keep-ignored", "RAM", "refs/timber/arena", "workspace", "nonzero"])
    expect(result.stdout).toContain(text);
});

test("real CLI inspection and exact winner selection work unattended without launching tools", async () => {
  await withArena(async f => {
    const [winner, loser] = f.manifest.attempts;
    const before = await git(f.primary, "show-ref");
    const inspect = await execa(process.execPath, [entry, "arena", "pick", "demo", "--inspect"], { cwd: f.primary, env: { CI: "1" } });
    expect(inspect.stdout).toContain("Beta"); expect(inspect.stdout).toContain("incomplete");
    expect(inspect.stdout).toContain(winner!.label); expect(inspect.stdout).not.toContain("PRIVATE_TASK_SENTINEL");
    expect(await git(f.primary, "show-ref")).toBe(before);
    await writeFile(join(f.primary, ".timber.toml"), "base_branch = 'trunk'\n");
    const result = await execa(process.execPath, [entry, "arena", "pick", "demo", "--winner", winner!.label], { cwd: f.primary, env: { CI: "1" }, reject: false });
    expect(result.exitCode).toBe(0);
    expect(existsSync(winner!.path)).toBe(true); expect(existsSync(loser!.path)).toBe(false);
    expect(result.stdout).toContain(`Winner ${winner!.label}`);
    expect(result.stdout).toContain("Beta"); expect(result.stdout).toContain("incomplete");
  });
});

for (const selection of ["chooser-cancel", "confirm-cancel", "confirm-pick"] as const)
test(`real interactive pick ${selection} restores terminal and respects confirmation`, async () => {
  await withArena(async f => {
    const [winner, loser] = f.manifest.attempts;
    const manifest = await readFile(f.manifestPath), refs = await git(f.primary, "show-ref");
    const payload = join(f.directory, "pick-pty.json");
    await writeFile(payload, JSON.stringify({ cwd: f.primary,
      command: [process.execPath, entry, "arena", "pick", "demo",
        ...(selection === "chooser-cancel" ? [] : ["--winner", winner!.label])],
      sendAt: "Choose 1-", input: selection === "confirm-pick" ? "2\n" : "q\n", env: { CI: "false" } }));
    const result = JSON.parse((await execa("python3", ["-B", runner, payload], { timeout: 8000 })).stdout);
    expect(result.exitCode).toBe(0);
    expect(existsSync(winner!.path)).toBe(true);
    expect(existsSync(loser!.path)).toBe(selection !== "confirm-pick");
    expect(await readFile(f.manifestPath)).toEqual(manifest);
    if (selection !== "confirm-pick") {
      expect(await git(f.primary, "show-ref")).toBe(refs);
      expect(result.output).toContain("Cancelled. Nothing changed.");
    }
    expect(result.output).not.toContain("PRIVATE_TASK_SENTINEL");
  });
});
