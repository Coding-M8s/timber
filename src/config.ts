import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { globalConfigPath } from "./config-paths";
import { validateParticipant } from "./arena/participants";
import { nativeArenaTools, nativeArenaToolSpecs } from "./arena/tools";
import { parseStorageSize } from "./backup/retention";
import { maxRetentionDays } from "./backup/storage";
import type { IssueListSettings, RepositoryConfig, RepositoryContext } from "./types";

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
const editorCommandSchema = executableSchema.extend({ integration: z.enum(["orca", "vscode"]).optional() });
const agentCommandSchema = executableSchema.extend({ wait_for_setup: z.boolean().optional() });
const editorSchema = editorCommandSchema.extend({ enabled: z.boolean().default(false) });

/** Extra text appended to the built-in `rebase --resolve` task. */
export const resolveInstructionsSchema = z.string().trim().min(1).max(4000).refine(value => !value.includes("\0"));

const hookStepsSchema = z.array(z.string().refine(value => value.trim().length > 0 && !value.includes("\0")));
const workflowSchema = z.strictObject({
  description: z.string().trim().min(1).optional(),
  post_create: hookStepsSchema.default([]),
  editor: z.union([z.literal(false), editorCommandSchema]).optional(),
  agent: z.union([z.literal(false), agentCommandSchema]).optional(),
});
const arenaPresetSchema = z.strictObject({
  tool: z.enum([...nativeArenaTools, "wrapper"]),
  model: z.string().optional(),
  effort: z.string().optional(),
  command: z.string().refine(value => value.trim().length > 0 && !value.includes("\0")),
  args: z.array(z.string().refine(value => !value.includes("\0"))).default([]),
}).superRefine((preset, context) => {
  try { validateParticipant(preset); }
  catch {
    const field = (preset.command.includes("/") || (process.platform === "win32" && preset.command.includes("\\"))) && !isAbsolute(preset.command) ? "command"
      : preset.effort !== undefined && preset.tool !== "wrapper" && !nativeArenaToolSpecs[preset.tool].effort ? "effort"
        : preset.model !== undefined && validatesWithoutModel(preset) ? "model" : "args";
    context.addIssue({ code: "custom", path: [field], message: "Invalid arena executable or native arguments." });
  }
});
/** The saved model field alone is the problem, such as an Amp model that is not provider/name. */
function validatesWithoutModel(preset: Parameters<typeof validateParticipant>[0]): boolean {
  const { model: _model, ...rest } = preset;
  try { validateParticipant(rest); return true; } catch { return false; }
}
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

const jiraProjectSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,254}$/u).transform(value => value.toUpperCase());

