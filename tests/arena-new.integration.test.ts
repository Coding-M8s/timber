import { resolveArenaSource, finalizeArenaSource } from "../src/arena/source";
import { expect, test } from "bun:test";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { withRepository, git } from "./helpers/git";
import { discoverRepository } from "../src/git/repository";
import { createWorktree } from "../src/git/create-worktree";
import { planArenaDraft } from "../src/arena/plan";
import {
  reserveArena,
  readArena,
  validateArenaAttempt,
} from "../src/arena/storage";
import { collectArenaInput } from "../src/arena/input";
import { runSetup } from "../src/hooks";
import type { RepositoryConfig } from "../src/types";
import type { ArenaServices } from "../src/arena/services";

const config: RepositoryConfig = {
  baseBranch: null,
  remote: null,
  worktreeDir: null,
  editor: null,
  agent: null,
};
async function fixture(
  run: (f: {
    primary: string;
    directory: string;
    taskFile: string;
    services: ArenaServices;
    context: {
      cwd: string;
      interactive: boolean;
      io: { stdout(s: string): void; stderr(s: string): void };
    };
    output: () => string;
  }) => Promise<void>,
) {
  await withRepository(async (primary, directory) => {
    const taskFile = join(directory, "task.txt");
    await writeFile(taskFile, "Same private task\n' $(touch NEVER)\n");
    await writeFile(join(primary, "tracked.txt"), "modified source");
    await writeFile(join(primary, "untracked"), "untracked source");
    await writeFile(join(primary, ".env"), "ignored source");
    let output = "";
    const context = {
      cwd: primary,
      interactive: false,
      io: {
        stdout(s: string) {
          output += s;
        },
        stderr(s: string) {
          output += s;
        },
      },
    };
    const services: ArenaServices = {
      discoverRepository,
      loadConfig: async () => config,
      resolveSource: resolveArenaSource,
      finalizeSource: finalizeArenaSource,
      chooseSource: async () => {
        throw new Error("unexpected source chooser");
      },
      createWorktree,
      planDraft: planArenaDraft,
      reserveArena,
      validateArenaAttempt,
      collectInput: (options, loaded, ctx) =>
        collectArenaInput(options, loaded, ctx, () => {
          throw new Error("unexpected prompt");
        }),
      confirmPlan: async () => true,
      checkExecutable: async () => true,
      runSetup,
      launchEditor: async () => ({ kind: "skipped" }),
      launchAgent: async () => ({ kind: "exited", exitCode: 0, signal: null }),
    };
    await run({
      primary,
      directory,
      taskFile,
      services,
      context,
      output: () => output,
    });
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe(
      "modified source",
    );
    expect(await readFile(join(primary, "untracked"), "utf8")).toBe(
      "untracked source",
    );
    expect(await readFile(join(primary, ".env"), "utf8")).toBe(
      "ignored source",
    );
    expect(output).not.toContain("Same private task");
  });
}

test("all attempts use base resolved once even when branch moves; source files remain intact", async () => {
  const { createArenaNewHandler } = await import("../src/commands/arena-new");
  await fixture(async ({ primary, taskFile, services, context }) => {
    let bases = 0,
      created = 0;
    const original = await git(primary, "rev-parse", "HEAD");
    const handler = createArenaNewHandler({
      ...services,
      resolveSource: async (...args) => {
        bases++;
        return resolveArenaSource(...args);
      },
      createWorktree: async (...args) => {
        const tree = await createWorktree(...args);
        if (++created === 1) {
          const treeId = await git(primary, "rev-parse", "HEAD^{tree}");
          const commit = await git(
            primary,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit-tree",
            treeId,
            "-p",
            original,
            "-m",
            "new base",
          );
          await git(primary, "update-ref", "refs/heads/trunk", commit);
        }
        return tree;
      },
    });
    expect(
      await handler(
        "demo",
        { taskFile, participants: ["manual:2"], base: "trunk", agent: false },
        context,
      ),
    ).toBe(0);
    const repo = await discoverRepository(primary),
      saved = await readArena(repo, "demo");
    expect(bases).toBe(1);
    expect(saved.manifest.base.commit).toBe(original);
    for (const a of saved.manifest.attempts) {
      expect(await git(a.path, "rev-parse", "HEAD")).toBe(original);
      expect(await readFile(join(a.path, "tracked.txt"), "utf8")).toBe(
        "original\n",
      );
      expect(a.stage).toBe("ready");
    }
  });
});

