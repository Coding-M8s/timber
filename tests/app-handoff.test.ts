import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppHandoff, type AppHandoffRecord, resolveAppHandoff } from "../src/app-handoff";
import { runCli, placeholderHandlers } from "../src/cli";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";
import type { RepositoryConfig } from "../src/types";

const repository = repositoryFixture();
const worktree = worktreeFixture({ path: "/repo linked", isPrimary: false, branch: "feature" });
const config: RepositoryConfig = {
  baseBranch: null, remote: null, worktreeDir: null, editor: null,
  agent: { command: "codex", args: [], enabled: true },
};

async function invoke(command: "new" | "open", handoff: AppHandoff | undefined, { flags = [] as string[], existing = false, loaded = config } = {}) {
  const calls: string[] = [];
  let stdout = "", stderr = "";
  const services = createServiceDouble({
    discoverRepository: async () => repository,
    loadConfig: async () => loaded,
    resolveBase: async () => ({ ref: "refs/heads/main", commit: "a".repeat(40), source: "fallback" }),
    resolveOpenTarget: async () => ({ kind: "found", value: existing ? { kind: "worktree", worktree }
      : { kind: "branch", branch: { kind: "local", name: "feature", ref: "refs/heads/feature", upstream: null } } }),
    createWorktree: async () => { calls.push("create"); return worktree; },
    runSetup: async () => { calls.push("setup"); },
    launchEditor: async () => { calls.push("editor"); return { kind: "skipped" }; },
    launchAgent: async () => { calls.push("agent"); return { kind: "exited", exitCode: 0, signal: null }; },
  });
  const exitCode = await runCli([command, "feature", "--no-editor", ...flags], {
    context: { cwd: "/repo", interactive: true, ...(handoff ? { appHandoff: handoff } : {}),
      io: { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } } },
    handlers: { ...placeholderHandlers, new: createNewHandler(services), open: createOpenHandler(services) },
  });
  return { exitCode, stdout, stderr, calls };
}

function recorder() {
  const records: AppHandoffRecord[] = [];
  return { records, handoff: { handOff: async (record: AppHandoffRecord) => { records.push(record); } } };
}

for (const command of ["new", "open"] as const) {
  test(`${command} in the app runs setup and the editor here, then hands off instead of starting the agent`, async () => {
    const { records, handoff } = recorder();
    const result = await invoke(command, handoff, { loaded: { ...config, hooks: { postCreate: ["setup"] } } });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual(["create", "setup", "editor"]);
    expect(records).toEqual([{ schemaVersion: 1, command, repository: { primaryWorktreeRoot: repository.primaryWorktreeRoot },
      worktree: { path: worktree.path, branch: "feature" }, agent: true }]);
  });

  test(`${command} keeps the worktree and starts no agent here when the handoff cannot be written`, async () => {
    const failing = { handOff: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
    const result = await invoke(command, failing);
    expect(result.exitCode).toBe(1);
    expect(result.calls).not.toContain("agent");
    expect(result.stderr).toContain("Could not hand the worktree to the Timber app (ENOSPC). Workspace retained at /repo linked.");
    expect(result.stderr).toContain("timber open --agent --no-editor -- '/repo linked'");
  });
}

test("open of an existing worktree in the app starts the agent here and writes nothing", async () => {
  const { records, handoff } = recorder();
  const result = await invoke("open", handoff, { existing: true });
  expect(result.calls.at(-1)).toBe("agent");
  expect(records).toEqual([]);
});

test("without an agent the handoff asks the app for a shell", async () => {
  const { records, handoff } = recorder();
  await invoke("new", handoff, { flags: ["--no-agent"] });
  expect(records.map(record => record.agent)).toEqual([false]);
});

test("resolveAppHandoff is off without the variable or an interactive terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber handoff "));
  try {
    let warned = "";
    const io = { stderr: (text: string) => { warned += text; } };
    expect(await resolveAppHandoff({ value: undefined, interactive: true, uid: undefined }, io)).toBeNull();
    expect(await resolveAppHandoff({ value: "", interactive: true, uid: undefined }, io)).toBeNull();
    expect(await resolveAppHandoff({ value: directory, interactive: false, uid: undefined }, io)).toBeNull();
    expect(warned).toBe("");
    expect(await resolveAppHandoff({ value: directory, interactive: true, uid: undefined }, io)).not.toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new that opens an existing remote branch hands off through open, and keeps a failed handoff's exit status", async () => {
  const commit = "a".repeat(40);
  for (const failing of [false, true]) {
    const { records, handoff } = recorder();
    const calls: string[] = [];
    const used = failing ? { handOff: async () => { throw new Error("gone"); } } : handoff;
    const open = createOpenHandler(createServiceDouble({
      discoverRepository: async () => repository, loadConfig: async () => config,
      resolveOpenTarget: async () => ({ kind: "found", value: { kind: "branch", branch: { kind: "local", name: "feature", ref: "refs/heads/feature", upstream: null } } }),
      createWorktree: async () => worktree, launchEditor: async () => ({ kind: "skipped" }),
      launchAgent: async () => { calls.push("agent"); return { kind: "exited", exitCode: 0, signal: null }; },
    }));
    const handler = createNewHandler({
      ...createServiceDouble({
        discoverRepository: async () => repository, loadConfig: async () => config,
        resolveBase: async () => ({ ref: "refs/heads/main", commit, source: "fallback" }),
        inspectNewBranchCollision: async (_repository, name) => ({ name, local: null,
          remotes: [{ remote: "origin", cached: commit, live: { kind: "present", commit }, selectorSafe: true }] }),
        createWorktree: async () => { calls.push("create"); throw new Error("must not create"); },
      }),
      openExisting: open,
    });
    let stderr = "";
    const status = await handler("feature", { editor: false }, { cwd: "/repo", interactive: true, appHandoff: used,
      choose: async () => "origin", io: { stdout() {}, stderr: text => { stderr += text; } } });
    expect(calls).toEqual([]);
    if (failing) {
      expect(status).toBe(1);
      expect(stderr).toContain("Could not hand the worktree to the Timber app");
    } else {
      expect(status).toBe(0);
      expect(records.map(record => record.command)).toEqual(["open"]);
    }
  }
});
