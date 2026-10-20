import { expect, test } from "bun:test";
import { execa } from "execa";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, placeholderHandlers } from "../src/cli";
import { candidates } from "./helpers/completion";
import { withRepository, git } from "./helpers/git";
import { discoverRepository } from "../src/git/repository";
import { readArena } from "../src/arena/storage";
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const terminal = fileURLToPath(
  new URL("./helpers/pty-runner.py", import.meta.url),
);
const stub = fileURLToPath(
  new URL("./fixtures/arena-agent-stub.ts", import.meta.url),
);

test("arena nested command forwards literal options and propagates numeric status", async () => {
  let captured: unknown;
  let stderr = "";
  const context = {
    cwd: "/repo",
    io: {
      stdout(_s: string) {},
      stderr(s: string) {
        stderr += s;
      },
    },
  };
  const handler = async (...args: unknown[]) => {
    captured = args;
    return 23;
  };
  const code = await runCli(
    [
      "arena",
      "new",
      "demo",
      "--prompt-file",
      "task 'x'",
      "--preset",
      "fast", "--runs", "2",
      "--tool",
      "manual",
      "--base",
      "trunk",
      "--no-agent",
      "--no-editor",
    ],
    { context, handlers: { ...placeholderHandlers, arenaNew: handler } },
  );
  expect(code).toBe(23);
  expect(captured).toEqual([
    "demo",
    {
      taskFile: "task 'x'",
      groups: [
        { kind: "preset", preset: "fast", count: 2 },
        { kind: "harness", harness: "manual", model: null, count: 1 },
      ],
      base: "trunk",
      agent: false,
      editor: false,
    },
    context,
  ]);
  captured = undefined;
  expect(
    await runCli(["arena", "new", "demo", "--editor", "--no-editor"], {
      context,
      handlers: { ...placeholderHandlers, arenaNew: handler },
    }),
  ).toBe(1);
  expect(captured).toBeUndefined();
  expect(stderr).toContain("Conflicting");
});

test("nested arena completion derives subcommands, flags, and base refs without config reads", async () => {
  expect(await candidates("timber ar")).toEqual(["arena"]);
  expect(await candidates("timber arena ")).toEqual(["help", "new"]);
  expect(await candidates("timber arena new --prompt-f")).toEqual(["--prompt-file"]);
  expect(await candidates("timber arena new demo --no-")).toEqual([
    "--no-agent",
    "--no-editor",
  ]);
  await withRepository(async (primary) => {
    await writeFile(join(primary, ".timber.toml"), "invalid config");
    expect(
      await candidates("timber arena new demo --base tr", primary),
    ).toEqual(["trunk"]);
  });
});

