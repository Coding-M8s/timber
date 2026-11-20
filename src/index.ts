#!/usr/bin/env bun
import { APP_HANDOFF_VARIABLE, resolveAppHandoff } from "./app-handoff";
import { resolveArenaSource, finalizeArenaSource } from "./arena/source";
import { createArenaResumeHandler } from "./commands/arena-resume";
import { createArenaPickHandler } from "./commands/arena-pick";
import { summarizeArenaAttempt, inspectArenaRemoval } from "./arena/summary";
import { archiveArenaAttempt } from "./arena/archive";
import { createArenaNewHandler } from "./commands/arena-new";
import { collectArenaInput } from "./arena/input";
import { confirmArenaPlan, chooseArenaSource } from "./arena/prompt";
import { planArenaDraft } from "./arena/plan";
import { reserveArena, readArena, openArenaForResume, validateArenaAttempt, readArenaPick, openArenaForPick } from "./arena/storage";
import { showInstallationHint } from "./guidance";
import { runEditorTask } from "./editor-terminals/runner";
import { createEditorTerminalLauncher } from "./editor-terminals/launch";
import { createUninstallHandler } from "./commands/uninstall";
import { createSetupHandler } from "./commands/setup";
import { createSetupPrompt } from "./setup/terminal";
import { checkExecutable } from "./setup/executable";
import { inspectSetupTarget, saveSetupConfig } from "./setup/storage";
import { createJiraSetupSession } from "./setup/jira";
import { launchAgent } from "./agent";
import { runCli } from "./cli";
import { notifyAfterCommand, updateHandlers } from "./update/runtime";
import { createRebaseHandler } from "./commands/rebase";
import {
  createBackupCleanupHandler, createBackupCreateHandler, createBackupDoneHandler, createBackupKeepHandler, createBackupListHandler,
  createBackupRestoreHandler,
} from "./commands/backup";
import { cleanupBackups, listBackups, readBackupList, retainedBackups, reviewBackupDeletion, setBackupKeep } from "./backup/lifecycle";
import { createBackup, restoreBackup } from "./backup/service";
import { rebaseWorktree, resolveRebaseTarget, selectBaseRef } from "./git/rebase";
import { createPublishHandler } from "./commands/publish";
import { createBaseHandler } from "./commands/base";
import { publishWorktree } from "./git/publish";
import { createPullRequestHandler } from "./commands/pr";
import { openPullRequest } from "./github/pull-request";
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
import { inspectNewBranchCollision } from "./git/new-collision";
import { resolveOpenTarget } from "./git/open-target";
import { discoverRepository } from "./git/repository";
import { listWorktrees } from "./git/worktrees";
import { clearBaseAssociation, readBaseAssociation, writeBaseAssociation } from "./git/base-metadata";
import { readIssueLink, writeIssueLink } from "./git/issue-link";
import { findJiraSuggestions, resolveJiraTicket } from "./jira/client";
import { resolveGithubRepository } from "./github/repository";
import { resolveLinearTicket } from "./linear/client";
import { resolveGithubTicket } from "./github/client";
import { createLinearSetupSession } from "./setup/linear";
import { createBitbucketSetupSession } from "./setup/bitbucket";
import { createGithubSetupSession } from "./setup/github";
import { createTerminalChooser, createTerminalTextPrompt, shouldEnableInteractiveSelection } from "./selection";

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
const ask = choose ? createTerminalTextPrompt(process.stdin, process.stdout) : undefined;

const ci = process.env.CI?.toLowerCase();
const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true
  && (!ci || ci === "0" || ci === "false");
// Only commands that can create a worktree hand off, so others never warn about the folder.
// A run that writes a --result-file belongs to a program, not a person, so it never moves the app.
const appHandoff = (process.argv[2] === "new" || process.argv[2] === "open")
  && !process.argv.slice(3).some(argument => argument === "--result-file" || argument.startsWith("--result-file=")
    || argument === "-h" || argument === "--help")
  ? await resolveAppHandoff({ value: process.env[APP_HANDOFF_VARIABLE], interactive, uid: process.getuid?.() },
    { stderr: text => { process.stderr.write(text); } })
  : null;
const launchEditorTerminals = createEditorTerminalLauncher({ self: { executable: process.execPath,
  ...(Bun.main.startsWith("/$bunfs/") ? {} : { entry: Bun.main }) } });

