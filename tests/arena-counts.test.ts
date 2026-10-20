import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArenaGroups, resolveArenaGroups, resolveArenaParticipants } from "../src/arena/participants";
import { collectParticipants } from "../src/arena/prompt";
import { planArena } from "../src/arena/plan";
import { readArena, reserveArena } from "../src/arena/storage";
import { discoverRepository } from "../src/git/repository";
import { resolveBase } from "../src/git/branches";
import type { ArenaPlan } from "../src/arena/types";
import type { RepositoryConfig } from "../src/types";
import type { SetupPrompt } from "../src/setup/types";
import { git, withRepository } from "./helpers/git";

const config: RepositoryConfig = {
  baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null,
};

test("attempt flags and preset aliases accept large counts while rejecting invalid numbers", () => {
  for (const value of ["101", "1000", "1000000"]) {
    expect(parseArenaGroups([
      { option: "tool", value: "codex" }, { option: "runs", value },
    ])).toEqual([{ kind: "harness", harness: "codex", model: null, count: Number(value) }]);
    expect(parseArenaGroups([{ option: "preset", value: "review" }, { option: "runs", value }]))
      .toEqual([{ kind: "preset", preset: "review", count: Number(value) }]);
  }
  for (const value of ["0", "-1", "1.5", "1e3", "NaN", "Infinity", "9007199254740992"]) {
    expect(() => parseArenaGroups([
      { option: "tool", value: "manual" }, { option: "runs", value },
    ])).toThrow();
    expect(() => parseArenaGroups([{ option: "preset", value: "review" }, { option: "runs", value }])).toThrow();
  }
});

test("large groups preserve ordered unique attempts and reject totals that cannot be counted safely", () => {
  const attempts = resolveArenaGroups(config, [
    { kind: "harness", harness: "codex", model: "model-a", count: 501 },
    { kind: "harness", harness: "codex", model: "model-b", count: 500 },
  ]);
  expect(attempts).toHaveLength(1001);
  expect(attempts[500]?.label).toBe("codex-501");
  expect(attempts[500]?.model).toBe("model-a");
  expect(attempts[501]?.label).toBe("codex-502");
  expect(attempts[501]?.model).toBe("model-b");
  expect(new Set(attempts.map((a) => a.id)).size).toBe(1001);
  expect(resolveArenaParticipants(config, ["manual:1000"])).toHaveLength(1000);
  for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => resolveArenaGroups(config, [
      { kind: "harness", harness: "manual", model: null, count },
    ])).toThrow();
  }
  expect(() => resolveArenaGroups(config, [
    { kind: "harness", harness: "manual", model: null, count: 1 },
  ])).toThrow(/at least 2/);
  expect(() => resolveArenaGroups(config, [
    { kind: "harness", harness: "manual", model: null, count: Number.MAX_SAFE_INTEGER },
    { kind: "harness", harness: "manual", model: null, count: 1 },
  ])).toThrow(/safe|whole/i);
});

test("interactive count accepts more than 100 and retries unsafe values", async () => {
  const answers = ["9007199254740992", "1.5", "101"];
  const prompt: SetupPrompt = {
    select: async () => "manual",
    text: async () => answers.shift() ?? null,
    confirm: async () => false,
    close() {},
  };
  const attempts = await collectParticipants(config, prompt);
  expect(attempts).toHaveLength(101);
  expect(attempts?.at(-1)?.label).toBe("manual-101");
});

test("batch preflight accepts more than 100 without changing refs or creating worktrees", async () => {
  await withRepository(async (primary) => {
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config, "trunk");
    const refs = await git(primary, "show-ref");
    const trees = await git(primary, "worktree", "list", "--porcelain");
    const prototype = resolveArenaParticipants(config, ["manual:2"])[0]!;
    const attempts = Array.from({ length: 101 }, (_, i) => ({
      ...prototype, id: randomUUID(), label: `manual-${i + 1}`,
    }));
    const plan = await planArena(repository, config, "large", attempts, base);
    expect(plan.attempts).toHaveLength(101);
    expect(plan.attempts.at(-1)?.branch).toBe("arena/large/manual-101");
    await expect(planArena(repository, config, "single", [prototype], base)).rejects.toThrow(/at least 2/);
    expect(await git(primary, "show-ref")).toBe(refs);
    expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
  });
});

test("large v2 and v1 manifests remain readable beyond the former 1 MiB record ceiling", async () => {
  await withRepository(async (primary, directory) => {
    const repository = await discoverRepository(primary);
    const base = await resolveBase(repository, config, "trunk");
    const prototype = resolveArenaParticipants(config, ["manual:2"])[0]!;
    // Exercise record persistence without creating thousands of worktrees.
    const plan: ArenaPlan = {
      name: "large", base,
      attempts: Array.from({ length: 5000 }, (_, i) => {
        const label = `manual-${i + 1}`;
        return { ...prototype, id: randomUUID(), label, branch: `arena/large/${label}`,
          path: join(directory, "attempts", label) };
      }),
    };
    const session = await reserveArena(repository, plan, Buffer.from("same private task"));
    try { await session.save(); } finally { await session.close(); }
    const file = join(repository.commonGitDir, "timber/arenas/large/manifest.json");
    expect((await lstat(file)).size).toBeGreaterThan(1024 * 1024);
    const current = (await readArena(repository, "large")).manifest;
    expect(current.version).toBe(2);
    expect(current.attempts).toHaveLength(5000);
    if (current.version !== 2) throw new Error("expected v2");
    const { source, ticket, ...common } = current;
    const legacy = { ...common, version: 1 as const,
      attempts: current.attempts.map(({ harness, model, configSource, ...a }) => a) };
    await writeFile(file, JSON.stringify(legacy));
    expect((await lstat(file)).size).toBeGreaterThan(1024 * 1024);
    expect((await readArena(repository, "large")).manifest).toEqual(legacy);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(legacy);
    for (const record of [current, legacy]) {
      await writeFile(file, JSON.stringify({ ...record, attempts: record.attempts.slice(0, 1) }));
      await expect(readArena(repository, "large")).rejects.toThrow(/manifest/i);
    }
  });
});
