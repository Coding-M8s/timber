#!/usr/bin/env bun
import { placeholderHandlers, runCli } from "./cli";
import { createListHandler } from "./commands/list";
import { createNewHandler } from "./commands/new";
import { loadRepositoryConfig } from "./config";
import { launchEditor } from "./editor";
import { resolveBase } from "./git/branches";
import { createWorktree } from "./git/create-worktree";
import { discoverRepository } from "./git/repository";
import { listWorktrees } from "./git/worktrees";

process.exitCode = await runCli(process.argv.slice(2), {
  handlers: {
    ...placeholderHandlers,
    new: createNewHandler({
      discoverRepository, loadConfig: loadRepositoryConfig, resolveBase, createWorktree, launchEditor,
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
