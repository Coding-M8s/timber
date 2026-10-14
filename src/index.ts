#!/usr/bin/env bun
import { showInstallationHint } from "./guidance";
import { createSetupHandler } from "./commands/setup";
import { createSetupPrompt } from "./setup/terminal";
import { checkExecutable } from "./setup/executable";
import { inspectSetupTarget, saveSetupConfig } from "./setup/storage";
import { launchAgent } from "./agent";
import { placeholderHandlers, runCli } from "./cli";
import { createDoneHandler } from "./commands/done";
import { createListHandler } from "./commands/list";
import { createNewHandler } from "./commands/new";
import { createOpenHandler } from "./commands/open";
import { loadCommandConfig } from "./config";
import { launchEditor } from "./editor";
import { runSetup } from "./hooks";
import { resolveBase } from "./git/branches";
import { cleanupWorktree } from "./git/cleanup";
import { createWorktree } from "./git/create-worktree";
import { resolveOpenTarget } from "./git/open-target";
import { discoverRepository } from "./git/repository";
import { listWorktrees } from "./git/worktrees";
import { findJiraSuggestions, resolveJiraTicket } from "./jira/client";
import { createTerminalChooser, shouldEnableInteractiveSelection } from "./selection";

const choose = shouldEnableInteractiveSelection({
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  ...(process.env.CI === undefined ? {} : { ci: process.env.CI }),
}) ? createTerminalChooser(process.stdin, process.stdout) : undefined;

const ci = process.env.CI?.toLowerCase();

await showInstallationHint({ stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); } });

process.exitCode = await runCli(process.argv.slice(2), {
  handlers: {
    ...placeholderHandlers,
    setup: createSetupHandler({ inspectTarget: inspectSetupTarget, save: saveSetupConfig, checkExecutable,
      prompt: () => createSetupPrompt(process.stdin, process.stdout) }),
    new: createNewHandler({
      discoverRepository, loadCommandConfig, resolveBase, resolveJiraTicket, findJiraSuggestions,
      createWorktree, runSetup, launchEditor, launchAgent,
    }),
    open: createOpenHandler({
      discoverRepository,
      loadCommandConfig,
      resolveOpenTarget,
      createWorktree,
      runSetup,
      launchEditor,
      launchAgent,
    }),
    list: createListHandler({ discoverRepository, listWorktrees, loadCommandConfig }),
    done: createDoneHandler({
      discoverRepository, loadCommandConfig, resolveOpenTarget, cleanupWorktree,
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