export const configFileSchema = z.strictObject({
  default_tracker: z.enum(["github", "linear", "jira", "none"]).optional(),
  arena: z.union([z.literal(false), z.strictObject({
    agents: z.record(arenaPresetNameSchema, z.union([z.literal(false), arenaPresetSchema])).default({}),
  })]).optional(),
  base_branch: z.string().trim().min(1).optional(),
  remote: z.string().trim().min(1).optional(),
  max_generated_branch_name_length: z.number().int().positive().optional(),
  update_check: z.boolean().optional(),
  backup_retention_days: z.union([z.literal(false), z.number().int().min(1).max(maxRetentionDays)]).optional(),
  backup_storage_warning: z.union([z.literal(false), z.string().refine(value => parseStorageSize(value) !== null)]).optional(),
  worktree_dir: z.string().refine(value => value.trim().length > 0).optional(),
  hooks: z.union([z.literal(false), z.strictObject({
    post_create: hookStepsSchema.default([]),
    pre_delete: hookStepsSchema.optional(),
  })]).optional(),
  workflows: z.union([z.literal(false), z.record(workflowNameSchema,
    z.union([z.literal(false), workflowSchema]))]).optional(),
  editor: z.union([z.literal(false), editorSchema]).optional(),
  agent: z.union([z.literal(false), agentCommandSchema.extend({
    enabled: z.boolean().default(false),
    // How `timber rebase --resolve` hands its task to this command; never guessed.
    resolve_handoff: z.enum(["codex", "claude", "cursor", "wrapper"]).optional(),
    resolve_instructions: resolveInstructionsSchema.optional(),
  })]).optional(),
  jira: z.union([z.literal(false), z.strictObject({
    site_url: jiraSiteSchema,
    cloud_id: z.uuid().optional(),
    board: z.number().int().positive().optional(),
    sprint_jql: z.string().trim().min(1).max(2000).optional(),
    project: jiraProjectSchema.optional(),
  }).refine(value => value.board === undefined || value.sprint_jql === undefined,
    { message: "Use board or sprint_jql, not both", path: ["sprint_jql"] })]).optional(),
  github: z.union([z.literal(false), z.strictObject({
    project: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[1-9][0-9]{0,8}$/u).optional(),
    milestone: z.string().trim().min(1).max(255).optional(),
  })]).optional(),
  linear: z.union([z.literal(false), z.strictObject({
    team: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,6}$/u).transform(value => value.toUpperCase()).optional(),
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
    throw new Error(`Invalid config ${configPath}: ${configIssueFields(result.error.issues).join("; ")}`);
  }

  return result.data;
}

/** One "<field> is invalid" or "<field> is not supported" entry per issue; never a value. */
export function configIssueFields(issues: readonly z.core.$ZodIssue[]): string[] {
  return configIssues(issues).flatMap(issue => {
    const paths = issue.code === "unrecognized_keys"
      ? issue.keys.map(key => [...issue.path, key])
      : [issue.path];
    const problem = issue.code === "unrecognized_keys" ? "is not supported" : "is invalid";
    return paths.map(path => {
      const field = path.map(String).join(".") || "<root>";
      return `${field} ${problem}`;
    });
  });
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

function normalizedTopLevelAgent(value: Exclude<NonNullable<ConfigFile["agent"]>, false>) {
  const { resolve_handoff, resolve_instructions, ...command } = value;
  return {
    ...normalizedAgent(command),
    ...(resolve_handoff === undefined ? {} : { resolveHandoff: resolve_handoff }),
    ...(resolve_instructions === undefined ? {} : { resolveInstructions: resolve_instructions }),
  };
}

/**
 * File-shaped settings after inheritance. Repository keys replace machine defaults,
 * workflow and arena tables merge by name, and everything switched off is dropped.
 */
export function effectiveConfigValues(scopes: ConfigScopes): ConfigFile {
  const config = { ...scopes.global.values, ...scopes.local?.values };
  const globalWorkflows = scopes.global.values.workflows;
  const localWorkflows = scopes.local?.values.workflows;
  const mergedWorkflows = localWorkflows === false ? {}
    : { ...(typeof globalWorkflows === "object" ? globalWorkflows : {}),
      ...(typeof localWorkflows === "object" ? localWorkflows : {}) };
  const globalArena = scopes.global.values.arena;
  const localArena = scopes.local?.values.arena;
  const arenaAgents = localArena === false ? {} : {
    ...(globalArena ? globalArena.agents : {}), ...(localArena ? localArena.agents : {}),
  };
  const enabled = <T>(table: Record<string, T | false>) =>
    Object.fromEntries(Object.entries(table).filter((entry): entry is [string, T] => entry[1] !== false));
  return {
    ...(config.default_tracker === undefined ? {} : { default_tracker: config.default_tracker }),
    ...(globalArena === undefined && localArena === undefined ? {} : { arena: { agents: enabled(arenaAgents) } }),
    ...(config.max_generated_branch_name_length === undefined ? {} : {
      max_generated_branch_name_length: config.max_generated_branch_name_length,
    }),
    ...(config.backup_retention_days === undefined ? {} : { backup_retention_days: config.backup_retention_days }),
    ...(config.backup_storage_warning === undefined ? {} : { backup_storage_warning: config.backup_storage_warning }),
    ...(config.base_branch === undefined ? {} : { base_branch: config.base_branch }),
    ...(config.remote === undefined ? {} : { remote: config.remote }),
    ...(config.worktree_dir === undefined ? {} : { worktree_dir: config.worktree_dir }),
    ...(config.hooks ? { hooks: config.hooks } : {}),
    ...(globalWorkflows === undefined && localWorkflows === undefined ? {} : { workflows: enabled(mergedWorkflows) }),
    ...(config.editor ? { editor: config.editor } : {}),
    ...(config.agent ? { agent: config.agent } : {}),
    ...(config.jira ? { jira: config.jira } : {}),
    ...(config.github ? { github: config.github } : {}),
    ...(config.linear ? { linear: config.linear } : {}),
  };
}

export function resolveConfig(scopes: ConfigScopes, primaryRoot: string): RepositoryConfig {
  const config = effectiveConfigValues(scopes);
  const workflows = Object.fromEntries(Object.entries(config.workflows || {})
    .flatMap(([name, value]) => value === false ? [] : [[name, {
      ...(value.description === undefined ? {} : { description: value.description }),
      postCreate: value.post_create,
      ...(value.editor === undefined ? {} : { editor: value.editor }),
      ...(value.agent === undefined ? {} : { agent: value.agent === false ? false as const : normalizedAgent(value.agent) }),
    }]]));
  return {
    ...defaults,
    ...(config.default_tracker === undefined ? {} : { defaultTracker: config.default_tracker }),
    ...(config.arena ? {
      arena: { agents: Object.fromEntries(Object.entries(config.arena.agents).filter((entry): entry is [string, Exclude<typeof entry[1], false>] => entry[1] !== false)) },
    } : {}),
    ...(config.max_generated_branch_name_length === undefined ? {} : {
      maxGeneratedBranchNameLength: config.max_generated_branch_name_length,
    }),
    ...(config.backup_retention_days === undefined ? {} : {
      backupRetentionDays: config.backup_retention_days === false ? null : config.backup_retention_days,
    }),
    ...(config.backup_storage_warning === undefined ? {} : {
      backupStorageWarningBytes: config.backup_storage_warning === false ? null : parseStorageSize(config.backup_storage_warning),
    }),
    baseBranch: config.base_branch ?? null,
    remote: config.remote ?? null,
    worktreeDir: config.worktree_dir === undefined ? null : resolve(primaryRoot, config.worktree_dir),
    editor: config.editor || null,
    agent: config.agent ? normalizedTopLevelAgent(config.agent) : null,
    ...(config.workflows === undefined ? {} : { workflows }),
    ...(config.hooks ? { hooks: { postCreate: config.hooks.post_create,
      ...(config.hooks.pre_delete === undefined ? {} : { preDelete: config.hooks.pre_delete }) } } : {}),
    ...(config.jira ? { jira: {
      siteUrl: config.jira.site_url,
      ...(config.jira.cloud_id === undefined ? {} : { cloudId: config.jira.cloud_id }),
    } } : {}),
    ...issueListSettings(config),
  };
}

/** Absent when no list setting is configured, so configs without them resolve as before. */
function issueListSettings(config: ConfigFile): { issueLists?: IssueListSettings } {
  const { jira, github, linear } = config;
  const lists: IssueListSettings = {
    jira: {
      ...(jira && jira.board !== undefined ? { board: jira.board } : {}),
      ...(jira && jira.sprint_jql !== undefined ? { sprintJql: jira.sprint_jql } : {}),
      ...(jira && jira.project !== undefined ? { project: jira.project } : {}),
    },
    github: {
      ...(github && github.project !== undefined ? { project: github.project } : {}),
      ...(github && github.milestone !== undefined ? { milestone: github.milestone } : {}),
    },
    linear: linear && linear.team !== undefined ? { team: linear.team } : {},
  };
  const empty = Object.values(lists).every(settings => Object.keys(settings).length === 0);
  return empty ? {} : { issueLists: lists };
}

export async function loadRepositoryConfig(repository: RepositoryContext, env: NodeJS.ProcessEnv = process.env): Promise<RepositoryConfig> {
  return resolveConfig(await loadConfigScopes(repository.primaryWorktreeRoot, env), repository.primaryWorktreeRoot);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
