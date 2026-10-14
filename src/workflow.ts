import { resolveAgentCommand } from "./agent";
import type { AgentConfig, ExecutableCommand, RepositoryConfig, WorkflowConfig } from "./types";

/** Selecting a name never guesses another workflow. */
export function selectWorkflow(config: RepositoryConfig, name: string | null): WorkflowConfig | null {
  if (name === null) return null;
  if (!/^[a-z][a-z0-9_-]*$/u.test(name)) throw new Error("Invalid workflow name. Use lowercase letters, digits, hyphens, or underscores, starting with a letter.");
  if (config.workflows === undefined || !Object.hasOwn(config.workflows, name)) {
    throw new Error("Unknown workflow. Restore its definition or assign another configured workflow with --workflow <name>.");
  }
  return config.workflows[name]!;
}

export function workflowEditor(config: RepositoryConfig, workflow: WorkflowConfig | null): ExecutableCommand | null {
  const editor = workflow?.editor;
  return editor === false ? null : editor ?? config.editor;
}

/** A saved workflow has no implicit agent on reopen, including global defaults. */
export function resolveWorkflowAgent(
  config: RepositoryConfig, workflow: WorkflowConfig | null,
  explicit: boolean | undefined, interactive: boolean, created: boolean,
): ExecutableCommand | null {
  if (workflow === null) return resolveAgentCommand(config, explicit, interactive);
  if (explicit === false || (!created && explicit !== true)) return null;
  const configured: AgentConfig | null = workflow.agent === false
    ? explicit === true ? config.agent : null
    : workflow.agent === undefined ? config.agent
      : { ...workflow.agent, enabled: true };
  return resolveAgentCommand({ ...config, agent: configured }, explicit, interactive);
}
