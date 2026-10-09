import { readFile } from "node:fs/promises";
import { cleanupWorktree } from "../../src/git/cleanup";
import type { CleanupOptions, RepositoryConfig, RepositoryContext, Worktree } from "../../src/types";

type Request = {
  repository: RepositoryContext;
  worktree: Worktree;
  config: RepositoryConfig;
  options: CleanupOptions;
};

try {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Cleanup runner requires a fixture path.");
  const request = JSON.parse(await readFile(inputPath, "utf8")) as Request;
  const result = await cleanupWorktree(request.repository, request.worktree, request.config, request.options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Cleanup failed; inspect Git state and retry."}\n`);
  process.exitCode = 1;
}
