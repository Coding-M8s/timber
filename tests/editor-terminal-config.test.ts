import { expect, test } from "bun:test";
import { parseConfigSource, resolveConfig } from "../src/config";
import { renderConfig } from "../src/setup/render";
import { resolveWorkflowAgent, workflowEditor } from "../src/workflow";

function config(global: string, local = "") {
  return resolveConfig({ global: { path: "/global", source: global, values: parseConfigSource(global, "/global") },
    local: { path: "/repo/.timber.toml", source: local, values: parseConfigSource(local, "/repo/.timber.toml") } }, "/repo");
}

test("Orca selection and setup dependency survive config rendering and workflow selection", () => {
  const source = '[editor]\ncommand = "orca-ide"\nintegration = "orca"\nenabled = true\n' +
    '[agent]\ncommand = "claude"\nwait_for_setup = true\nenabled = true\n' +
    '[workflows.review.editor]\ncommand = "orca-ide"\nintegration = "orca"\n' +
    '[workflows.review.agent]\ncommand = "codex"\nwait_for_setup = false\n';
  const resolved = config(renderConfig(parseConfigSource(source, "/config")));
  expect(resolved.editor).toMatchObject({ integration: "orca", enabled: true });
  expect(resolveWorkflowAgent(resolved, null, true, true, true)).toMatchObject({ waitForSetup: true });
  expect(workflowEditor(resolved, resolved.workflows!.review!)).toMatchObject({ integration: "orca", enabled: true });
  expect(resolveWorkflowAgent(resolved, resolved.workflows!.review!, true, true, true))
    .toMatchObject({ command: "codex", waitForSetup: false });
});

test("local tables replace integration and dependency preferences instead of merging them", () => {
  const inherited = '[editor]\ncommand = "orca-ide"\nintegration = "orca"\nenabled = true\n' +
    '[agent]\ncommand = "claude"\nwait_for_setup = true\n';
  const resolved = config(inherited, '[editor]\ncommand = "zed"\n[agent]\ncommand = "codex"\n');
  expect(resolved.editor).toEqual({ command: "zed", args: [], enabled: false });
  expect(resolved.agent?.waitForSetup ?? false).toBe(false);
  expect(config(inherited, 'editor = false\nagent = false\n').editor).toBeNull();
  expect(config(inherited, 'editor = false\nagent = false\n').agent).toBeNull();
});

test.each([
  'integration = "zed"',
  'integration = "vscode"',
  'integration = "code"',
  'integration = true',
  'wait_for_setup = "true"',
  'wait_for_setup = 1',
])(
  "invalid launch preference fails in either scope: %s", field => {
    const table = field.startsWith("integration") ? "editor" : "agent";
    expect(() => config(`[${table}]\ncommand = "sentinel"\n${field}\n`, `${table} = false\n`))
      .toThrow(/Invalid config \/global/);
  });

test("VS Code editor tables stay on the generic launcher without an integration key", () => {
  const source = '[editor]\ncommand = "code"\nargs = ["--new-window"]\nenabled = true\n' +
    '[agent]\ncommand = "claude"\nenabled = true\nwait_for_setup = true\n';
  const resolved = config(source);
  expect(resolved.editor).toEqual({ command: "code", args: ["--new-window"], enabled: true });
  expect(resolved.editor).not.toHaveProperty("integration");
  expect(resolved.agent).toMatchObject({ command: "claude", enabled: true, waitForSetup: true });
});
