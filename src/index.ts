#!/usr/bin/env bun
import { placeholderHandlers, runCli } from "./cli";
import { createListHandler } from "./commands/list";
import { createOpenHandler } from "./commands/open";
import { loadRepositoryConfig } from "./config";
import { launchEditor } from "./editor";
import { createWorktree } from "./git/create-worktree";
import { resolveOpenTarget } from "./git/open-target";
import { discoverRepository } from "./git/repository";
import { listWorktrees } from "./git/worktrees";

process.exitCode = await runCli(process.argv.slice(2), {
  handlers: {
    ...placeholderHandlers,
    open: createOpenHandler({
      discoverRepository,
      loadConfig: loadRepositoryConfig,
      resolveOpenTarget,
      createWorktree,
      launchEditor,
    }),
    list: createListHandler({ discoverRepository, listWorktrees }),
  },
  context: {
    cwd: process.cwd(),
    io: {
      stdout: text => { process.stdout.write(text); },
      stderr: text => { process.stderr.write(text); },
    },
  },
});
