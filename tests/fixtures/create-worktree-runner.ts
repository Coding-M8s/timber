import { readFile } from "node:fs/promises";
import { createWorktree } from "../../src/git/create-worktree";
import type { CreateWorktreeRequest, RepositoryConfig, RepositoryContext } from "../../src/types";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Missing runner input path");
const input = JSON.parse(await readFile(inputPath, "utf8")) as {
  repository: RepositoryContext;
  request: CreateWorktreeRequest;
  config: RepositoryConfig;
};

try {
  await createWorktree(input.repository, input.request, input.config);
  process.stdout.write("created\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 1;
}
