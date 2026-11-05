import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { globalConfigPath } from "./config-paths";
import { validateParticipant } from "./arena/participants";
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
const editorCommandSchema = executableSchema.extend({ integration: z.literal("orca").optional() });
const agentCommandSchema = executableSchema.extend({ wait_for_setup: z.boolean().optional() });
const editorSchema = editorCommandSchema.extend({ enabled: z.boolean().default(false) });

const hookStepsSchema = z.array(z.string().refine(value => value.trim().length > 0 && !value.includes("\0")));
const workflowSchema = z.strictObject({
  description: z.string().trim().min(1).optional(),
  post_create: hookStepsSchema.default([]),
  editor: z.union([z.literal(false), editorCommandSchema]).optional(),
  agent: z.union([z.literal(false), agentCommandSchema]).optional(),
});
const arenaPresetSchema = z.strictObject({
  tool: z.enum(["codex", "claude", "cursor", "wrapper"]),
  model: z.string().optional(),
  effort: z.string().optional(),
  command: z.string().refine(value => value.trim().length > 0 && !value.includes("\0")),
  args: z.array(z.string().refine(value => !value.includes("\0"))).default([]),
}).superRefine((preset, context) => {
  try { validateParticipant(preset); }
  catch {
    const field = (preset.command.includes("/") || (process.platform === "win32" && preset.command.includes("\\"))) && !isAbsolute(preset.command) ? "command" : "args";
    context.addIssue({ code: "custom", path: [field], message: "Invalid arena executable or native arguments." });
  }
});
const arenaPresetNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/u).refine(name => name !== "manual" && name !== "configured");
const workflowNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/u);

export const jiraSiteSchema = z.string().refine(value => {
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

export const configFileSchema = z.strictObject({
  default_tracker: z.enum(["github", "linear", "jira", "none"]).optional(),
  arena: z.union([z.literal(false), z.strictObject({
    agents: z.record(arenaPresetNameSchema, z.union([z.literal(false), arenaPresetSchema])).default({}),
  })]).optional(),
  base_branch: z.string().trim().min(1).optional(),
  remote: z.string().trim().min(1).optional(),
  worktree_dir: z.string().refine(value => value.trim().length > 0).optional(),
  hooks: z.union([z.literal(false), z.strictObject({
    post_create: hookStepsSchema.default([]),
    pre_delete: hookStepsSchema.optional(),
  })]).optional(),
  workflows: z.union([z.literal(false), z.record(workflowNameSchema,
    z.union([z.literal(false), workflowSchema]))]).optional(),
  editor: z.union([z.literal(false), editorSchema]).optional(),
  agent: z.union([z.literal(false), agentCommandSchema.extend({ enabled: z.boolean().default(false) })]).optional(),
  jira: z.union([z.literal(false), z.strictObject({
    site_url: jiraSiteSchema,
    cloud_id: z.uuid().optional(),
  })]).optional(),
});

export type ConfigFile = z.infer<typeof configFileSchema>;
export interface ConfigScope { path: string; source: string | null; values: ConfigFile }
export interface ConfigScopes { global: ConfigScope; local: ConfigScope | null }

export async function readConfigScope(path: string): Promise<ConfigScope> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { path, source: null, values: {} };
    throw new Error(`Cannot read config ${path} (${code ?? "unknown"})`);
  }
  return { path, source, values: parseConfigSource(source, path) };
}

export async function loadConfigScopes(primaryRoot?: string, env: NodeJS.ProcessEnv = process.env): Promise<ConfigScopes> {
  const global = await readConfigScope(globalConfigPath(env));
  const local = primaryRoot === undefined ? null : await readConfigScope(join(primaryRoot, ".timber.toml"));
  return { global, local };
}

