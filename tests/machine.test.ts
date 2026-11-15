import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { placeholderHandlers, runCli } from "../src/cli";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import { createWorktree } from "../src/git/create-worktree";
import { discoverRepository } from "../src/git/repository";
import { listWorktrees } from "../src/git/worktrees";
import { JiraLookupFailure } from "../src/jira/client";
import { createServiceDouble } from "./helpers/services";
import { git, withRepository } from "./helpers/git";
import type { CommandContext } from "../src/services";

const config = { baseBranch: "trunk", remote: null, worktreeDir: null, editor: null, agent: null };

for (const command of ["new", "open"] as const) {
  test(`${command} chooser cancellation records cancellation and leaves real refs/files intact`, async () => {
    await withRepository(async (primary, directory) => {
      const repository = await discoverRepository(primary);
      const trees = await listWorktrees(repository);
      const services = createServiceDouble({ discoverRepository: async () => repository,
        loadConfig: async () => ({ ...config, jira: { siteUrl: "https://example.atlassian.net" } }),
        resolveBase: async () => ({ ref: "refs/heads/trunk", commit: (await git(primary, "rev-parse", "HEAD")), source: "explicit" }),
        resolveJiraTicket: async () => { throw new JiraLookupFailure("No exact issue", "not-found"); },
        findJiraSuggestions: async () => [{ key: "TIM-421", title: "one", url: "https://example.invalid/1" }],
        resolveOpenTarget: async () => ({ kind: "ambiguous", candidates: trees.map(worktree => ({ kind: "worktree", worktree })) }),
      });
      let stdout = "";
      const context: CommandContext = { cwd: primary, interactive: true, choose: async () => null,
        io: { stdout: text => { stdout += text; }, stderr: () => {} } };
      const output = join(directory, "cancelled.json");
      const refs = await git(primary, "show-ref");
      expect(await runCli([command, "TIM-42", "--no-editor", "--no-agent", "--result-file", output], {
        context, handlers: { ...placeholderHandlers, new: createNewHandler(services), open: createOpenHandler(services) },
      })).toBe(0);
      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ outcome: "cancelled", exitCode: 0,
        worktree: null, materialized: false, repository: { commonGitDir: repository.commonGitDir } });
      expect(stdout).toBe("Cancelled.\n");
      expect(await git(primary, "show-ref")).toBe(refs);
      expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("original\n");
    });
  });
}

test("provider canonical branch and metadata failure report the real retained worktree", async () => {
  await withRepository(async (primary, directory) => {
    const repository = await discoverRepository(primary);
    const services = createServiceDouble({ discoverRepository: async () => repository,
      loadConfig: async () => config,
      resolveBase: async () => ({ ref: "refs/heads/trunk", commit: await git(primary, "rev-parse", "HEAD"), source: "explicit" }),
      resolveLinearTicket: async () => ({ key: "ENG-999", title: "Actual canonical issue", url: "https://linear.app/team/issue/ENG-999" }),
      createWorktree,
      writeBaseAssociation: async () => { throw new Error("metadata disk failure"); },
    });
    const output = join(directory, "metadata-failed.json");
    const refs = await git(primary, "show-ref");
    expect(await runCli(["new", "linear:OLD-123", "--no-editor", "--no-agent", "--result-file", output], {
      context: { cwd: primary, io: { stdout: () => {}, stderr: () => {} } },
      handlers: { ...placeholderHandlers, new: createNewHandler(services) },
    })).toBe(1);
    const data = JSON.parse(await readFile(output, "utf8"));
    expect(data).toMatchObject({ outcome: "failed", materialized: true,
      worktree: { branch: "ENG-999-actual-canonical-issue", path: join(directory, "primary repo-worktrees", "ENG-999-actual-canonical-issue") } });
    expect(data.diagnostic).toContain("base association");
    expect(data.worktree.base).toEqual({ kind: "unassigned" });
    expect(await git(primary, "show-ref")).toContain(refs);
    expect(await readFile(join(data.worktree.path, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("creation service failure after Git mutation is unconfirmed and never invents a target", async () => {
  await withRepository(async (primary, directory) => {
    const repository = await discoverRepository(primary);
    const target = join(directory, "retained unexpected path");
    const services = createServiceDouble({ discoverRepository: async () => repository, loadConfig: async () => config,
      resolveBase: async () => ({ ref: "refs/heads/trunk", commit: await git(primary, "rev-parse", "HEAD"), source: "explicit" }),
      createWorktree: async () => {
        await git(primary, "worktree", "add", "-b", "retained", target);
        await writeFile(join(target, "retained"), "inspect before retry");
        throw new Error("Git creation could not be verified; inspect Git worktrees before retrying.");
      },
    });
    const output = join(directory, "unconfirmed.json");
    expect(await runCli(["new", "retained", "--no-editor", "--no-agent", "--result-file", output], {
      context: { cwd: primary, io: { stdout: () => {}, stderr: () => {} } },
      handlers: { ...placeholderHandlers, new: createNewHandler(services) },
    })).toBe(1);
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ outcome: "failed", materialized: false, worktree: null });
    expect(await readFile(join(target, "retained"), "utf8")).toBe("inspect before retry");
    expect(await git(primary, "rev-parse", "refs/heads/retained")).toBe(await git(target, "rev-parse", "HEAD"));
  });
});
