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
  command: z.string().refine(value => value.trim().length > 0),
  args: z.array(z.string()).default([]),
});

const jiraSiteSchema = z.string().refine(value => {
  if (value !== value.trim() || /[\u0000-\u0020\u007f\\]/u.test(value)) return false;
  // Check the raw form before URL parsing, which normalizes dot segments and backslashes.
  if (!/^https:\/\/[^/?#]+\/?$/iu.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      && url.port === "" && url.pathname === "/" && url.search === "" && url.hash === ""
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/.test(url.hostname);
  } catch {
    return false;
  }
}).transform(value => new URL(value).origin);

const configFileSchema = z.strictObject({
  base_branch: z.string().trim().min(1).optional(),
  remote: z.string().trim().min(1).optional(),
  worktree_dir: z.string().refine(value => value.trim().length > 0).optional(),
  hooks: z.strictObject({
    post_create: z.array(z.string().refine(value => value.trim().length > 0 && !value.includes("\0")))
      .default([]),
  }).optional(),
  editor: executableSchema.optional(),
  agent: z.strictObject({
    command: z.string().refine(value => value.trim().length > 0),
    args: z.array(z.string()).default([]),
    enabled: z.boolean().default(false),
  }).optional(),
  jira: z.strictObject({
    site_url: jiraSiteSchema,
    cloud_id: z.uuid().optional(),
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
    const details = result.error.issues.flatMap(issue => {
      const paths = issue.code === "unrecognized_keys"
        ? issue.keys.map(key => [...issue.path, key])
        : [issue.path];
      const problem = issue.code === "unrecognized_keys" ? "is not supported" : "is invalid";
      return paths.map(path => {
        const field = path.map(String).join(".") || "<root>";
        return `${field} ${problem}`;
      });
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
    ...(config.hooks === undefined ? {} : { hooks: { postCreate: config.hooks.post_create } }),
    ...(config.jira === undefined ? {} : {
      jira: {
        siteUrl: config.jira.site_url,
        ...(config.jira.cloud_id === undefined ? {} : { cloudId: config.jira.cloud_id }),
      },
    }),
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
