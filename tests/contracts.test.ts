import { expect, test } from "bun:test";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { RepositoryConfig } from "../src/types";

test("unspecified service calls fail rather than manufacturing successful Git operations", async () => {
  const services = createServiceDouble();
  await expect(services.discoverRepository("/repo")).rejects.toThrow("Unexpected service call: discoverRepository");
  const config: RepositoryConfig = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };
  await expect(services.cleanupWorktree(repositoryFixture(), worktreeFixture(), config, {
    keepBranch: false, discardIgnored: false,
  })).rejects.toThrow("Unexpected service call: cleanupWorktree");
});
