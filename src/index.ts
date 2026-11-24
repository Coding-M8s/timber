#!/usr/bin/env bun
// Every Timber process starts here, including the many short-lived ones that
// editors, completion and the app run. Modules load on first use, so a command
// only pays for the code it actually runs.
import type { CommandHandlers, CommandIO } from "./services";
import { isStandaloneMain } from "./platform/standalone";

if (process.argv[2] === "__editor-task") {
  const { runEditorTask } = await import("./editor-terminals/runner");
  process.exit(await runEditorTask(process.argv.length === 4 ? process.argv[3]! : ""));
}

/** Build a handler on its first call and reuse it afterwards. */
function lazy<A extends unknown[], R>(build: () => Promise<(...args: A) => Promise<R>>): (...args: A) => Promise<R> {
  let handler: Promise<(...args: A) => Promise<R>> | undefined;
  return async (...args: A) => (await (handler ??= build()))(...args);
}

const io: CommandIO = {
  stdout: text => { process.stdout.write(text); },
  stderr: text => { process.stderr.write(text); },
};

const { createTerminalChooser, createTerminalTextPrompt, shouldEnableInteractiveSelection } = await import("./selection");
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
  ? await (async () => {
    const { APP_HANDOFF_VARIABLE, resolveAppHandoff } = await import("./app-handoff");
    return resolveAppHandoff({ value: process.env[APP_HANDOFF_VARIABLE], interactive, uid: process.getuid?.() },
      { stderr: text => { process.stderr.write(text); } });
  })()
  : null;
const launchEditorTerminals = lazy(async () => {
  const { createEditorTerminalLauncher } = await import("./editor-terminals/launch");
  return createEditorTerminalLauncher({ self: { executable: process.execPath,
    ...(isStandaloneMain() ? {} : { entry: Bun.main }) } });
});

const machineListing = (process.argv[2] === "ls" && process.argv.slice(3).includes("--json"))
  || (process.argv[2] === "backup" && process.argv[3] === "list" && process.argv.slice(4).includes("--json"))
  || process.argv[2] === "__app-config"
  || process.argv[2] === "__app-backup"
  || process.argv[2] === "__app-arena"
  || (process.argv[2] === "arena" && process.argv[3] === "pick" && process.argv.slice(4).includes("--json"))
  || process.argv[2] === "uninstall";
if (!completing && !machineListing) {
  const { showInstallationHint } = await import("./guidance");
  await showInstallationHint(io);
}

// Dependencies most commands share. Bun caches each module after its first import.
async function common() {
  const [{ discoverRepository }, { loadRepositoryConfig }] = await Promise.all([
    import("./git/repository"), import("./config"),
  ]);
  return { discoverRepository, loadConfig: loadRepositoryConfig };
}

async function launchers() {
  const [{ runSetup }, { launchEditor }, { launchAgent }] = await Promise.all([
    import("./hooks"), import("./editor"), import("./agent"),
  ]);
  return { runSetup, launchEditor, launchAgent };
}

async function trackers() {
  const [jira, linear, github, githubRepository] = await Promise.all([
    import("./jira/client"), import("./linear/client"), import("./github/client"), import("./github/repository"),
  ]);
  return {
    resolveGithubRepository: githubRepository.resolveGithubRepository,
    resolveGithubTicket: github.resolveGithubTicket,
    resolveLinearTicket: (key: string, allowClosed: boolean, repository?: { commonGitDir: string }) =>
      linear.resolveLinearTicket(key, linear.linearRuntime(repository?.commonGitDir), allowClosed),
    resolveJiraTicket: (config: Parameters<typeof jira.resolveJiraTicket>[0], key: string, allowClosed: boolean,
      repository?: { commonGitDir: string }) =>
      jira.resolveJiraTicket(config, key, jira.jiraRuntime(repository?.commonGitDir), allowClosed),
  };
}

const prompt = async () => {
  const { createSetupPrompt } = await import("./setup/terminal");
  return () => createSetupPrompt(process.stdin, process.stdout);
};

const openHandler = lazy(async () => {
  const [{ createOpenHandler }, shared, launch, tracked, { resolveOpenTarget }, issueLink, { createWorktree }] = await Promise.all([
    import("./commands/open"), common(), launchers(), trackers(), import("./git/open-target"),
    import("./git/issue-link"), import("./git/create-worktree"),
  ]);
  return createOpenHandler({
    ...shared, ...launch, ...tracked, resolveOpenTarget,
    readIssueLink: issueLink.readIssueLink, writeIssueLink: issueLink.writeIssueLink,
    createWorktree, launchEditorTerminals,
  });
});

const backup = async () => {
  const [commands, shared, lifecycle, service] = await Promise.all([
    import("./commands/backup"), common(), import("./backup/lifecycle"), import("./backup/service"),
  ]);
  return { commands, discoverRepository: shared.discoverRepository, loadConfig: shared.loadConfig, lifecycle, service };
};

