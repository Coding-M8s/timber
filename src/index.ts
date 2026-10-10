#!/usr/bin/env bun
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

process.exitCode = await runCli(process.argv.slice(2), {
  handlers: {
    ...placeholderHandlers,
    new: createNewHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, resolveBase, createWorktree, runSetup, launchEditor,
    }),
    open: createOpenHandler({
      discoverRepository,
      loadConfig: loadRepositoryConfig,
      resolveOpenTarget,
      createWorktree,
      runSetup,
      launchEditor,
    }),
    list: createListHandler({ discoverRepository, listWorktrees }),
    done: createDoneHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, resolveOpenTarget, cleanupWorktree,
    }),
  },
  context: {
    cwd: process.cwd(),
    io: {
      stdout: text => { process.stdout.write(text); },
      stderr: text => { process.stderr.write(text); },
    },
  },
});
