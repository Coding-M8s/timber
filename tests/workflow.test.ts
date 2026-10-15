import { expect, test } from "bun:test";
import { resolveWorkflowAgent, selectWorkflow, workflowEditor } from "../src/workflow";
import type { RepositoryConfig } from "../src/types";

const config: RepositoryConfig = {
  baseBranch: null, remote: null, worktreeDir: null,
  editor: { command: "ordinary-editor", args: [], enabled: false },
  agent: { command: "ordinary-agent", args: ["ordinary"], enabled: true },
  workflows: {
    review: { postCreate: ["review-step"], editor: { command: "review-editor", args: [] },
      agent: { command: "review-agent", args: ["prompt"] } },
    quiet: { postCreate: [], agent: false },
  },
};

test("known workflow selects editor and initial agent; repeated open suppresses implicit agents", () => {
  const review = selectWorkflow(config, "review");
  expect(workflowEditor(config, review)?.command).toBe("review-editor");
  expect(resolveWorkflowAgent(config, review, undefined, true, true)?.command).toBe("review-agent");
  expect(resolveWorkflowAgent(config, review, undefined, true, false)).toBeNull();
  expect(resolveWorkflowAgent(config, review, true, true, false)?.args).toEqual(["prompt"]);
  expect(resolveWorkflowAgent(config, review, false, true, true)).toBeNull();
  expect(resolveWorkflowAgent(config, review, undefined, false, true)).toBeNull();
  expect(() => resolveWorkflowAgent(config, review, true, false, true)).toThrow(/interactive/);
});

test("workflow false suppresses inherited agent; explicit agent uses ordinary configuration", () => {
  const quiet = selectWorkflow(config, "quiet");
  expect(resolveWorkflowAgent(config, quiet, undefined, true, true)).toBeNull();
  expect(resolveWorkflowAgent(config, quiet, true, true, false)?.command).toBe("ordinary-agent");
  expect(workflowEditor(config, quiet)?.command).toBe("ordinary-editor");
  expect(resolveWorkflowAgent(config, null, undefined, true, false)?.command).toBe("ordinary-agent");
});

test("workflow editor selection respects ordinary opt-in and explicit flags", () => {
  expect(workflowEditor(config, null)?.enabled).toBe(false);
  expect(workflowEditor(config, null, true)?.enabled).toBe(true);
  expect(workflowEditor(config, selectWorkflow(config, "review"))?.enabled).toBe(true);
  expect(workflowEditor(config, selectWorkflow(config, "review"), false)?.enabled).toBe(false);
  const quiet = { postCreate: [], editor: false as const };
  expect(workflowEditor(config, quiet)).toBeNull();
  expect(workflowEditor(config, quiet, true)?.command).toBe("ordinary-editor");
  expect(() => workflowEditor({ ...config, editor: null }, quiet, true)).toThrow(/Configure an editor/);
});

test("invalid or unknown names fail before a launch is selected", () => {
  expect(() => selectWorkflow(config, "Review")).toThrow(/Invalid workflow name/);
  expect(() => selectWorkflow(config, "absent")).toThrow(/Unknown workflow/);
  expect(() => selectWorkflow({ ...config, workflows: {} }, "constructor")).toThrow(/Unknown workflow/);
});