test("all worktrees and setup finish before sequential editor/agent launch with literal task handoff", async () => {
  const { createArenaNewHandler } = await import("../src/commands/arena-new");
  await fixture(async ({ taskFile, services, context }) => {
    context.interactive = true;
    const calls: string[] = [],
      prompts: string[] = [];
    let running = false;
    const loaded = {
      ...config,
      hooks: { postCreate: ["unused"] },
      arena: {
        agents: {
          fast: {
            tool: "codex" as const,
            command: "stub",
            args: ["--model", "literal model"],
          },
        },
      },
    };
    const handler = createArenaNewHandler({
      ...services,
      loadConfig: async () => loaded,
      createWorktree: async (...args) => {
        calls.push("create");
        return createWorktree(...args);
      },
      runSetup: async (_repo, tree) => {
        calls.push("setup");
        await writeFile(join(tree.path, "setup-marker"), "prepared");
      },
      launchEditor: async () => {
        calls.push("editor");
        return { kind: "skipped" };
      },
      launchAgent: async (tree, command, env) => {
        expect(running).toBe(false);
        running = true;
        calls.push("agent");
        expect(command?.args.slice(0, 2)).toEqual(["--model", "literal model"]);
        prompts.push(command!.args.at(-1)!);
        expect(await readFile(env!.TIMBER_TASK_FILE!, "utf8")).toBe(
          "Same private task\n' $(touch NEVER)\n",
        );
        expect(env?.TIMBER_WORKTREE).toBe(tree.path);
        await Bun.sleep(10);
        running = false;
        return { kind: "exited", exitCode: 0, signal: null };
      },
    });
    expect(
      await handler(
        "demo",
        { taskFile, participants: ["fast:2"], base: "trunk" },
        context,
      ),
    ).toBe(0);
    expect(calls).toEqual([
      "create",
      "create",
      "setup",
      "setup",
      "editor",
      "agent",
      "editor",
      "agent",
    ]);
    expect(prompts[0]).toBe(prompts[1]);
  });
});

for (const failure of [
  "creation",
  "setup",
  "editor",
  "agent",
  "exit",
] as const)
  test(`${failure} failure retains all completed attempts and stops later stages`, async () => {
    const { createArenaNewHandler } = await import("../src/commands/arena-new");
    await fixture(async ({ primary, taskFile, services, context, output }) => {
      context.interactive = true;
      let creates = 0,
        setups = 0,
        launches = 0;
      const loaded = {
        ...config,
        hooks: { postCreate: ["setup"] },
        arena: {
          agents: {
            custom: {
              tool: "wrapper" as const,
              command: "stub",
              args: ["literal;$x"],
            },
          },
        },
      };
      const handler = createArenaNewHandler({
        ...services,
        loadConfig: async () => loaded,
        createWorktree: async (...args) => {
          if (++creates === 2 && failure === "creation")
            throw new Error("SECRET startup details");
          return createWorktree(...args);
        },
        runSetup: async (_r, tree) => {
          setups++;
          await writeFile(join(tree.path, "hook-work"), "keep hook work");
          if (failure === "setup") throw new Error("SECRET source");
        },
        launchEditor: async () =>
          failure === "editor"
            ? { kind: "failed", message: "SECRET", retryCommand: "SECRET" }
            : { kind: "skipped" },
        launchAgent: async () => {
          launches++;
          return failure === "agent"
            ? { kind: "failed", message: "SECRET", retryCommand: "SECRET" }
            : { kind: "exited", exitCode: 7, signal: null };
        },
      });
      const code = await handler(
        "demo",
        { taskFile, participants: ["custom:2"], base: "trunk" },
        context,
      );
      expect(code).toBe(
        failure === "exit" ? 7 : 1,
      );
      expect(launches).toBe(
        ["agent", "exit"].includes(failure) ? 1 : 0,
      );
      const repo = await discoverRepository(primary),
        saved = await readArena(repo, "demo");
      expect(
        await git(
          primary,
          "show-ref",
          "--verify",
          `refs/heads/${saved.manifest.attempts[0]!.branch}`,
        ),
      ).not.toBe("");
      expect((await stat(saved.manifest.attempts[0]!.path)).isDirectory()).toBe(
        true,
      );
      if (failure === "setup")
        expect(
          await readFile(
            join(saved.manifest.attempts[0]!.path, "hook-work"),
            "utf8",
          ),
        ).toBe("keep hook work");
      expect(output()).not.toContain("SECRET");
      expect(output()).toContain("retained");
      if (failure !== "creation") {
        expect(output()).toContain(`timber arena resume demo --attempt custom-1${failure === "setup" ? " --setup" : ""}`);
      }
    });
  });

