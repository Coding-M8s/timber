import { expect, test } from "bun:test";
import { Command } from "commander";
import { execa } from "execa";
import { parse } from "smol-toml";
import { z } from "zod";

test("pinned Commander parses under Bun", () => {
  const command = new Command().option("--base <branch>");
  command.parse(["--base", "release/candidate"], { from: "user" });
  expect(command.opts()).toEqual({ base: "release/candidate" });
});

test("pinned Execa preserves argument arrays and reports nonzero exits under Bun", async () => {
  const literal = "space ; $(not-a-command) ' quoted";
  const result = await execa(process.execPath, ["-e", "console.log(process.argv[1])", literal]);
  expect(result.stdout).toBe(literal);
  const failure = await execa(process.execPath, ["-e", "process.exit(7)"], { reject: false });
  expect(failure.exitCode).toBe(7);
  expect(failure.failed).toBe(true);
});

test("pinned TOML parser and Zod validate configuration together under Bun", () => {
  const schema = z.object({ base_branch: z.string(), editor: z.object({ command: z.string(), args: z.array(z.string()) }) });
  expect(schema.parse(parse('base_branch = "main"\n[editor]\ncommand = "zed"\nargs = ["--wait"]')))
    .toEqual({ base_branch: "main", editor: { command: "zed", args: ["--wait"] } });
  expect(schema.safeParse(parse("base_branch = 7")).success).toBe(false);
});