test("real noninteractive arena creation prepares manual workspaces and never invokes prompts", async () => {
  await withRepository(async (primary, directory) => {
    const taskFile = join(directory, "task.txt");
    await writeFile(taskFile, "TASK SECRET");
    const args = [
      entry,
      "arena",
      "new",
      "demo",
      "--prompt-file",
      taskFile,
      "--tool",
      "manual", "--runs", "2",
      "--base",
      "trunk",
      "--no-editor",
    ];
    const result = await execa(process.execPath, args, {
      cwd: primary,
      reject: false,
      env: { CI: "1" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("TASK SECRET");
    const saved = await readArena(await discoverRepository(primary), "demo");
    expect(saved.manifest.attempts).toHaveLength(2);
    for (const a of saved.manifest.attempts)
      expect(await git(a.path, "rev-parse", "HEAD")).toBe(
        saved.manifest.base.commit,
      );
    const refs = await git(primary, "show-ref");
    const repeat = await execa(process.execPath, args, {
      cwd: primary,
      reject: false,
      env: { CI: "1" },
    });
    expect(repeat.exitCode).toBe(1);
    expect(await git(primary, "show-ref")).toBe(refs);
  });
});

for (const mode of ["success", "interrupt"] as const)
  test(`real terminal wrapper task handoff and ${mode} preserve foreground contract`, async () => {
    await withRepository(async (primary, directory) => {
      const taskFile = join(directory, "task.txt"),
        capture = join(directory, "capture.jsonl");
      await writeFile(taskFile, "private task\n' $(touch NEVER)\n");
      await writeFile(
        join(primary, ".timber.toml"),
        `base_branch="trunk"\n[arena.agents.custom]\ntool="wrapper"\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([stub, "literal ; $x", mode])}\n`,
      );
      const payload = join(directory, "pty.json");
      await writeFile(
        payload,
        JSON.stringify({
          cwd: primary,
          command: [
            process.execPath,
            entry,
            "arena",
            "new",
            "demo",
            "--prompt-file",
            taskFile,
            "--preset",
            "custom", "--runs", "2",
            "--no-editor",
          ],
          input: "y\n",
          env: { CI: "false", ARENA_CAPTURE: capture },
          sendAt: "[y/N]",
        }),
      );
      const result = JSON.parse(
        (await execa("python3", ["-B", terminal, payload], { timeout: 10000 }))
          .stdout,
      );
      expect(result.exitCode).toBe(mode === "interrupt" ? 130 : 0);
      const captured = (await readFile(capture, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(captured).toHaveLength(mode === "interrupt" ? 1 : 2);
      for (const c of captured) {
        expect(c.task).toBe("private task\n' $(touch NEVER)\n");
        expect(c.stdinTTY).toBe(true);
        expect(c.stdoutTTY).toBe(true);
        expect(c.args[0]).toBe("literal ; $x");
        expect(c.cwd).toBe(c.worktree);
        expect(c.workflow).toBeNull();
      }
      const saved = await readArena(await discoverRepository(primary), "demo");
      if (mode === "interrupt") {
        expect(saved.manifest.attempts[0]?.exitCode).toBe(130);
        expect(saved.manifest.attempts[1]?.stage).toBe("ready");
      } else expect(captured[0].taskFile).toBe(captured[1].taskFile);
      expect(result.output).not.toContain("$(touch NEVER)");
    });
  });

test("pasted task, participant, count and final confirmation survive Git preflight between prompts", async () => {
  await withRepository(async (primary, directory) => {
    let output = "",
      sent = false;
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        entry,
        "arena",
        "new",
        "paste",
        "--base",
        "trunk",
        "--no-editor",
      ],
      {
        cwd: primary,
        env: { ...process.env, CI: "false" },
        timeout: 3000,
        terminal: {
          data(terminal, bytes) {
            output += Buffer.from(bytes).toString("utf8");
            if (!sent && output.includes("/done to finish")) {
              sent = true;
              terminal.write("task\r/done\rmanual\r2\rn\ry\r");
            }
          },
        },
      },
    );
    try {
      expect(await child.exited).toBe(0);
      expect(output).toContain("prepared");
    } finally {
      child.kill();
      child.terminal?.close();
    }
    expect(
      (await readArena(await discoverRepository(primary), "paste")).manifest
        .attempts,
    ).toHaveLength(2);
  });
});

test.each(["codex", "cursor"])("native %s model passes literally through real foreground terminal", async (tool) => {
  const { chmod, mkdir } = await import("node:fs/promises");
  await withRepository(async (primary, directory) => {
    const bin = join(directory, "bin");
    await mkdir(bin);
    const executable = join(bin, tool === "cursor" ? "cursor-agent" : tool);
    await writeFile(
      executable,
      `#!${process.execPath}\n` + (await readFile(stub, "utf8")),
    );
    await chmod(executable, 0o755);
    const task = join(directory, "task.txt"),
      capture = join(directory, "native.jsonl");
    await writeFile(task, "NATIVE_TASK_SENTINEL");
    const payload = join(directory, "native-pty.json");
    await writeFile(
      payload,
      JSON.stringify({
        cwd: primary,
        command: [
          process.execPath,
          entry,
          "arena",
          "new",
          "native",
          "--base",
          "trunk",
          "--prompt-file",
          task,
          "--tool",
          tool,
          "--model",
          "model;$value",
          "--runs",
          "2",
          "--no-editor",
        ],
        input: "y\n",
        sendAt: "[y/N]",
        env: {
          CI: "false",
          PATH: `${bin}:${process.env.PATH}`,
          ARENA_CAPTURE: capture,
        },
      }),
    );
    const result = JSON.parse(
      (await execa("python3", ["-B", terminal, payload], { timeout: 8000 }))
        .stdout,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("model;$value");
    expect(result.output).not.toContain("NATIVE_TASK_SENTINEL");
    const captured = (await readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(captured).toHaveLength(2);
    for (const c of captured) {
      expect(c.args.slice(0, 3)).toEqual(["--model", "model;$value", "--"]);
      expect(c.stdinTTY).toBe(true);
      expect(c.task).toBe("NATIVE_TASK_SENTINEL");
    }
    const saved = (await readArena(await discoverRepository(primary), "native"))
      .manifest;
    expect(saved.version).toBe(2);
    expect(saved.attempts.map(a => a.tool)).toEqual([tool, tool]);
    if (saved.version === 2)
      expect(saved.attempts.map((a) => a.model)).toEqual([
        "model;$value",
        "model;$value",
      ]);
  });
});

test("unattended ambiguous tool selection preserves Git refs and every source file", async () => {
  await withRepository(async primary => {
    await writeFile(join(primary, "tracked.txt"), "modified");
    await writeFile(join(primary, "untracked.txt"), "untracked");
    await writeFile(join(primary, ".env"), "ignored synthetic content");
    const refs = await git(primary, "show-ref"), status = await git(primary, "status", "--porcelain");
    const result = await execa(process.execPath, [entry, "arena", "new", "ambiguous", "--prompt", "TASK_SENTINEL", "--tool", "c", "--runs", "2", "--base", "trunk", "--no-agent", "--no-editor"], { cwd: primary, reject: false, env: { CI: "true" } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Ambiguous agent tool");
    expect(result.stderr + result.stdout).not.toContain("TASK_SENTINEL");
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "status", "--porcelain")).toBe(status);
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("modified");
    expect(await readFile(join(primary, "untracked.txt"), "utf8")).toBe("untracked");
    expect(await readFile(join(primary, ".env"), "utf8")).toBe("ignored synthetic content");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(primary, ".git/timber/arenas"))).toBe(false);
  });
});

for (const colored of [true, false])
test(`Arena confirmation ${colored ? "shows terminal colors" : "honors NO_COLOR"} before any creation`, async () => {
  await withRepository(async primary => {
    const before = await git(primary, "worktree", "list", "--porcelain");
    let output = "", sent = false;
    const child = Bun.spawn([process.execPath, "--no-env-file", entry,
      "arena", "new", "color-review", "--base", "trunk", "--no-editor",
      "--tool", "manual", "--runs", "2", "--prompt", "PRIVATE_TASK"], {
      cwd: primary,
      env: { ...process.env, CI: "false", TERM: "xterm-256color", FORCE_COLOR: undefined, NO_COLOR: colored ? undefined : "1" },
      timeout: 3000,
      terminal: { data(terminal, bytes) {
        output += Buffer.from(bytes).toString("utf8");
        if (!sent && output.includes("[y/N]")) { sent = true; terminal.write("n\r"); }
      } },
    });
    try {
      expect(await child.exited).toBe(0);
      expect(output.includes("\u001b[1;36mArena color-review\u001b[0m")).toBe(colored);
      expect(output.includes("\u001b[1;36mRun 1/2")).toBe(colored);
      for (const label of ["Tool", "Model", "Effort", "Branch", "Path"])
        expect(output.includes(`\u001b[33m${label}\u001b[0m`)).toBe(colored);
      expect(output).toContain("Cancelled.");
      expect(output).not.toContain("PRIVATE_TASK");
      expect(await git(primary, "worktree", "list", "--porcelain")).toBe(before);
    } finally { child.kill(); child.terminal?.close(); }
  });
});
