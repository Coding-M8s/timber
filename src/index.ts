#!/usr/bin/env bun
import { showInstallationHint } from "./guidance";
import { runEditorTask } from "./editor-terminals/runner";
import { createEditorTerminalLauncher } from "./editor-terminals/launch";
import { createSetupHandler } from "./commands/setup";
import { createSetupPrompt } from "./setup/terminal";
import { checkExecutable } from "./setup/executable";
import { inspectSetupTarget, saveSetupConfig } from "./setup/storage";
import { createJiraSetupSession } from "./setup/jira";
import { launchAgent } from "./agent";
import { placeholderHandlers, runCli } from "./cli";
import { createDoneHandler } from "./commands/done";
import { createListHandler } from "./commands/list";
import { createNewHandler } from "./commands/new";
import { createOpenHandler } from "./commands/open";
import { loadRepositoryConfig } from "./config";
import { launchEditor } from "./editor";
import { runSetup } from "./hooks";
import { resolveBase } from "./git/branches";
import { cleanupWorktree } from "./git/cleanup";
import { createWorktree } from "./git/create-worktree";
import { resolveOpenTarget } from "./git/open-target";
import { discoverRepository } from "./git/repository";
import { listWorktrees } from "./git/worktrees";
import { readWorkflowAssociation, writeWorkflowAssociation } from "./git/workflow-metadata";
import { findJiraSuggestions, resolveJiraTicket } from "./jira/client";
import { createTerminalChooser, shouldEnableInteractiveSelection } from "./selection";

if (process.argv[2] === "__editor-task") {
  process.exit(await runEditorTask(process.argv.length === 4 ? process.argv[3]! : ""));
}

const completing = process.argv[2] === "completion" || process.argv[2] === "__complete";
const choose = !completing && shouldEnableInteractiveSelection({
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  ...(process.env.CI === undefined ? {} : { ci: process.env.CI }),
}) ? createTerminalChooser(process.stdin, process.stdout) : undefined;

const ci = process.env.CI?.toLowerCase();
const launchEditorTerminals = createEditorTerminalLauncher({ self: { executable: process.execPath,
  ...(Bun.main.startsWith("/$bunfs/") ? {} : { entry: Bun.main }) } });

if (!completing) {
  await showInstallationHint({ stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); } });
}

process.exitCode = await runCli(process.argv.slice(2), {
  handlers: {
    ...placeholderHandlers,
    setup: createSetupHandler({ inspectTarget: inspectSetupTarget, save: saveSetupConfig, checkExecutable,
      jira: createJiraSetupSession,
      prompt: () => createSetupPrompt(process.stdin, process.stdout) }),
    new: createNewHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, resolveBase, resolveJiraTicket, findJiraSuggestions,
      createWorktree, writeWorkflowAssociation, runSetup, launchEditor, launchAgent, launchEditorTerminals,
    }),
    open: createOpenHandler({
      discoverRepository,
      loadConfig: loadRepositoryConfig,
      resolveOpenTarget,
      createWorktree, readWorkflowAssociation, writeWorkflowAssociation,
      runSetup,
      launchEditor,
      launchAgent,
      launchEditorTerminals,
    }),
    list: createListHandler({ discoverRepository, listWorktrees, loadConfig: loadRepositoryConfig,
      readWorkflowAssociation }),
    done: createDoneHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, resolveOpenTarget, cleanupWorktree,
    }),
  },
  context: {
    cwd: process.cwd(),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true
      && (!ci || ci === "0" || ci === "false"),
    io: {
      stdout: text => { process.stdout.write(text); },
      stderr: text => { process.stderr.write(text); },
    },
    ...(choose ? { choose } : {}),
  },
});
