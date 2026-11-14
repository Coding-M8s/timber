import { expect, mock, test } from "bun:test";
import { runCli } from "../src/cli";
import type { CommandContext, CommandHandlers } from "../src/services";

function harness(overrides: Partial<CommandHandlers> = {}) {
  let stdout = "";
  let stderr = "";
  const context: CommandContext = {
    cwd: "/repository with spaces/nested",
    io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
  };
  const unexpected = async () => { throw new Error("unexpected command"); };
  const handlers: CommandHandlers = { setup: unexpected, new: unexpected, open: unexpected, list: unexpected, done: unexpected, ...overrides };
  return { context, handlers, output: () => ({ stdout, stderr }) };
}

test("new forwards branch, base, disabled editor and invoking context", async () => {
  const handler = mock(async () => {});
  const h = harness({ new: handler });
  expect(await runCli(["new", "feature/foo", "--base", "upstream/trunk", "--no-editor"], h)).toBe(0);
  expect(handler).toHaveBeenCalledWith("feature/foo", { base: "upstream/trunk", editor: false }, h.context);
});

test("new joins quoted and unquoted sentence arguments without changing single-token names", async () => {
  const handler = mock(async () => {});
  const h = harness({ new: handler });

  expect(await runCli(["new", "Investigate slow API usage page"], h)).toBe(0);
  expect(await runCli(["new", "Investigate", "slow", "API", "usage", "page"], h)).toBe(0);
  expect(await runCli(["new", "feature/API-fix"], h)).toBe(0);
  expect(await runCli(["new", "TIM-19"], h)).toBe(0);

  expect(handler).toHaveBeenNthCalledWith(1, "Investigate slow API usage page", {}, h.context);
  expect(handler).toHaveBeenNthCalledWith(2, "Investigate slow API usage page", {}, h.context);
  expect(handler).toHaveBeenNthCalledWith(3, "feature/API-fix", {}, h.context);
  expect(handler).toHaveBeenNthCalledWith(4, "TIM-19", {}, h.context);
});

test("new options parse around sentence words, and -- keeps option-shaped names positional", async () => {
  const handler = mock(async () => {});
  const h = harness({ new: handler });

  expect(await runCli([
    "new", "--base", "trunk", "--no-editor", "Investigate", "slow", "API", "usage", "page",
  ], h)).toBe(0);
  expect(await runCli([
    "new", "Investigate", "slow", "API", "usage", "page", "--base", "trunk", "--no-editor",
  ], h)).toBe(0);
  expect(await runCli(["new", "--base", "trunk", "--no-editor", "--", "-draft", "name"], h)).toBe(0);

  expect(handler).toHaveBeenNthCalledWith(1, "Investigate slow API usage page", { base: "trunk", editor: false }, h.context);
  expect(handler).toHaveBeenNthCalledWith(2, "Investigate slow API usage page", { base: "trunk", editor: false }, h.context);
  expect(handler).toHaveBeenNthCalledWith(3, "-draft name", { base: "trunk", editor: false }, h.context);
});

test("editor is unspecified by default so repository config remains authoritative", async () => {
  const handler = mock(async () => {});
  const h = harness({ new: handler, open: handler });
  await runCli(["new", "feature"], h);
  await runCli(["open", "origin/feature"], h);
  expect(handler).toHaveBeenNthCalledWith(1, "feature", {}, h.context);
  expect(handler).toHaveBeenNthCalledWith(2, "origin/feature", {}, h.context);
});

test("open forwards explicit editor disabling", async () => {
  const handler = mock(async () => {});
  const h = harness({ open: handler });
  expect(await runCli(["open", "ENG-834", "--no-editor"], h)).toBe(0);
  expect(handler).toHaveBeenCalledWith("ENG-834", { editor: false }, h.context);
});

test("new and open forward explicit editor enabling", async () => {
  const handler = mock(async () => {});
  const h = harness({ new: handler, open: handler });
  expect(await runCli(["new", "feature", "--editor"], h)).toBe(0);
  expect(await runCli(["open", "feature", "--editor"], h)).toBe(0);
  expect(handler).toHaveBeenNthCalledWith(1, "feature", { editor: true }, h.context);
  expect(handler).toHaveBeenNthCalledWith(2, "feature", { editor: true }, h.context);
});

