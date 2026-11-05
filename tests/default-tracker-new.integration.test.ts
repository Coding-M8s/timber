import { expect, test } from "bun:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createNewHandler } from "../src/commands/new";
import { loadRepositoryConfig } from "../src/config";
import { GithubLookupFailure } from "../src/github/client";
import { LinearLookupFailure } from "../src/linear/client";
import { JiraLookupFailure } from "../src/jira/client";
import { discoverRepository } from "../src/git/repository";
import { resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { writeBaseAssociation } from "../src/git/base-metadata";
import { createServiceDouble } from "./helpers/services";
import { git, withRepository } from "./helpers/git";

for (const provider of ["github", "linear", "jira"] as const) {
  const raw = provider === "github" ? "97" : "ENG-123";
  const key = provider === "github" ? "GH-97" : "ENG-123";
  const missing = provider === "github" ? new GithubLookupFailure("missing", "not-found")
    : provider === "linear" ? new LinearLookupFailure("missing", "not-found") : new JiraLookupFailure("missing", "not-found");
  test(`${provider} default real Git success, missing fallback, and failures preserve local work`, async () => {
    await withRepository(async (primary, directory) => {
      await writeFile(join(primary, ".timber.toml"), `base_branch = "trunk"\ndefault_tracker = "${provider}"\n[hooks]\npost_create = ["setup"]\n[jira]\nsite_url = "https://example.atlassian.net"\n`);
      await writeFile(join(primary, "tracked.txt"), "keep dirty\n");
      await writeFile(join(primary, "untracked.txt"), "keep untracked\n");
      let outcome: "found" | "missing" | "error" = "found"; let hooks = 0;
      const lookup = async () => {
        if (outcome === "missing") throw missing;
        if (outcome === "error") throw new Error("authentication failed");
        return { key, title: "Fix login", url: "https://example.invalid/issue" };
      };
      const handler = createNewHandler(createServiceDouble({
        discoverRepository, loadConfig: repo => loadRepositoryConfig(repo, { HOME: directory, XDG_CONFIG_HOME: join(directory, "config") }),
        resolveBase, resolveGithubRepository: async () => ({ owner: "team", name: "repo" }),
        resolveGithubTicket: lookup, resolveLinearTicket: lookup, resolveJiraTicket: lookup,
        createWorktree, writeBaseAssociation, runSetup: async () => { hooks++; }, launchEditor: async () => ({ kind: "skipped" }),
      }));
      const context = { cwd: primary, io: { stdout() {}, stderr() {} } };
      await handler(raw, {}, context);
      expect(await git(primary, "rev-parse", `${key}-fix-login`)).toBe(await git(primary, "rev-parse", "trunk"));
      expect(hooks).toBe(1);
      outcome = "missing";
      await handler(raw, {}, context);
      expect(await git(primary, "rev-parse", raw)).toBe(await git(primary, "rev-parse", "trunk"));
      expect(hooks).toBe(2);
      const refs = await git(primary, "show-ref"); const trees = await git(primary, "worktree", "list", "--porcelain");
      for (const failure of ["missing", "found", "error"] as const) {
        outcome = failure;
        await expect(handler(raw, {}, context)).rejects.toThrow();
        expect(await git(primary, "show-ref")).toBe(refs);
        expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
        expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("keep dirty\n");
        expect(await readFile(join(primary, "untracked.txt"), "utf8")).toBe("keep untracked\n");
        expect(hooks).toBe(2);
      }
    });
  }, 30_000);
}

test("missing fallback refuses an occupied destination without creating refs or running scripts", async () => {
  await withRepository(async (primary, directory) => {
    const refs = await git(primary, "show-ref"); const trees = await git(primary, "worktree", "list", "--porcelain");
    const handler = createNewHandler(createServiceDouble({ discoverRepository,
      loadConfig: async () => ({ baseBranch: "trunk", remote: null, worktreeDir: directory, editor: null, agent: null, defaultTracker: "linear", hooks: { postCreate: ["setup"] } }),
      resolveBase, resolveLinearTicket: async () => { throw new LinearLookupFailure("missing", "not-found"); }, createWorktree,
    }));
    // Literal fallback keeps the original key, whose destination already contains local data.
    const keyed = join(directory, "ENG-123"); await mkdir(keyed); await writeFile(join(keyed, "keep"), "keep\n");
    await expect(handler("ENG-123", {}, { cwd: primary, io: { stdout() {}, stderr() {} } })).rejects.toThrow();
    expect(await git(primary, "show-ref")).toBe(refs); expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
    expect(await readFile(join(keyed, "keep"), "utf8")).toBe("keep\n");
  });
});