export function parseConfigSource(source: string, configPath: string): ConfigFile {
  let input: unknown;
  try {
    input = parse(source);
  } catch {
    throw new Error(`Invalid TOML in ${configPath}`);
  }

  const result = configFileSchema.safeParse(input);
  if (!result.success) {
    const details = configIssues(result.error.issues).flatMap(issue => {
      const paths = issue.code === "unrecognized_keys"
        ? issue.keys.map(key => [...issue.path, key])
        : [issue.path];
      const problem = issue.code === "unrecognized_keys" ? "is not supported" : "is invalid";
      return paths.map(path => {
        const field = path.map(String).join(".") || "<root>";
        return `${field} ${problem}`;
      });
    });
    throw new Error(`Invalid config ${configPath}: ${details.join("; ")}`);
  }

  return result.data;
}

// The false/table unions retain the existing precise field diagnostics.
function configIssues(issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[] = []): z.core.$ZodIssue[] {
  return issues.flatMap(issue => issue.code === "invalid_union"
    ? configIssues(issue.errors[1] ?? [], [...prefix, ...issue.path])
    : [{ ...issue, path: [...prefix, ...issue.path] }]);
}

function normalizedAgent<T extends { wait_for_setup?: boolean | undefined }>(value: T) {
  const { wait_for_setup, ...command } = value;
  return { ...command, ...(wait_for_setup === undefined ? {} : { waitForSetup: wait_for_setup }) };
}

export function resolveConfig(scopes: ConfigScopes, primaryRoot: string): RepositoryConfig {
  const config = { ...scopes.global.values, ...scopes.local?.values };
  const globalWorkflows = scopes.global.values.workflows;
  const localWorkflows = scopes.local?.values.workflows;
  const mergedWorkflows = localWorkflows === false ? {}
    : { ...(typeof globalWorkflows === "object" ? globalWorkflows : {}),
      ...(typeof localWorkflows === "object" ? localWorkflows : {}) };
  const workflows = Object.fromEntries(Object.entries(mergedWorkflows)
    .flatMap(([name, value]) => value === false ? [] : [[name, {
      ...(value.description === undefined ? {} : { description: value.description }),
      postCreate: value.post_create,
      ...(value.editor === undefined ? {} : { editor: value.editor }),
      ...(value.agent === undefined ? {} : { agent: value.agent === false ? false as const : normalizedAgent(value.agent) }),
    }]]));
  const globalArena = scopes.global.values.arena;
  const localArena = scopes.local?.values.arena;
  const arenaAgents = localArena === false ? {} : {
    ...(globalArena ? globalArena.agents : {}), ...(localArena ? localArena.agents : {}),
  };
  return {
    ...defaults,
    ...(config.default_tracker === undefined ? {} : { defaultTracker: config.default_tracker }),
    ...(globalArena === undefined && localArena === undefined ? {} : {
      arena: { agents: Object.fromEntries(Object.entries(arenaAgents).filter((entry): entry is [string, Exclude<typeof entry[1], false>] => entry[1] !== false)) },
    }),
    baseBranch: config.base_branch ?? null,
    remote: config.remote ?? null,
    worktreeDir: config.worktree_dir === undefined ? null : resolve(primaryRoot, config.worktree_dir),
    editor: config.editor || null,
    agent: config.agent ? normalizedAgent(config.agent) : null,
    ...(globalWorkflows === undefined && localWorkflows === undefined ? {} : { workflows }),
    ...(config.hooks ? { hooks: { postCreate: config.hooks.post_create,
      ...(config.hooks.pre_delete === undefined ? {} : { preDelete: config.hooks.pre_delete }) } } : {}),
    ...(config.jira ? { jira: {
      siteUrl: config.jira.site_url,
      ...(config.jira.cloud_id === undefined ? {} : { cloudId: config.jira.cloud_id }),
    } } : {}),
  };
}

export async function loadRepositoryConfig(repository: RepositoryContext, env: NodeJS.ProcessEnv = process.env): Promise<RepositoryConfig> {
  return resolveConfig(await loadConfigScopes(repository.primaryWorktreeRoot, env), repository.primaryWorktreeRoot);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
