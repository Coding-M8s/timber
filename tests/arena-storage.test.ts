import { expect, test } from "bun:test";
import { lstat, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { withRepository, git } from "./helpers/git";
import { discoverRepository } from "../src/git/repository";
import { resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { resolveArenaParticipants } from "../src/arena/participants";
import type { RepositoryConfig } from "../src/types";
const config: RepositoryConfig = {
  baseBranch: null,
  remote: null,
  worktreeDir: null,
  editor: null,
  agent: null,
};

test("private arena snapshot is immutable, digest checked, exclusive, and readable after lock release", async () => {
  const { planArena } = await import("../src/arena/plan");
  const { reserveArena, readArena } = await import("../src/arena/storage");
  await withRepository(async (primary) => {
    const repo = await discoverRepository(primary),
      base = await resolveBase(repo, config, "trunk");
    const plan = await planArena(
      repo,
      config,
      "demo",
      resolveArenaParticipants(config, ["manual:2"]),
      base,
    );
    const task = Buffer.from("private task\n' $(never run)\n");
    const session = await reserveArena(repo, plan, task);
    try {
      expect((await lstat(session.taskPath)).mode & 0o777).toBe(0o600);
      expect(
        (await lstat(join(repo.commonGitDir, "timber/arenas/demo"))).mode &
          0o777,
      ).toBe(0o700);
      expect(await readFile(session.taskPath)).toEqual(task);
      expect(
        await readFile(
          join(repo.commonGitDir, "timber/arenas/demo/manifest.json"),
          "utf8",
        ),
      ).not.toContain("private task");
      await expect(reserveArena(repo, plan, task)).rejects.toThrow(
        /exists|reserved/,
      );
      await expect(readArena(repo, "demo")).rejects.toThrow(/active|lock/);
    } finally {
      await session.close();
    }
    expect((await readArena(repo, "demo")).manifest.base.commit).toBe(
      base.commit,
    );
    await writeFile(session.taskPath, "changed");
    await expect(readArena(repo, "demo")).rejects.toThrow(/task|snapshot/i);
  });
});

test("reciprocal attempt marker rejects deleted/recreated worktrees even at same path and branch", async () => {
  const { planArena } = await import("../src/arena/plan");
  const { reserveArena, validateArenaAttempt, readArena } = await import(
    "../src/arena/storage"
  );
  await withRepository(async (primary) => {
    const repo = await discoverRepository(primary),
      base = await resolveBase(repo, config, "trunk");
    const plan = await planArena(
      repo,
      config,
      "demo",
      resolveArenaParticipants(config, ["manual:2"]),
      base,
    );
    const session = await reserveArena(repo, plan, Buffer.from("task"));
    const a = plan.attempts[0]!;
    try {
      const tree = await createWorktree(
        repo,
        { kind: "new", branch: a.branch, base },
        config,
      );
      await session.bind(a.id, tree);
      expect(
        (
          await validateArenaAttempt(
            repo,
            session.manifest,
            session.manifest.attempts[0]!,
          )
        ).path,
      ).toBe(a.path);
      await git(primary, "worktree", "remove", a.path);
      await git(primary, "worktree", "add", a.path, a.branch);
      await expect(
        validateArenaAttempt(
          repo,
          session.manifest,
          session.manifest.attempts[0]!,
        ),
      ).rejects.toThrow(/identity|marker|replaced/i);
    } finally {
      await session.close();
    }
    const file = join(repo.commonGitDir, "timber/arenas/demo/manifest.json");
    await writeFile(file, '{"version":999}');
    await expect(readArena(repo, "demo")).rejects.toThrow(/record|manifest/i);
  });
});

test("symlink metadata cannot redirect task or record writes", async () => {
  const { planArena } = await import("../src/arena/plan");
  const { reserveArena } = await import("../src/arena/storage");
  await withRepository(async (primary, directory) => {
    const repo = await discoverRepository(primary),
      base = await resolveBase(repo, config, "trunk");
    const plan = await planArena(
      repo,
      config,
      "demo",
      resolveArenaParticipants(config, ["manual:2"]),
      base,
    );
    await symlink(directory, join(repo.commonGitDir, "timber"));
    await expect(reserveArena(repo, plan, Buffer.from("task"))).rejects.toThrow(
      /unsafe|metadata/i,
    );
  });
});

test("v2 records retain harness/model/source context while v1 remains unchanged and readable", async () => {
  const { planArena } = await import("../src/arena/plan");
  const { reserveArena, readArena } = await import("../src/arena/storage");
  const { resolveArenaGroups } = await import("../src/arena/participants");
  await withRepository(async (primary) => {
    const repo = await discoverRepository(primary),
      base = await resolveBase(repo, config, "trunk");
    const plan = await planArena(
      repo,
      config,
      "demo",
      resolveArenaGroups(config, [
        { kind: "harness", harness: "codex", model: "model-a", count: 2 },
      ]),
      base,
    );
    plan.ticket = "TIM-123";
    plan.source = {
      kind: "local",
      selector: base.ref,
      provenance: "ticket",
      ticketBranchMissing: false,
    };
    const session = await reserveArena(repo, plan, Buffer.from("task"));
    await session.close();
    const current = (await readArena(repo, "demo")).manifest;
    expect(current.version).toBe(2);
    if (current.version !== 2) throw new Error("not v2");
    expect(current.ticket).toBe("TIM-123");
    expect(current.source.provenance).toBe("ticket");
    expect(
      current.attempts.map((a) => [a.harness, a.model, a.configSource]),
    ).toEqual([
      ["codex", "model-a", "builtin"],
      ["codex", "model-a", "builtin"],
    ]);
    const { source, ticket, ...common } = current;
    const old = {
      ...common,
      version: 1 as const,
      attempts: current.attempts.map(
        ({ harness, model, configSource, ...attempt }) => attempt,
      ),
    };
    const file = join(repo.commonGitDir, "timber/arenas/demo/manifest.json");
    await writeFile(file, JSON.stringify(old));
    expect((await readArena(repo, "demo")).manifest).toEqual(old);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(old);
    await writeFile(
      file,
      JSON.stringify({
        ...current,
        attempts: current.attempts.map((a) => ({ ...a, harness: "claude" })),
      }),
    );
    await expect(readArena(repo, "demo")).rejects.toThrow(/record|manifest/i);
  });
});

for (const [tool, model, effort] of [["claude", "sonnet", "high"], ["codex", "gpt-sol", "ultra"]] as const)
test(`v2 persists ${tool} ${effort} and accepts historical records without effort`, async () => {
  const { planArena } = await import("../src/arena/plan");
  const { reserveArena, readArena } = await import("../src/arena/storage");
  const { resolveArenaGroups } = await import("../src/arena/participants");
  await withRepository(async primary => {
    const repo = await discoverRepository(primary), base = await resolveBase(repo, config, "trunk");
    const plan = await planArena(repo, config, "effort", resolveArenaGroups(config, [
      { kind: "harness", harness: tool, model, effort, count: 2 },
    ]), base);
    const session = await reserveArena(repo, plan, Buffer.from("task"));
    await session.close();
    const saved = (await readArena(repo, "effort")).manifest;
    expect(saved.version).toBe(2);
    if (saved.version !== 2) throw new Error("not v2");
    expect(saved.attempts.map(a => a.effort)).toEqual([effort, effort]);
    const file = join(repo.commonGitDir, "timber/arenas/effort/manifest.json");
    await writeFile(file, JSON.stringify({ ...saved, attempts: saved.attempts.map(({ effort, ...a }) => a) }));
    const historical = (await readArena(repo, "effort")).manifest;
    if (historical.version !== 2) throw new Error("not v2");
    expect(historical.attempts[0]?.effort).toBeUndefined();
  });
});


test("v2 inherited effort snapshot is optional, constrained to Claude defaults, and redacted", async () => {
  const { reserveArena, readArena } = await import("../src/arena/storage");
  const { planArena } = await import("../src/arena/plan");
  const { resolveArenaGroups } = await import("../src/arena/participants");
  const { captureArenaEffortEnvironment } = await import("../src/arena/effort");
  await withRepository(async primary => {
    const repo = await discoverRepository(primary), base = await resolveBase(repo, config, "trunk");
    const participants = captureArenaEffortEnvironment(resolveArenaGroups(config, [
      { kind: "harness", harness: "claude", model: null, count: 2 },
    ]), { CLAUDE_CODE_EFFORT_LEVEL: "PRIVATE_BAD_VALUE" });
    const plan = await planArena(repo, config, "inherited", participants, base);
    const session = await reserveArena(repo, plan, Buffer.from("task"));
    await session.close();
    const saved = (await readArena(repo, "inherited")).manifest;
    if (saved.version !== 2) throw new Error("not v2");
    expect(saved.attempts.map(run => run.effortEnvironment)).toEqual(["unrecognized", "unrecognized"]);
    expect(JSON.stringify(saved)).not.toContain("PRIVATE_BAD_VALUE");
    const file = join(repo.commonGitDir, "timber/arenas/inherited/manifest.json");
    await writeFile(file, JSON.stringify({ ...saved, attempts: saved.attempts.map(({ effortEnvironment, ...run }) => run) }));
    expect((await readArena(repo, "inherited")).manifest.attempts).toHaveLength(2);
    for (const override of [{ effort: "low" }, { tool: "codex", harness: "codex" }, { effortEnvironment: "PRIVATE_BAD_VALUE" }]) {
      await writeFile(file, JSON.stringify({ ...saved, attempts: saved.attempts.map(run => ({ ...run, ...override })) }));
      await expect(readArena(repo, "inherited")).rejects.toThrow();
    }
  });
});
