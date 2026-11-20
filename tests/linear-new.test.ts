import { expect, test } from "bun:test";
import { createNewHandler } from "../src/commands/new";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { RepositoryConfig } from "../src/types";

const config: RepositoryConfig = { baseBranch: "main", remote: null, worktreeDir: null, editor: null, agent: null };
const base = { ref: "refs/heads/main", commit: "a".repeat(40), source: "explicit" as const };
const io = { stdout() {}, stderr() {} };

for (const orca of [false, true]) {
  test(`Linear uses ordinary base, workflow and creation flow (Orca=${orca})`, async () => {
    const calls: string[] = []; let output = "";
    const handler = createNewHandler(createServiceDouble({
      discoverRepository: async () => repositoryFixture(),
      loadConfig: async () => ({ ...config, jira: { siteUrl: "https://example.atlassian.net" },
        editor: orca ? { command: "orca", args: [], enabled: true, integration: "orca" } : null,
        workflows: { fix: { postCreate: ["workflow hook"], agent: { command: "assistant", args: [] } } },
        hooks: { postCreate: ["repo hook"] } }),
      resolveBase: async (_repo, _config, explicit) => { expect(explicit).toBe("main"); calls.push("base"); return base; },
      resolveLinearTicket: async key => { expect(key).toBe("ENG-123"); calls.push("lookup"); return { key: "ENG-123", title: "Fix café login", url: "https://linear.app/w/issue/ENG-123" }; },
      createWorktree: async (_repo, request) => { expect(request).toEqual({ kind: "new", branch: "ENG-123-fix-cafe-login", base }); calls.push("create"); return worktreeFixture(); },
      writeBaseAssociation: async () => { calls.push("base metadata"); },
      runSetup: async (_repo, _tree, _config, _io, name, scripts) => { expect(name).toBe("fix"); expect(scripts).toEqual(["workflow hook"]); calls.push("setup"); },
      launchEditor: async () => { calls.push("editor"); return { kind: "skipped" }; },
      launchAgent: async () => { calls.push("agent"); return { kind: "exited", exitCode: 0, signal: null }; },
      launchEditorTerminals: async launch => { expect(launch.setup).toBe(true); expect(launch.agent?.command).toBe("assistant"); calls.push("orca"); },
    }));
    await handler("linear:ENG-123", { base: "main", workflow: "fix" }, { cwd: "/repo", interactive: true, io: { ...io, stdout: text => { output += text; } } });
    expect(calls).toEqual(["base", "lookup", "create", "base metadata", ...(orca ? ["orca"] : ["setup", "editor", "agent"])]);
    expect(output).toContain("Created ENG-123-fix-cafe-login");
    expect(output).toContain("Linear: https://linear.app/w/issue/ENG-123");
  });
}

test("Linear malformed selectors and GitHub-only remote refuse before lookup", async () => {
  const handler = createNewHandler(createServiceDouble({ discoverRepository: async () => repositoryFixture(), loadConfig: async () => config }));
  for (const input of ["linear:", "linear:eng", "linear:ENG-123 extra", "linear:ENG-123 "]) {
    await expect(handler(input, {}, { cwd: "/repo", io })).rejects.toThrow("Invalid Linear issue selector");
  }
  for (const options of [{ remote: "origin" }]) {
    await expect(handler("linear:ENG-123", options, { cwd: "/repo", io })).rejects.toThrow("requires a GitHub issue selector");
  }
});

test("Linear invalid base and failed lookup never create or launch", async () => {
  for (const failBase of [true, false]) {
    let lookups = 0;
    const handler = createNewHandler(createServiceDouble({ discoverRepository: async () => repositoryFixture(), loadConfig: async () => config,
      resolveBase: async () => { if (failBase) throw new Error("bad base"); return base; },
      resolveLinearTicket: async () => { lookups++; throw new Error("lookup refused"); },
    }));
    await expect(handler("linear:ENG-123", {}, { cwd: "/repo", io })).rejects.toThrow(failBase ? "bad base" : "lookup refused");
    expect(lookups).toBe(failBase ? 0 : 1);
  }
});

for (const jira of [false, true]) {
  test(`bare ticket without a default tracker is a literal branch (Jira=${jira})`, async () => {
    const handler = createNewHandler(createServiceDouble({ discoverRepository: async () => repositoryFixture(),
      loadConfig: async () => ({ ...config, ...(jira ? { jira: { siteUrl: "https://example.atlassian.net" } } : {}) }), resolveBase: async () => base,
      resolveJiraTicket: async () => { throw new Error("unexpected Jira lookup"); },
      createWorktree: async (_repo, request) => { expect(request.branch).toBe("ENG-123"); return worktreeFixture(); },
      launchEditor: async () => ({ kind: "skipped" }),
    }));
    await handler("ENG-123", {}, { cwd: "/repo", io });
  });
}
