#!/usr/bin/env bun
import { runCli } from "./cli";

process.exitCode = await runCli(process.argv.slice(2), {
  context: {
    cwd: process.cwd(),
    io: {
      stdout: text => { process.stdout.write(text); },
      stderr: text => { process.stderr.write(text); },
    },
  },
});
