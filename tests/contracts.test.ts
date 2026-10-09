import { expect, test } from "bun:test";
import { runCli } from "../src/cli";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { CleanupInspection, RepositoryConfig, Resolution, Branch } from "../src/types";

// An illustrative downstream command, NOT the TIM-14 implementation.
// The assertions exercise parser -> handler -> service seams -> observable output.
test("a list handler can use Git service doubles without Git, config or network", async () => {
  const repository = repositoryFixture();
  const worktrees = [worktreeFixture(), worktreeFixture({
    path: "/repo-worktrees/detached", branch: null, isPrimary: false,
    pathExists: false, prunable: { reason: "gitdir file points to non-existent location" },
    status: { kind: "unknown", reason: "path missing" },
  })];
  const services = createServiceDouble({
    discoverRepository: async cwd => {
      expect(cwd).toBe("/repo/nested");
      return repository;
    },
    listWorktrees: async context => {
      expect(context).toBe(repository);
      return worktrees;
    },
  });
  let stdout = "";
  const exitCode = await runCli(["ls"], {
    context: { cwd: "/repo/nested", io: { stdout: text => { stdout += text; }, stderr: () => { throw new Error("unexpected stderr"); } } },
    handlers: {
      new: async () => { throw new Error("unexpected new"); },
      open: async () => { throw new Error("unexpected open"); },
      done: async () => { throw new Error("unexpected done"); },
      list: async context => {
        const repo = await services.discoverRepository(context.cwd);
        for (const tree of await services.listWorktrees(repo)) {
          context.io.stdout(`${tree.isPrimary ? "primary" : "linked"} ${tree.branch ?? "detached"} ${tree.path} ${tree.status.kind}\n`);
        }
      },
    },
  });
  expect(exitCode).toBe(0);
  expect(stdout).toBe("primary main /repo known\nlinked detached /repo-worktrees/detached unknown\n");
});

test("unspecified service calls fail rather than manufacturing successful Git operations", async () => {
  const services = createServiceDouble();
  await expect(services.discoverRepository("/repo")).rejects.toThrow("Unexpected service call: discoverRepository");
  const config: RepositoryConfig = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };
  await expect(services.cleanupWorktree(repositoryFixture(), worktreeFixture(), config, {
    keepBranch: false, discardIgnored: false,
  })).rejects.toThrow("Unexpected service call: cleanupWorktree");
});

test("shared models preserve uncertainty and distinguish repository paths", () => {
  const repository = repositoryFixture({ currentWorktreeRoot: "/repo-worktrees/feature", currentBranch: "feature" });
  expect(repository.currentWorktreeRoot).not.toBe(repository.primaryWorktreeRoot);
  expect(repository.commonGitDir).toBe("/repo/.git");
  const inspection: CleanupInspection = {
    worktree: worktreeFixture({ status: { kind: "unknown", reason: "permission denied" } }),
    publication: { kind: "unknown", reason: "offline" },
    ancestry: { kind: "unknown", reason: "base ambiguous" },
  };
  expect(inspection.publication.kind).toBe("unknown");
  const resolution: Resolution<Branch> = { kind: "ambiguous", candidates: [
    { kind: "remote", remote: "origin", name: "ABU-834-one", ref: "refs/remotes/origin/ABU-834-one" },
    { kind: "remote", remote: "upstream", name: "ABU-834-two", ref: "refs/remotes/upstream/ABU-834-two" },
  ] };
  expect(resolution.candidates).toHaveLength(2);
});
