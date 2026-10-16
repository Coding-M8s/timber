import { resolveAgentCommand } from "./agent";
import type { AgentCommand, AgentConfig, EditorConfig, RepositoryConfig, WorkflowConfig } from "./types";

/** Selecting a name never guesses another workflow. */
export function selectWorkflow(config: RepositoryConfig, name: string | null): WorkflowConfig | null {
  if (name === null) return null;
  if (!/^[a-z][a-z0-9_-]*$/u.test(name)) throw new Error("Invalid workflow name. Use lowercase letters, digits, hyphens, or underscores, starting with a letter.");
  if (config.workflows === undefined || !Object.hasOwn(config.workflows, name)) {
    throw new Error("Unknown workflow. Restore its definition or assign another configured workflow with --workflow <name>.");
  }
  return config.workflows[name]!;
}

export function workflowEditor(
  config: RepositoryConfig, workflow: WorkflowConfig | null, explicit?: boolean,
): EditorConfig | null {
  const selected = workflow?.editor;
  const editor = selected === false ? explicit === true ? config.editor : null
    : selected === undefined ? config.editor : { ...selected, enabled: true };
  if (explicit === true && editor === null) {
    throw new Error("Configure an editor before using --editor. Run timber setup in this repository or timber setup --global for machine defaults.");
  }
  return editor === null || explicit === undefined ? editor : { ...editor, enabled: explicit };
}

/** A saved workflow has no implicit agent on reopen, including global defaults. */
export function resolveWorkflowAgent(
  config: RepositoryConfig, workflow: WorkflowConfig | null,
  explicit: boolean | undefined, interactive: boolean, created: boolean,
): AgentCommand | null {
  if (workflow === null) return resolveAgentCommand(config, explicit, interactive);
  if (explicit === false || (!created && explicit !== true)) return null;
  const configured: AgentConfig | null = workflow.agent === false
    ? explicit === true ? config.agent : null
    : workflow.agent === undefined ? config.agent
      : { ...workflow.agent, enabled: true };
  return resolveAgentCommand({ ...config, agent: configured }, explicit, interactive);
}
