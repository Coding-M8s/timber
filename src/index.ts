#!/usr/bin/env bun
import { resolveArenaSource, finalizeArenaSource } from "./arena/source";
import { createArenaResumeHandler } from "./commands/arena-resume";
import { createArenaNewHandler } from "./commands/arena-new";
import { collectArenaInput } from "./arena/input";
import { confirmArenaPlan, chooseArenaSource } from "./arena/prompt";
import { planArenaDraft } from "./arena/plan";
import { reserveArena, readArena, openArenaForResume, validateArenaAttempt } from "./arena/storage";
import { showInstallationHint } from "./guidance";
import { runEditorTask } from "./editor-terminals/runner";
import { createEditorTerminalLauncher } from "./editor-terminals/launch";
import { createSetupHandler } from "./commands/setup";
import { createSetupPrompt } from "./setup/terminal";
import { checkExecutable } from "./setup/executable";
import { inspectSetupTarget, saveSetupConfig } from "./setup/storage";
import { createJiraSetupSession } from "./setup/jira";
import { launchAgent } from "./agent";
import { runCli } from "./cli";
import { createRebaseHandler } from "./commands/rebase";
import { createBackupCreateHandler, createBackupRestoreHandler } from "./commands/backup";
import { createBackup, restoreBackup } from "./backup/service";
import { rebaseWorktree, resolveRebaseTarget } from "./git/rebase";
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
import { readBaseAssociation, writeBaseAssociation } from "./git/base-metadata";
import { findJiraSuggestions, resolveJiraTicket } from "./jira/client";
import { resolveGithubRepository } from "./github/repository";
import { resolveLinearTicket } from "./linear/client";
import { resolveGithubTicket } from "./github/client";
import { createLinearSetupSession } from "./setup/linear";
import { createGithubSetupSession } from "./setup/github";
import { createTerminalChooser, shouldEnableInteractiveSelection } from "./selection";

if (process.argv[2] === "__editor-task") {
  process.exit(await runEditorTask(process.argv.length === 4 ? process.argv[3]! : ""));
}

const completing = process.argv[2] === "completion"
  || process.argv[2] === "__complete"
  || process.argv[2] === "__complete-words";
const choose = !completing && shouldEnableInteractiveSelection({
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  ...(process.env.CI === undefined ? {} : { ci: process.env.CI }),
}) ? createTerminalChooser(process.stdin, process.stdout) : undefined;

const ci = process.env.CI?.toLowerCase();
const launchEditorTerminals = createEditorTerminalLauncher({ self: { executable: process.execPath,
  ...(Bun.main.startsWith("/$bunfs/") ? {} : { entry: Bun.main }) } });

const machineListing = (process.argv[2] === "ls" && process.argv.slice(3).includes("--json"))
  || process.argv[2] === "__app-config";
if (!completing && !machineListing) {
  await showInstallationHint({ stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); } });
}

process.exitCode = await runCli(process.argv.slice(2), {
  handlers: {
    arenaNew: createArenaNewHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, resolveSource: resolveArenaSource, finalizeSource: finalizeArenaSource, createWorktree,
      planDraft: planArenaDraft, reserveArena, validateArenaAttempt, checkExecutable, runSetup, launchEditor, launchAgent,
      collectInput: (options, config, context) => collectArenaInput(options, config, context,
        () => createSetupPrompt(process.stdin, process.stdout)),
      confirmPlan: (plan, review) => review ? review(plan) : confirmArenaPlan(plan, () => createSetupPrompt(process.stdin, process.stdout)),
      chooseSource: async candidates => {
        const prompt = createSetupPrompt(process.stdin, process.stdout);
        try {return await chooseArenaSource(candidates, prompt);} finally {prompt.close();}
      },
    }),
    arenaResume: createArenaResumeHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, readArena, openArenaForResume,
      validateArenaAttempt, checkExecutable, runSetup, launchEditor, launchAgent,
    }),
    setup: createSetupHandler({ inspectTarget: inspectSetupTarget, save: saveSetupConfig, checkExecutable,
      jira: createJiraSetupSession,
      github: createGithubSetupSession,
      linear: createLinearSetupSession,
      prompt: () => createSetupPrompt(process.stdin, process.stdout) }),
    new: createNewHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, resolveBase, findJiraSuggestions,
      resolveJiraTicket: (config, key, allowClosed) => resolveJiraTicket(config, key, undefined, allowClosed),
      resolveGithubRepository, resolveGithubTicket,
      resolveLinearTicket: (key, allowClosed) => resolveLinearTicket(key, undefined, allowClosed),
      createWorktree, writeBaseAssociation, runSetup, launchEditor, launchAgent, launchEditorTerminals,
    }),
    open: createOpenHandler({
      discoverRepository,
      loadConfig: loadRepositoryConfig,
      resolveOpenTarget,
      createWorktree,
      runSetup,
      launchEditor,
      launchAgent,
      launchEditorTerminals,
    }),
    list: createListHandler({ discoverRepository, listWorktrees, loadConfig: loadRepositoryConfig, readBaseAssociation }),
    backupCreate: createBackupCreateHandler({ discoverRepository, loadConfig: loadRepositoryConfig, resolveOpenTarget: resolveRebaseTarget, createBackup }),
    backupRestore: createBackupRestoreHandler({ discoverRepository, restoreBackup }),
    rebase: createRebaseHandler({ discoverRepository, loadConfig: loadRepositoryConfig, resolveOpenTarget: resolveRebaseTarget, rebaseWorktree }),
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