test("cancellation and missing executable preflight create no refs or arena records", async () => {
  const { createArenaNewHandler } = await import("../src/commands/arena-new");
  await fixture(async ({ primary, taskFile, services, context }) => {
    context.interactive = true;
    const refs = await git(primary, "show-ref");
    expect(
      await createArenaNewHandler({
        ...services,
        confirmPlan: async () => false,
      })(
        "demo",
        { taskFile, participants: ["manual:2"], base: "trunk" },
        context,
      ),
    ).toBe(0);
    expect(await git(primary, "show-ref")).toBe(refs);
    const loaded = {
      ...config,
      arena: {
        agents: {
          bad: { tool: "wrapper" as const, command: "missing", args: [] },
        },
      },
    };
    await expect(
      createArenaNewHandler({
        ...services,
        loadConfig: async () => loaded,
        checkExecutable: async () => false,
      })("demo", { taskFile, participants: ["bad:2"], base: "trunk" }, context),
    ).rejects.toThrow(/executable/);
    expect(await git(primary, "show-ref")).toBe(refs);
    await expect(
      stat(
        join(
          (await discoverRepository(primary)).commonGitDir,
          "timber/arenas/demo",
        ),
      ),
    ).rejects.toThrow();
  });
});

test("editor launch intent is persisted before startup and manual attempts return to ready", async () => {
  const { createArenaNewHandler } = await import("../src/commands/arena-new");
  await fixture(async ({ primary, taskFile, services, context }) => {
    const repo = await discoverRepository(primary);
    let launches = 0;
    const handler = createArenaNewHandler({
      ...services,
      launchEditor: async (tree) => {
        const manifest = JSON.parse(
          await readFile(
            join(repo.commonGitDir, "timber/arenas/demo/manifest.json"),
            "utf8",
          ),
        );
        expect(
          manifest.attempts.find((a: { path: string }) => a.path === tree.path)
            .stage,
        ).toBe("launch-running");
        launches++;
        return { kind: "skipped" };
      },
    });
    expect(
      await handler(
        "demo",
        { taskFile, participants: ["manual:2"], base: "trunk" },
        context,
      ),
    ).toBe(0);
    expect(launches).toBe(2);
    expect(
      (await readArena(repo, "demo")).manifest.attempts.every(
        (a) => a.stage === "ready",
      ),
    ).toBe(true);
  });
});

test("metadata failure after creation retains created refs and stops later attempts", async () => {
  const { createArenaNewHandler } = await import("../src/commands/arena-new");
  await fixture(async ({ primary, taskFile, services, context }) => {
    const handler = createArenaNewHandler({
      ...services,
      reserveArena: async (...args) => {
        const session = await reserveArena(...args);
        return {
          ...session,
          bind: async (...bindArgs) => {
            await session.bind(...bindArgs);
            throw new Error("metadata failure");
          },
        };
      },
    });
    expect(
      await handler(
        "demo",
        { taskFile, participants: ["manual:2"], base: "trunk" },
        context,
      ),
    ).toBe(1);
    const manifest = (
      await readArena(await discoverRepository(primary), "demo")
    ).manifest;
    expect(manifest.attempts[0]?.stage).toBe("failed");
    expect(manifest.attempts[1]?.stage).toBe("planned");
    expect(
      await git(
        primary,
        "show-ref",
        "--verify",
        `refs/heads/${manifest.attempts[0]!.branch}`,
      ),
    ).not.toBe("");
  });
});

