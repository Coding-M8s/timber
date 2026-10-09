import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

const executableSchema = z.strictObject({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
});

const configFileSchema = z.strictObject({
  base_branch: z.string().trim().min(1).optional(),
  remote: z.string().trim().min(1).optional(),
  worktree_dir: z.string().trim().min(1).optional(),
  editor: executableSchema.optional(),
  agent: z.strictObject({
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    enabled: z.boolean().default(false),
  }).optional(),
});

export async function loadRepositoryConfig(repository: RepositoryContext): Promise<RepositoryConfig> {
  const configPath = join(repository.primaryWorktreeRoot, ".timber.toml");
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { ...defaults };
    throw new Error(`Cannot read repository config ${configPath} (${code ?? "unknown"})`);
  }

  let input: unknown;
  try {
    input = parse(source);
  } catch {
    throw new Error(`Invalid TOML in ${configPath}`);
  }

  const result = configFileSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map(issue => {
      const path = issue.code === "unrecognized_keys" ? [...issue.path, ...issue.keys] : issue.path;
      const field = path.map(String).join(".") || "<root>";
      const problem = issue.code === "unrecognized_keys" ? "is not supported" : "is invalid";
      return `${field} ${problem}`;
    });
    throw new Error(`Invalid repository config ${configPath}: ${details.join("; ")}`);
  }

  const config = result.data;
  return {
    baseBranch: config.base_branch ?? null,
    remote: config.remote ?? null,
    worktreeDir: config.worktree_dir === undefined
      ? null
      : resolve(repository.primaryWorktreeRoot, config.worktree_dir),
    editor: config.editor ?? null,
    agent: config.agent ?? null,
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