const handlers: CommandHandlers = {
  update: lazy(async () => (await import("./update/runtime")).updateHandlers.update!),
  updateCheck: lazy(async () => (await import("./update/runtime")).updateHandlers.updateCheck!),
  arenaNew: lazy(async () => {
    const [{ createArenaNewHandler }, shared, launch, source, { createWorktree }, { planArenaDraft }, storage,
      { checkExecutable }, { collectArenaInput }, arenaPrompt, setupPrompt] = await Promise.all([
      import("./commands/arena-new"), common(), launchers(), import("./arena/source"), import("./git/create-worktree"),
      import("./arena/plan"), import("./arena/storage"), import("./setup/executable"), import("./arena/input"),
      import("./arena/prompt"), prompt(),
    ]);
    return createArenaNewHandler({
      ...shared, ...launch, resolveSource: source.resolveArenaSource, finalizeSource: source.finalizeArenaSource, createWorktree,
      planDraft: planArenaDraft, reserveArena: storage.reserveArena, validateArenaAttempt: storage.validateArenaAttempt, checkExecutable,
      collectInput: (options, config, context) => collectArenaInput(options, config, context, setupPrompt),
      confirmPlan: (plan, review) => review ? review(plan) : arenaPrompt.confirmArenaPlan(plan, setupPrompt),
      chooseSource: async candidates => {
        const terminal = setupPrompt();
        try {return await arenaPrompt.chooseArenaSource(candidates, terminal);} finally {terminal.close();}
      },
    });
  }),
  arenaResume: lazy(async () => {
    const [{ createArenaResumeHandler }, shared, launch, storage, { checkExecutable }] = await Promise.all([
      import("./commands/arena-resume"), common(), launchers(), import("./arena/storage"), import("./setup/executable"),
    ]);
    return createArenaResumeHandler({
      ...shared, ...launch, readArena: storage.readArena, openArenaForResume: storage.openArenaForResume,
      validateArenaAttempt: storage.validateArenaAttempt, checkExecutable,
    });
  }),
  arenaPick: lazy(async () => {
    const [{ createArenaPickHandler }, shared, storage, summary, { archiveArenaAttempt }, { cleanupWorktree }] = await Promise.all([
      import("./commands/arena-pick"), common(), import("./arena/storage"), import("./arena/summary"),
      import("./arena/archive"), import("./git/cleanup"),
    ]);
    return createArenaPickHandler({
      ...shared, readArena: storage.readArena, readArenaPick: storage.readArenaPick, openArenaForPick: storage.openArenaForPick,
      validateArenaAttempt: storage.validateArenaAttempt, summarizeArenaAttempt: summary.summarizeArenaAttempt,
      inspectArenaRemoval: summary.inspectArenaRemoval, archiveArenaAttempt, cleanupWorktree,
    });
  }),
  uninstall: lazy(async () => {
    const { createUninstallHandler } = await import("./commands/uninstall");
    return createUninstallHandler({ executablePath: process.execPath, standalone: isStandaloneMain(),
      uid: process.getuid?.() });
  }),
  setup: lazy(async () => {
    const [{ createSetupHandler }, storage, { checkExecutable }, jira, github, linear, bitbucket, setupPrompt] = await Promise.all([
      import("./commands/setup"), import("./setup/storage"), import("./setup/executable"), import("./setup/jira"),
      import("./setup/github"), import("./setup/linear"), import("./setup/bitbucket"), prompt(),
    ]);
    return createSetupHandler({ inspectTarget: storage.inspectSetupTarget, save: storage.saveSetupConfig, checkExecutable,
      jira: commonGitDir => jira.createJiraSetupSession(process.env, undefined, commonGitDir),
      github: github.createGithubSetupSession,
      linear: commonGitDir => linear.createLinearSetupSession(process.env, undefined, commonGitDir),
      bitbucket: bitbucket.createBitbucketSetupSession,
      prompt: setupPrompt });
  }),
  new: lazy(async () => {
    const [{ createNewHandler }, shared, launch, tracked, { resolveBase }, { createWorktree }, { inspectNewBranchCollision },
      { writeBaseAssociation }, { writeIssueLink }, assignment] = await Promise.all([
      import("./commands/new"), common(), launchers(), trackers(), import("./git/branches"), import("./git/create-worktree"),
      import("./git/new-collision"), import("./git/base-metadata"), import("./git/issue-link"), import("./issue-assignment"),
    ]);
    return createNewHandler({
      ...shared, ...launch, ...tracked, resolveBase,
      createWorktree, inspectNewBranchCollision, writeBaseAssociation, writeIssueLink, launchEditorTerminals,
      readTrackerUser: assignment.readTrackerUser, assignIssue: assignment.assignIssue,
      openExisting: openHandler,
    });
  }),
  open: openHandler,
  list: lazy(async () => {
    const [{ createListHandler }, shared, { listWorktrees }, { readBaseAssociation }, { readIssueLink }] = await Promise.all([
      import("./commands/list"), common(), import("./git/worktrees"), import("./git/base-metadata"), import("./git/issue-link"),
    ]);
    return createListHandler({ ...shared, listWorktrees, readBaseAssociation, readIssueLink });
  }),
  backupCreate: lazy(async () => {
    const [{ commands, discoverRepository, loadConfig, service }, { resolveRebaseTarget }] = await Promise.all([
      backup(), import("./git/rebase"),
    ]);
    return commands.createBackupCreateHandler({
      discoverRepository, loadConfig, createBackup: service.createBackup,
      // Backup selection must not run status: it can execute repository clean filters.
      resolveOpenTarget: (repository, input, config) => resolveRebaseTarget(repository, input, config, { inspectStatus: false }),
    });
  }),
  backupRestore: lazy(async () => {
    const { commands, discoverRepository, service } = await backup();
    return commands.createBackupRestoreHandler({ discoverRepository, restoreBackup: service.restoreBackup });
  }),
  backupList: lazy(async () => {
    const { commands, discoverRepository, lifecycle } = await backup();
    return commands.createBackupListHandler({ discoverRepository, listBackups: lifecycle.listBackups, readBackupList: lifecycle.readBackupList });
  }),
  backupDone: lazy(async () => {
    const { commands, discoverRepository, lifecycle } = await backup();
    return commands.createBackupDoneHandler({ discoverRepository, reviewBackupDeletion: lifecycle.reviewBackupDeletion });
  }),
  backupCleanup: lazy(async () => {
    const { commands, discoverRepository, lifecycle } = await backup();
    return commands.createBackupCleanupHandler({ discoverRepository,
      cleanupBackups: (repository, backupIo) => lifecycle.cleanupBackups(repository, backupIo) });
  }),
  backupKeep: lazy(async () => {
    const { commands, discoverRepository, lifecycle } = await backup();
    return commands.createBackupKeepHandler({ discoverRepository,
      setBackupKeep: (repository, id, keep, backupIo) => lifecycle.setBackupKeep(repository, id, keep, backupIo) });
  }),
  rebase: lazy(async () => {
    const [{ createRebaseHandler }, shared, rebase, { createBackup }, { launchAgent }, { startRebaseRetention }] = await Promise.all([
      import("./commands/rebase"), common(), import("./git/rebase"), import("./backup/service"), import("./agent"),
      import("./backup/lifecycle"),
    ]);
    return createRebaseHandler({
      ...shared, resolveOpenTarget: rebase.resolveRebaseTarget, rebaseWorktree: rebase.rebaseWorktree, createBackup, launchAgent,
      startRebaseRetention: (repository, rebaseIo, observed) => startRebaseRetention(repository, rebaseIo, new Date(), observed),
    });
  }),
  // Shares rebase selection so a paused rebase's branch reports its detached worktree.
  base: lazy(async () => {
    const [{ createBaseHandler }, shared, rebase, metadata] = await Promise.all([
      import("./commands/base"), common(), import("./git/rebase"), import("./git/base-metadata"),
    ]);
    return createBaseHandler({
      ...shared, resolveOpenTarget: rebase.resolveRebaseTarget, selectBaseRef: rebase.selectBaseRef,
      readBaseAssociation: metadata.readBaseAssociation, writeBaseAssociation: metadata.writeBaseAssociation,
      clearBaseAssociation: metadata.clearBaseAssociation,
    });
  }),
  publish: lazy(async () => {
    const [{ createPublishHandler }, shared, { publishWorktree }, { resolveRebaseTarget }] = await Promise.all([
      import("./commands/publish"), common(), import("./git/publish"), import("./git/rebase"),
    ]);
    return createPublishHandler({ ...shared, publishWorktree, resolveOpenTarget: resolveRebaseTarget });
  }),
  pr: lazy(async () => {
    const [{ createPullRequestHandler }, shared, { openPullRequest }, { resolveRebaseTarget }] = await Promise.all([
      import("./commands/pr"), common(), import("./github/pull-request"), import("./git/rebase"),
    ]);
    return createPullRequestHandler({ ...shared, openPullRequest, resolveOpenTarget: resolveRebaseTarget });
  }),
  done: lazy(async () => {
    const [{ createDoneHandler }, shared, { resolveOpenTarget }, { cleanupWorktree }, { retainedBackups }] = await Promise.all([
      import("./commands/done"), common(), import("./git/open-target"), import("./git/cleanup"), import("./backup/lifecycle"),
    ]);
    return createDoneHandler({ ...shared, resolveOpenTarget, cleanupWorktree, retainedBackups });
  }),
};

const { runCli } = await import("./cli");
process.exitCode = await runCli(process.argv.slice(2), {
  handlers,
  context: {
    cwd: process.cwd(),
    interactive,
    io,
    ...(choose ? { choose } : {}),
    ...(ask ? { ask } : {}),
    ...(appHandoff ? { appHandoff } : {}),
  },
});
const { notifyAfterCommand } = await import("./update/runtime");
await notifyAfterCommand(process.argv.slice(2), io);
