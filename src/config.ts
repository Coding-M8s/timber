import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import type { RepositoryConfig, RepositoryContext } from "./types";

const defaults: RepositoryConfig = {
  baseBranch: null,
  remote: null,
  worktreeDir: null,
  editor: null,
  agent: null,
};

const initialSchema = z.strictObject({
  base_branch: z.string().trim().min(1).optional(),
});

export async function loadRepositoryConfig(repository: RepositoryContext): Promise<RepositoryConfig> {
  const configPath = join(repository.primaryWorktreeRoot, ".timber.toml");
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { ...defaults };
    const code = isNodeError(error) ? error.code ?? "unknown" : "unknown";
    throw new Error(`Cannot read repository config ${configPath} (${code})`);
  }

  const parsed = initialSchema.parse(parse(source));
  return { ...defaults, baseBranch: parsed.base_branch ?? null };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
