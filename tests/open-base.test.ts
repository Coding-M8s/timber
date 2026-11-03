import { expect, test } from "bun:test";
import { createOpenHandler } from "../src/commands/open";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";

test.each(["existing", "local", "remote"])("open %s target proceeds without base prompts or lookups", async kind => {
  const tree = worktreeFixture({ path: "/linked", branch: "feature", isPrimary: false });
  const events: string[] = [];
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected base work"); };
  const services = createServiceDouble({
    discoverRepository: async () => repositoryFixture(),
    loadConfig: async () => ({ baseBranch: "missing", remote: null, worktreeDir: null, editor: null, agent: null }),
    resolveOpenTarget: async () => ({ kind: "found", value: kind === "existing"
      ? { kind: "worktree", worktree: tree }
      : { kind: "branch", branch: kind === "local"
        ? { kind: "local", name: "feature", ref: "refs/heads/feature", upstream: null }
        : { kind: "remote", name: "feature", remote: "origin", ref: "refs/remotes/origin/feature" } } }),
    listBranches: unexpected,
    resolveBase: unexpected,
    readBaseAssociation: unexpected,
    writeBaseAssociation: unexpected,
    createWorktree: async () => { events.push("create"); return tree; },
    launchEditor: async () => { events.push("editor"); return { kind: "skipped" }; },
  });
  await createOpenHandler(services)("feature", {}, {
    cwd: "/repo", interactive: true, choose: unexpected,
    io: { stdout: () => {}, stderr: () => {} },
  });
  expect(events).toEqual(kind === "existing" ? ["editor"] : ["create", "editor"]);
});
