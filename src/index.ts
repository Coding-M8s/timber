#!/usr/bin/env bun
import { placeholderHandlers, runCli } from "./cli";
import { createListHandler } from "./commands/list";
import { discoverRepository } from "./git/repository";
import { listWorktrees } from "./git/worktrees";

process.exitCode = await runCli(process.argv.slice(2), {
  handlers: { ...placeholderHandlers, list: createListHandler({ discoverRepository, listWorktrees }) },
  context: {
    cwd: process.cwd(),
    io: {
      stdout: text => { process.stdout.write(text); },
      stderr: text => { process.stderr.write(text); },
    },
  },
});