test("conflicting editor flags fail before either handler runs", async () => {
  const handler = mock(async () => {});
  const h = harness({ new: handler, open: handler });
  for (const command of ["new", "open"]) {
    expect(await runCli([command, "feature", "--editor", "--no-editor"], h)).toBe(1);
  }
  expect(handler).not.toHaveBeenCalled();
  expect(h.output().stderr).toContain("Conflicting options: --editor and --no-editor");
});

test("done defaults to discarding ignored content and requiring safe branch deletion", async () => {
  const handler = mock(async () => {});
  const h = harness({ done: handler });
  await runCli(["done", "feature"], h);
  expect(handler).toHaveBeenCalledWith("feature", { keepBranch: false, discardIgnored: true }, h.context);
  await runCli(["done", "feature", "--keep-branch", "--discard-ignored"], h);
  expect(handler).toHaveBeenLastCalledWith("feature", { keepBranch: true, discardIgnored: true }, h.context);
});

test("ls awaits its handler and routes human output to stdout", async () => {
  const h = harness({ list: async context => { await Promise.resolve(); context.io.stdout("primary /repo\n"); } });
  expect(await runCli(["ls"], h)).toBe(0);
  expect(h.output()).toEqual({ stdout: "primary /repo\n", stderr: "" });
});

test("handler rejection becomes one stderr error and a nonzero result", async () => {
  const h = harness({ list: async () => { throw new Error("repository not found"); } });
  expect(await runCli(["ls"], h)).toBe(1);
  expect(h.output()).toEqual({ stdout: "", stderr: "error: repository not found\n" });
});

test("help and parser errors do not invoke handlers", async () => {
  const handler = mock(async () => {});
  const h = harness({ done: handler });
  expect(await runCli(["done", "--help"], h)).toBe(0);
  expect(await runCli(["done", "feature", "--force"], h)).toBe(1);
  expect(handler).not.toHaveBeenCalled();
});

for (const command of ["new", "open"] as const) {
  test(`${command} forwards each workflow spelling through one option`, async () => {
    const handler = mock(async () => {});
    const h = harness({ [command]: handler });
    for (const flag of ["--workflow", "-w", "--w"]) {
      expect(await runCli([command, "feature", flag, "review"], h)).toBe(0);
      expect(handler).toHaveBeenLastCalledWith("feature", { workflow: "review" }, h.context);
    }
  });

  test(`${command} rejects repeated or mixed workflow aliases before dispatch`, async () => {
    for (const flags of [["-w", "review", "--w", "develop"],
      ["--workflow", "review", "--workflow", "review"]]) {
      const handler = mock(async () => {});
      const h = harness({ [command]: handler });
      expect(await runCli([command, "feature", ...flags], h)).toBe(1);
      expect(handler).not.toHaveBeenCalled();
      expect(h.output().stderr).toMatch(/workflow.*more than once|conflict/i);
    }
  });

  test(`${command} preserves explicit agent choice independently of editor`, async () => {
    const handler = mock(async () => {});
    const h = harness({ [command]: handler });
    expect(await runCli([command, "feature", "--agent", "--no-editor"], h)).toBe(0);
    expect(handler).toHaveBeenLastCalledWith("feature", { agent: true, editor: false }, h.context);
    expect(await runCli([command, "feature", "--no-agent"], h)).toBe(0);
    expect(handler).toHaveBeenLastCalledWith("feature", { agent: false }, h.context);
  });

  test(`${command} rejects conflicting agent flags before dispatch`, async () => {
    for (const flags of [["--agent", "--no-agent"], ["--no-agent", "--agent"]]) {
      const handler = mock(async () => {});
      const h = harness({ [command]: handler });
      expect(await runCli([command, "feature", ...flags], h)).toBe(1);
      expect(handler).not.toHaveBeenCalled();
      expect(h.output().stderr).toMatch(/conflict/i);
    }
  });

  test(`${command} returns handler's agent exit status`, async () => {
    const h = harness({ [command]: async () => 23 });
    expect(await runCli([command, "feature"], h)).toBe(23);
  });

  test(`${command} documents both agent flags`, async () => {
    const h = harness();
    expect(await runCli([command, "--help"], h)).toBe(0);
    expect(h.output().stdout).toContain("--agent");
    expect(h.output().stdout).toContain("--no-agent");
  });
}

test("agent choices are rejected by commands without agent launching", async () => {
  const h = harness();
  expect(await runCli(["ls", "--agent"], h)).toBe(1);
  expect(await runCli(["done", "feature", "--no-agent"], h)).toBe(1);
});
