import { expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { runSetup } from "../src/hooks";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import { runCli } from "../src/cli";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CommandHandlers } from "../src/services";
import type { RepositoryConfig } from "../src/types";

const config: RepositoryConfig = {
  baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null,
  hooks: { postCreate: ["trusted source"] },
};

test.each(["new", "open"] as const)("%s passes setup context and blocks editor on setup rejection", async command => {
  const calls: string[] = [];
  const repository = repositoryFixture();
  const worktree = worktreeFixture({ path: "/repo-worktrees/feature", branch: "feature", isPrimary: false });
  const services = createServiceDouble({
    discoverRepository: async () => repository,
    loadConfig: async () => config,
    resolveBase: async () => ({ ref: "refs/heads/main", commit: "a".repeat(40), source: "fallback" }),
    resolveOpenTarget: async () => ({ kind: "found", value: { kind: "worktree", worktree } }),
    createWorktree: async () => { calls.push("create"); return worktree; },
    runSetup: async (actualRepository, actualTree, actualConfig, io) => {
      expect([actualRepository, actualTree, actualConfig, io]).toEqual([repository, worktree, config, context.io]);
      calls.push("setup");
      throw new Error("setup failed; retained workspace");
    },
    launchEditor: async () => { calls.push("editor"); return { kind: "launched" }; },
  });
  let stderr = "";
  const context = { cwd: "/repo", io: { stdout: () => {}, stderr: (text: string) => { stderr += text; } } };
  const handlers: CommandHandlers = {
    new: createNewHandler(services), open: createOpenHandler(services),
    list: async () => {}, done: async () => {},
  };
  expect(await runCli([command, "feature", ...(command === "open" ? ["--setup"] : []), "--no-editor"],
    { context, handlers })).toBe(1);
  expect(calls).toEqual(command === "new" ? ["create", "setup"] : ["setup"]);
  expect(stderr).toBe("error: setup failed; retained workspace\n");
});

test("setup launch errors omit shell source and supply a safely executable retry for hostile paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber hook retry "));
  try {
    const path = join(directory, "missing ' $(touch injected) `touch injected` !\n\u001b\u009b\u2028");
    const worktree = worktreeFixture({ path, isPrimary: false });
    const message = await runSetup(repositoryFixture(), worktree,
      { ...config, hooks: { postCreate: ["SECRET_SOURCE"] } },
      { stdout: () => {}, stderr: () => {} }).then(() => "resolved", error => (error as Error).message);
    expect(message).toContain("post_create step 1");
    expect(message).toContain("shell could not run");
    expect(message).not.toContain("SECRET_SOURCE");
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    const retry = message.split("Bash retry command: ")[1];
    expect(retry).toBeDefined();
    const capture = await execa("/bin/bash", ["-c",
      'timber() { printf "%s\\0" "$@"; }; ' + retry], { cwd: directory });
    expect(capture.stdout.split("\0")).toEqual(["open", "--setup", "--", path, ""]);
    expect(await access(join(directory, "injected")).then(() => true, () => false)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hook stdout is streamed before completion and stdin reaches EOF without a prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber hook stream "));
  try {
    let stdout = "";
    const received = Promise.withResolvers<void>();
    const running = runSetup(repositoryFixture(), worktreeFixture({ path: directory }), {
      ...config,
      hooks: { postCreate: ['printf ready; while test ! -f continue; do sleep 0.01; done; read value && exit 99; printf done'] },
    }, { stdout: text => { stdout += text; if (stdout === "ready") received.resolve(); }, stderr: () => {} });
    const timeout = setTimeout(() => received.reject(new Error("Hook output was not streamed")), 1_000);
    try {
      await received.promise;
      expect(stdout).toBe("ready");
    } finally {
      clearTimeout(timeout);
      await writeFile(join(directory, "continue"), "ready");
      await running;
    }
    expect(stdout).toBe("readydone");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("signal termination stops subsequent hooks and reports the failed step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber hook signal "));
  try {
    await expect(runSetup(repositoryFixture(), worktreeFixture({ path: directory }), {
      ...config, hooks: { postCreate: ['kill -TERM $$', 'touch later'] },
    }, { stdout: () => {}, stderr: () => {} })).rejects.toThrow("signal SIGTERM");
    expect(await access(join(directory, "later")).then(() => true, () => false)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