const machineListing = (process.argv[2] === "ls" && process.argv.slice(3).includes("--json"))
  || (process.argv[2] === "backup" && process.argv[3] === "list" && process.argv.slice(4).includes("--json"))
  || process.argv[2] === "__app-config"
  || process.argv[2] === "__app-backup"
  || process.argv[2] === "__app-arena"
  || (process.argv[2] === "arena" && process.argv[3] === "pick" && process.argv.slice(4).includes("--json"))
  || process.argv[2] === "uninstall";
if (!completing && !machineListing) {
  await showInstallationHint({ stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); } });
}

const openHandler = createOpenHandler({
  discoverRepository,
  loadConfig: loadRepositoryConfig,
  resolveOpenTarget,
  resolveGithubRepository, resolveGithubTicket,
  resolveLinearTicket: (key, allowClosed) => resolveLinearTicket(key, undefined, allowClosed),
  resolveJiraTicket: (config, key, allowClosed) => resolveJiraTicket(config, key, undefined, allowClosed),
  readIssueLink, writeIssueLink,
  createWorktree,
  runSetup,
  launchEditor,
  launchAgent,
  launchEditorTerminals,
});

process.exitCode = await runCli(process.argv.slice(2), {
  handlers: {
    ...updateHandlers,
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
    arenaPick: createArenaPickHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, readArena, readArenaPick, openArenaForPick,
      validateArenaAttempt, summarizeArenaAttempt, inspectArenaRemoval, archiveArenaAttempt, cleanupWorktree,
    }),
    uninstall: createUninstallHandler({ executablePath: process.execPath, standalone: Bun.main.startsWith("/$bunfs/"),
      uid: process.getuid?.() }),
    setup: createSetupHandler({ inspectTarget: inspectSetupTarget, save: saveSetupConfig, checkExecutable,
      jira: createJiraSetupSession,
      github: createGithubSetupSession,
      linear: createLinearSetupSession,
      bitbucket: createBitbucketSetupSession,
      prompt: () => createSetupPrompt(process.stdin, process.stdout) }),
    new: createNewHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, resolveBase, findJiraSuggestions,
      resolveJiraTicket: (config, key, allowClosed) => resolveJiraTicket(config, key, undefined, allowClosed),
      resolveGithubRepository, resolveGithubTicket,
      resolveLinearTicket: (key, allowClosed) => resolveLinearTicket(key, undefined, allowClosed),
      createWorktree, inspectNewBranchCollision, writeBaseAssociation, writeIssueLink, runSetup, launchEditor, launchAgent, launchEditorTerminals,
      openExisting: openHandler,
    }),
    open: openHandler,
    list: createListHandler({ discoverRepository, listWorktrees, loadConfig: loadRepositoryConfig, readBaseAssociation, readIssueLink }),
    backupCreate: createBackupCreateHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, createBackup,
      // Backup selection must not run status: it can execute repository clean filters.
      resolveOpenTarget: (repository, input, config) => resolveRebaseTarget(repository, input, config, { inspectStatus: false }),
    }),
    backupRestore: createBackupRestoreHandler({ discoverRepository, restoreBackup }),
    backupList: createBackupListHandler({ discoverRepository, listBackups, readBackupList }),
    backupDone: createBackupDoneHandler({ discoverRepository, reviewBackupDeletion }),
    backupCleanup: createBackupCleanupHandler({ discoverRepository, cleanupBackups: (repository, io) => cleanupBackups(repository, io) }),
    backupKeep: createBackupKeepHandler({ discoverRepository, setBackupKeep: (repository, id, keep, io) => setBackupKeep(repository, id, keep, io) }),
    rebase: createRebaseHandler({ discoverRepository, loadConfig: loadRepositoryConfig, resolveOpenTarget: resolveRebaseTarget, rebaseWorktree, createBackup, launchAgent }),
    // Shares rebase selection so a paused rebase's branch reports its detached worktree.
    base: createBaseHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, resolveOpenTarget: resolveRebaseTarget,
      readBaseAssociation, writeBaseAssociation, clearBaseAssociation, selectBaseRef,
    }),
    publish: createPublishHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, publishWorktree, resolveOpenTarget: resolveRebaseTarget,
    }),
    pr: createPullRequestHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, openPullRequest, resolveOpenTarget: resolveRebaseTarget,
    }),
    done: createDoneHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, resolveOpenTarget, cleanupWorktree, retainedBackups,
    }),
  },
  context: {
    cwd: process.cwd(),
    interactive,
    io: {
      stdout: text => { process.stdout.write(text); },
      stderr: text => { process.stderr.write(text); },
    },
    ...(choose ? { choose } : {}),
    ...(ask ? { ask } : {}),
    ...(appHandoff ? { appHandoff } : {}),
  },
});
await notifyAfterCommand(process.argv.slice(2), { stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); } });