test("changed task snapshot stops later launch and preserves completed first attempt", async () => {
  const { createArenaNewHandler } = await import("../src/commands/arena-new");
  await fixture(async ({ primary, taskFile, services, context }) => {
    context.interactive = true;
    let launches = 0;
    const loaded = {
      ...config,
      arena: {
        agents: {
          custom: { tool: "wrapper" as const, command: "stub", args: [] },
        },
      },
    };
    const handler = createArenaNewHandler({
      ...services,
      loadConfig: async () => loaded,
      launchAgent: async (_tree, _command, env) => {
        launches++;
        await writeFile(env!.TIMBER_TASK_FILE!, "changed");
        return { kind: "exited", exitCode: 0, signal: null };
      },
    });
    expect(
      await handler(
        "demo",
        { taskFile, participants: ["custom:2"], base: "trunk" },
        context,
      ),
    ).toBe(1);
    expect(launches).toBe(1);
    const repo = await discoverRepository(primary);
    const manifest = JSON.parse(
      await readFile(
        join(repo.commonGitDir, "timber/arenas/demo/manifest.json"),
        "utf8",
      ),
    );
    expect(manifest.attempts[0].stage).toBe("exited");
    expect(manifest.attempts[1].stage).toBe("failed");
    expect(
      await git(
        primary,
        "show-ref",
        "--verify",
        `refs/heads/${manifest.attempts[0].branch}`,
      ),
    ).not.toBe("");
  });
});

test("worktree replaced during editor startup never receives an arena agent", async () => {
  const { createArenaNewHandler } = await import("../src/commands/arena-new");
  await fixture(async ({ primary, taskFile, services, context }) => {
    context.interactive = true;
    let launches = 0,
      editors = 0;
    const loaded = {
      ...config,
      arena: {
        agents: {
          custom: { tool: "wrapper" as const, command: "stub", args: [] },
        },
      },
    };
    const handler = createArenaNewHandler({
      ...services,
      loadConfig: async () => loaded,
      launchEditor: async (tree) => {
        if (++editors === 1) {
          await git(primary, "worktree", "remove", tree.path);
          await git(primary, "worktree", "add", tree.path, tree.branch!);
          await writeFile(
            join(tree.path, "replacement-work"),
            "keep replacement",
          );
        }
        return { kind: "launched" };
      },
      launchAgent: async () => {
        launches++;
        return { kind: "exited", exitCode: 0, signal: null };
      },
    });
    expect(
      await handler(
        "demo",
        { taskFile, participants: ["custom:2"], base: "trunk" },
        context,
      ),
    ).toBe(1);
    expect(launches).toBe(0);
    expect(editors).toBe(1);
    const saved = (await readArena(await discoverRepository(primary), "demo"))
      .manifest;
    expect(
      await readFile(join(saved.attempts[0]!.path, "replacement-work"), "utf8"),
    ).toBe("keep replacement");
    expect(
      await git(
        primary,
        "show-ref",
        "--verify",
        `refs/heads/${saved.attempts[0]!.branch}`,
      ),
    ).not.toBe("");
  });
});

test("failed atomic manifest publication preserves previous intent and created worktree", async () => {
  const { chmod } = await import("node:fs/promises");
  const { createArenaNewHandler } = await import("../src/commands/arena-new");
  await fixture(async ({ primary, taskFile, services, context }) => {
    let publicationFailed = false;
    const handler = createArenaNewHandler({
      ...services,
      reserveArena: async (...args) => {
        const session = await reserveArena(...args);
        const dir = join(args[0].commonGitDir, "timber/arenas/demo");
        return {
          ...session,
          bind: async (...bindArgs) => {
            await chmod(dir, 0o500);
            try {
              await session.bind(...bindArgs);
            } catch (error) {
              publicationFailed = true;
              throw error;
            }
          },
          close: async () => {
            await chmod(dir, 0o700);
            await session.close();
          },
        };
      },
    });
    expect(
      await handler(
        "demo",
        { taskFile, participants: ["manual:2"], base: "trunk" },
        context,
      ),
    ).toBe(1);
    expect(publicationFailed).toBe(true);
    const repo = await discoverRepository(primary),
      saved = await readArena(repo, "demo");
    expect(saved.manifest.attempts.map((a) => a.stage)).toEqual([
      "planned",
      "planned",
    ]);
    const first = saved.manifest.attempts[0]!;
    expect(
      await git(primary, "show-ref", "--verify", `refs/heads/${first.branch}`),
    ).not.toBe("");
    expect(await readFile(join(first.path, "tracked.txt"), "utf8")).toBe(
      "original\n",
    );
    await expect(stat(saved.manifest.attempts[1]!.path)).rejects.toThrow();
  });
});


