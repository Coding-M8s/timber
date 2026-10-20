import { expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryConfig } from "../src/types";
import type { SetupPrompt } from "../src/setup/types";
const config: RepositoryConfig = {
  baseBranch: null,
  remote: null,
  worktreeDir: null,
  editor: null,
  agent: null,
};
const context = {
  cwd: "/repo",
  interactive: false,
  io: { stdout(_s: string) {}, stderr(_s: string) {} },
};

test("task input preserves valid bytes and rejects missing, blank, binary, invalid UTF-8, directory and large files", async () => {
  const { readArenaTask } = await import("../src/arena/input");
  const dir = await mkdtemp(join(tmpdir(), "timber-task-"));
  try {
    const task = Buffer.from("  quoted 'task'\n$(no-shell)\n");
    await writeFile(join(dir, "good"), task);
    expect(await readArenaTask("good", dir)).toEqual(task);
    for (const [name, bytes] of [
      ["empty", Buffer.from(" \n")],
      ["nul", Buffer.from("task\0")],
      ["invalid", Buffer.from([0xff])],
      ["large", Buffer.alloc(1024 * 1024 + 1, 65)],
    ] as const) {
      await writeFile(join(dir, name), bytes);
      await expect(readArenaTask(name, dir)).rejects.toThrow(/task/i);
    }
    await mkdir(join(dir, "directory"));
    await symlink(join(dir, "good"), join(dir, "link"));
    for (const name of ["missing", "directory", "link"])
      await expect(readArenaTask(name, dir)).rejects.toThrow(/task/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unattended arena input never prompts and requires explicit task and participants", async () => {
  const { collectArenaInput } = await import("../src/arena/input");
  let prompted = false;
  const makePrompt = () => {
    prompted = true;
    throw new Error("prompted");
  };
  await expect(
    collectArenaInput({}, config, context, makePrompt),
  ).rejects.toThrow(/prompt-file/);
  await expect(
    collectArenaInput({ taskFile: "missing" }, config, context, makePrompt),
  ).rejects.toThrow(/tool/);
  expect(prompted).toBe(false);
});

test("interactive multiline task and manual count support cancellation without external side effects", async () => {
  const { collectArenaInput } = await import("../src/arena/input");
  const text = ["first line", "", "second line", "/done", "2"];
  let closed = false;
  const prompt: SetupPrompt = {
    select: async () => "manual",
    text: async () => text.shift() ?? null,
    confirm: async () => false,
    close() {
      closed = true;
    },
  };
  const input = await collectArenaInput(
    {},
    config,
    { ...context, interactive: true },
    () => prompt,
  );
  expect(input?.task.toString()).toBe("first line\n\nsecond line");
  expect(input?.participants.map((p) => p.label)).toEqual([
    "manual-1",
    "manual-2",
  ]);
  expect(closed).toBe(false);
  input?.close?.();
  expect(closed).toBe(true);
  const cancelled: SetupPrompt = { ...prompt, text: async () => null };
  expect(
    await collectArenaInput(
      {},
      config,
      { ...context, interactive: true },
      () => cancelled,
    ),
  ).toBeNull();
});

test("ordinary agent reuse asks explicit tool and retains literal configured model arguments", async () => {
  const { collectArenaInput } = await import("../src/arena/input");
  const answers = ["task", "/done", "2"];
  const choices = ["configured", "codex"];
  const prompt: SetupPrompt = {
    select: async () => choices.shift() ?? null,
    text: async () => answers.shift() ?? null,
    confirm: async () => false,
    close() {},
  };
  const result = await collectArenaInput(
    {},
    {
      ...config,
      agent: {
        command: "custom-name",
        args: ["--model", "private-model"],
        enabled: false,
      },
    },
    { ...context, interactive: true },
    () => prompt,
  );
  expect(result?.participants[0]?.command).toEqual({
    command: "custom-name",
    args: ["--model", "private-model"],
  });
  expect(result?.participants[0]?.preset).toBe("configured");
  expect(result?.participants[0]?.tool).toBe("codex");
  result?.close?.();
});

test("reusing ordinary agent across groups preserves first explicit handoff choice", async () => {
  const { collectArenaInput } = await import("../src/arena/input");
  const answers = ["task", "/done", "1", "1"],
    choices = ["configured", "codex", "configured"];
  const prompt: SetupPrompt = {
    select: async () => choices.shift() ?? null,
    text: async () => answers.shift() ?? null,
    confirm: async () => false,
    close() {},
  };
  const result = await collectArenaInput(
    {},
    { ...config, agent: { command: "codex", args: [], enabled: false } },
    { ...context, interactive: true },
    () => prompt,
  );
  try {
    expect(result?.participants.map((p) => p.tool)).toEqual(["codex", "codex"]);
  } finally {
    result?.close?.();
  }
});

test("interactive harness selection offers built-ins, custom model and independent count without presets", async () => {
  const { collectArenaInput } = await import("../src/arena/input");
  const choices = ["codex", "custom"],
    answers = ["task", "/done", "model-a", "2"];
  const prompt: SetupPrompt = {
    select: async (message, options) => {
      if (message.includes("agent tool"))
        expect(options.map((o) => o.value)).toContain("claude");
      return choices.shift() ?? null;
    },
    text: async () => answers.shift() ?? null,
    confirm: async () => false,
    close() {},
  };
  const input = await collectArenaInput(
    {},
    config,
    { ...context, interactive: true },
    () => prompt,
  );
  try {
    expect(input?.participants.map((p) => [p.tool, p.model, p.label])).toEqual([
      ["codex", "model-a", "codex-1"],
      ["codex", "model-a", "codex-2"],
    ]);
  } finally {
    input?.close?.();
  }
});
