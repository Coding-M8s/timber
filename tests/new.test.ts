import { expect, test } from "bun:test";
import { createNewHandler } from "../src/commands/new";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CommandContext } from "../src/services";
import type { RepositoryConfig, ValidatedBase } from "../src/types";

const config: RepositoryConfig = {
  baseBranch: "trunk", remote: null, worktreeDir: null, editor: null, agent: null,
};
const base: ValidatedBase = { ref: "refs/heads/other", commit: "a".repeat(40), source: "explicit" };

function context() {
  let stdout = "";
  const value: CommandContext = {
    cwd: "/repo/nested",
    io: { stdout: text => { stdout += text; }, stderr: () => { throw new Error("unexpected stderr"); } },
  };
  return { value, output: () => stdout };
}

test("new passes explicit base and disabled editor through ordered services", async () => {
  const calls: string[] = [];
  const repository = repositoryFixture();
  const tree = worktreeFixture({ path: "/repo-worktrees/feature-one", branch: "feature/one", isPrimary: false });
  const h = context();
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async cwd => { expect(cwd).toBe(h.value.cwd); calls.push("discover"); return repository; },
    loadConfig: async received => { expect(received).toBe(repository); calls.push("config"); return config; },
    resolveBase: async (received, selectedConfig, explicit) => {
      expect([received, selectedConfig, explicit]).toEqual([repository, config, "other"]);
      calls.push("base");
      return base;
    },
    createWorktree: async (received, request, selectedConfig) => {
      expect([received, request, selectedConfig]).toEqual([
        repository, { kind: "new", branch: "feature/one", base }, config,
      ]);
      calls.push("create");
      return tree;
    },
    launchEditor: async (received, selectedConfig, disabled) => {
      expect([received, selectedConfig, disabled]).toEqual([tree, config, true]);
      expect(h.output()).toBe("Created feature/one at /repo-worktrees/feature-one\n");
      calls.push("editor");
      return { kind: "skipped" };
    },
  }));

  await handler("feature/one", { base: "other", editor: false }, h.value);
  expect(calls).toEqual(["discover", "config", "base", "create", "editor"]);
});

test("new keeps reported workspace when editor startup fails", async () => {
  const h = context();
  const tree = worktreeFixture({ path: "/repo-worktrees/feature", branch: "feature", isPrimary: false });
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => config,
    resolveBase: async () => base,
    createWorktree: async () => tree,
    launchEditor: async () => ({
      kind: "failed", message: "editor failed; retry: timber open -- '/repo-worktrees/feature'",
      retryCommand: "timber open -- '/repo-worktrees/feature'",
    }),
  }));

  await expect(handler("feature", {}, h.value)).rejects.toThrow("editor failed; retry:");
  expect(h.output()).toBe("Created feature at /repo-worktrees/feature\n");
});

test("new stops before creation and editor when base selection fails", async () => {
  const h = context();
  const handler = createNewHandler(createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => config,
    resolveBase: async () => { throw new Error("base ambiguous"); },
  }));
  await expect(handler("feature", {}, h.value)).rejects.toThrow("base ambiguous");
  expect(h.output()).toBe("");
});