test("Claude explicit efforts synchronize child environment and inherited defaults remain visible in records", async () => {
  const { createArenaNewHandler } = await import("../src/commands/arena-new");
  const { captureArenaEffortEnvironment } = await import("../src/arena/effort");
  await fixture(async ({ services, context, taskFile, primary, output }) => {
    const levels: (string | undefined)[] = [];
    const handler = createArenaNewHandler({
      ...services,
      collectInput: async (options, loaded, ctx) => {
        const input = await collectArenaInput(options, loaded, ctx, () => { throw new Error("unexpected prompt"); }, async () => ({
          models: [{ value: "claude-known", label: "Known Claude", efforts: ["low", "medium"] }],
        }));
        if (!input) throw new Error("missing input");
        return { ...input, participants: captureArenaEffortEnvironment(input.participants, { CLAUDE_CODE_EFFORT_LEVEL: "high" }) };
      },
      launchAgent: async (_tree, command, environment) => {
        levels.push(environment?.CLAUDE_CODE_EFFORT_LEVEL);
        if (levels.length < 3) expect(command?.args).toContain(levels.length === 1 ? "low" : "medium");
        else expect(command?.args).not.toContain("--effort");
        return { kind: "exited", exitCode: 0, signal: null };
      },
    });
    expect(await handler("claude-effort", { taskFile, defaultEffort: "low", base: "trunk", groups: [
      { kind: "harness", harness: "claude", model: "claude-known", count: 1 },
      { kind: "harness", harness: "claude", model: "claude-known", effort: "medium", count: 1 },
      { kind: "harness", harness: "claude", model: null, effort: "default", count: 1 },
    ] }, { ...context, interactive: true })).toBe(0);
    expect(levels).toEqual(["low", "medium", undefined]);
    const saved = (await readArena(await discoverRepository(primary), "claude-effort")).manifest;
    if (saved.version !== 2) throw new Error("not v2");
    expect(saved.attempts.map(run => [run.effort, run.effortEnvironment])).toEqual([
      ["low", undefined], ["medium", undefined], [undefined, "high"],
    ]);
    expect(output()).toContain("CLAUDE_CODE_EFFORT_LEVEL=high (inherited)");
    expect(output()).toContain("medium (requested); effective unknown");
  });
});

test("unsupported arena effort fails before any worktree or record creation", async () => {
  const { createArenaNewHandler } = await import("../src/commands/arena-new");
  await fixture(async ({ services, context, taskFile, primary }) => {
    const before = await git(primary, "show-ref");
    const handler = createArenaNewHandler({
      ...services,
      collectInput: (options, loaded, ctx) => collectArenaInput(options, loaded, ctx, () => { throw new Error("unexpected prompt"); }, async () => ({ models: [] })),
      createWorktree: async () => { throw new Error("must not create"); },
      reserveArena: async () => { throw new Error("must not reserve"); },
    });
    await expect(handler("unsupported-effort", { taskFile, agent: false, defaultEffort: "low", groups: [
      { kind: "harness", harness: "cursor", model: "composer", count: 2 },
    ] }, context)).rejects.toThrow(/effort/i);
    expect(await git(primary, "show-ref")).toBe(before);
    expect((await git(primary, "worktree", "list", "--porcelain")).split("worktree ")).toHaveLength(2);
    expect(await stat(join(primary, ".git/timber/arenas/unsupported-effort")).catch(() => null)).toBeNull();
  });
});
