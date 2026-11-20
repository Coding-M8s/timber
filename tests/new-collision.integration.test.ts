import { expect, test } from "bun:test";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { placeholderHandlers, runCli } from "../src/cli";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import { loadRepositoryConfig } from "../src/config";
import { writeBaseAssociation } from "../src/git/base-metadata";
import { resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { inspectNewBranchCollision } from "../src/git/new-collision";
import { resolveOpenTarget } from "../src/git/open-target";
import { discoverRepository } from "../src/git/repository";
import { runSetup } from "../src/hooks";
import type { CommandHandlers } from "../src/services";
import { git, withRepository as withBareRepository } from "./helpers/git";
import { createServiceDouble } from "./helpers/services";

/** Every scenario needs a configured base because `new` resolves it before the guard runs. */
const withRepository: typeof withBareRepository = run => withBareRepository(async (primary, directory) => {
  await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\n');
  await run(primary, directory);
});

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, "new", ...args], {
  cwd, reject: false, timeout: 30_000, env: { CI: "true" },
});
const author = ["-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid"];

async function commit(cwd: string, file: string, text: string, message: string): Promise<void> {
  await writeFile(join(cwd, file), text);
  await git(cwd, "add", file);
  await git(cwd, ...author, "commit", "-m", message);
}

async function addBareRemote(primary: string, directory: string, name: string): Promise<string> {
  const bare = join(directory, `${name}.git`);
  await git(directory, "init", "--bare", bare);
  await git(primary, "remote", "add", name, bare);
  await git(primary, "push", name, "trunk");
  return bare;
}

/** Feature branch with two pushed commits, then local worktree and branch removed, trunk advanced. */
async function incident(primary: string, directory: string, name = "feature/incident") {
  const bare = await addBareRemote(primary, directory, "origin");
  const scratch = join(directory, "scratch-worktree");
  await git(primary, "worktree", "add", "-b", name, scratch, "trunk");
  await commit(scratch, "one.txt", "one\n", "first");
  await commit(scratch, "two.txt", "two\n", "second");
  await git(scratch, "push", "-u", "origin", name);
  const tip = await git(scratch, "rev-parse", "HEAD");
  await git(primary, "worktree", "remove", "--force", scratch);
  await git(primary, "branch", "-D", name);
  await commit(primary, "advanced.txt", "advanced\n", "advance trunk");
  return { bare, tip };
}

async function snapshot(primary: string, directory: string, bare: string) {
  return {
    refs: await git(primary, "show-ref"),
    remote: await git(bare, "show-ref"),
    worktrees: await git(primary, "worktree", "list", "--porcelain", "-z"),
    entries: (await readdir(directory)).sort(),
  };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

function realHandlers(): CommandHandlers {
  const shared = {
    discoverRepository, loadConfig: loadRepositoryConfig, createWorktree, runSetup,
    launchEditor: async () => ({ kind: "skipped" } as const),
    launchAgent: async () => ({ kind: "skipped" } as const),
  };
  const open = createOpenHandler({ ...shared, resolveOpenTarget });
  return {
    ...placeholderHandlers,
    new: createNewHandler({
      ...createServiceDouble(), ...shared, resolveBase, writeBaseAssociation, inspectNewBranchCollision,
      openExisting: open,
    }),
    open,
  };
}

type Choose = (message: string, choices: readonly { value: string; label: string; default?: boolean }[]) => Promise<string | null>;

async function run(cwd: string, choose: Choose | undefined, ...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["new", ...args], {
    handlers: realHandlers(),
    context: {
      cwd, io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
      ...(choose === undefined ? {} : { choose }),
    },
  });
  return { code, stdout, stderr };
}

const withHook = (primary: string) => writeFile(join(primary, ".timber.toml"),
  'base_branch = "trunk"\n\n[hooks]\npost_create = ["touch hook-ran.txt"]\n');

test("incident: unattended refusal keeps state and prints the exact open command", async () => {
  await withRepository(async (primary, directory) => {
    const { bare } = await incident(primary, directory);
    await withHook(primary);
    const before = await snapshot(primary, directory, bare);
    const result = await cli(primary, "feature/incident", "--no-editor", "--no-agent");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Branch feature/incident already exists on origin. Did you mean timber open?");
    expect(result.stderr).toContain("timber open -- 'origin/feature/incident'");
    expect(await snapshot(primary, directory, bare)).toEqual(before);
    expect(await exists(join(directory, "primary repo-worktrees", "feature-incident"))).toBe(false);
  });
});

test("incident: cancel exits cleanly with no changes and no hooks", async () => {
  await withRepository(async (primary, directory) => {
    const { bare } = await incident(primary, directory);
    await withHook(primary);
    const before = await snapshot(primary, directory, bare);
    const prompts: string[] = [];
    const result = await run(primary, async (message, choices) => {
      prompts.push(message);
      expect(choices.find(choice => choice.default)?.label).toBe("Cancel");
      return null;
    }, "feature/incident", "--no-editor", "--no-agent");
    expect(result).toMatchObject({ code: 0, stdout: "Cancelled.\n" });
    expect(prompts[0]).toContain("Branch already exists on origin. Did you mean timber open?");
    expect(await snapshot(primary, directory, bare)).toEqual(before);
  });
});

test("incident: accepted open restores the pushed history and upstream, not the advanced base", async () => {
  await withRepository(async (primary, directory) => {
    const { bare, tip } = await incident(primary, directory);
    const remoteBefore = await git(bare, "show-ref");
    const result = await run(primary, async (_message, choices) => choices.find(choice => choice.label === "Open existing branch")!.value,
      "feature/incident", "--no-editor", "--no-agent");
    expect(result.code).toBe(0);
    const target = join(directory, "primary repo-worktrees", "feature-incident");
    expect(await git(target, "rev-parse", "HEAD")).toBe(tip);
    expect(await readFile(join(target, "one.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(target, "two.txt"), "utf8")).toBe("two\n");
    expect(await exists(join(target, "advanced.txt"))).toBe(false);
    const advanced = await git(primary, "rev-parse", "trunk");
    const ancestor = await execa("git", ["merge-base", "--is-ancestor", advanced, tip], { cwd: primary, reject: false });
    expect(ancestor.exitCode).toBe(1);
    expect(await git(primary, "config", "branch.feature/incident.remote")).toBe("origin");
    expect(await git(primary, "config", "branch.feature/incident.merge")).toBe("refs/heads/feature/incident");
    expect(await git(bare, "show-ref")).toBe(remoteBefore);
  });
});

test("unfetched remote branch from a second clone is found live and opened at the live tip", async () => {
  await withRepository(async (primary, directory) => {
    const bare = await addBareRemote(primary, directory, "origin");
    const other = join(directory, "other clone");
    await git(directory, "clone", bare, other);
    await git(other, "checkout", "-b", "feature/fresh");
    await commit(other, "fresh.txt", "fresh\n", "fresh work");
    await git(other, "push", "origin", "feature/fresh");
    const tip = await git(other, "rev-parse", "HEAD");
    expect(await git(primary, "for-each-ref", "refs/remotes/origin/feature")).toBe("");
    const prompts: string[] = [];
    const result = await run(primary, async (message, choices) => {
      prompts.push(message);
      return choices[0]!.value;
    }, "feature/fresh", "--no-editor", "--no-agent");
    expect(result.code).toBe(0);
    expect(prompts[0]).toContain("Cached origin/feature/fresh: missing; live: " + tip.slice(0, 12));
    expect(await git(join(directory, "primary repo-worktrees", "feature-fresh"), "rev-parse", "HEAD")).toBe(tip);
  });
});

test("stale tracking ref is surfaced and open uses the live tip", async () => {
  await withRepository(async (primary, directory) => {
    const { tip } = await incident(primary, directory);
    const older = await git(primary, "rev-parse", "trunk~1");
    await git(primary, "update-ref", "refs/remotes/origin/feature/incident", older);
    const prompts: string[] = [];
    const result = await run(primary, async (message, choices) => { prompts.push(message); return choices[0]!.value; },
      "feature/incident", "--no-editor", "--no-agent");
    expect(result.code).toBe(0);
    expect(prompts[0]).toContain(`Cached origin/feature/incident: ${older.slice(0, 12)}; live: ${tip.slice(0, 12)}`);
    expect(await git(join(directory, "primary repo-worktrees", "feature-incident"), "rev-parse", "HEAD")).toBe(tip);
  });
});

test("deleted upstream with a surviving tracking ref refuses and keeps the tracking ref", async () => {
  await withRepository(async (primary, directory) => {
    const { bare } = await incident(primary, directory);
    await git(bare, "update-ref", "-d", "refs/heads/feature/incident");
    const before = await snapshot(primary, directory, bare);
    let prompted = false;
    const result = await run(primary, async () => { prompted = true; return null; }, "feature/incident", "--no-editor", "--no-agent");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is missing on origin");
    expect(prompted).toBe(false);
    expect(await git(primary, "rev-parse", "refs/remotes/origin/feature/incident")).toMatch(/^[0-9a-f]{40}$/u);
    expect(await snapshot(primary, directory, bare)).toEqual(before);
  });
});

test("remote lookup failure is unknown, refuses creation and changes nothing", async () => {
  await withRepository(async (primary, directory) => {
    const bare = await addBareRemote(primary, directory, "origin");
    await git(primary, "remote", "set-url", "origin", join(directory, "does-not-exist.git"));
    const before = await snapshot(primary, directory, bare);
    const result = await cli(primary, "feature/unreachable", "--no-editor", "--no-agent");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Could not verify whether feature/unreachable exists on origin; its state is unknown.");
    expect(await snapshot(primary, directory, bare)).toEqual(before);
  });
});

test("target changing after selection leaves no worktree and no local ref", async () => {
  await withRepository(async (primary, directory) => {
    const { bare } = await incident(primary, directory);
    const result = await run(primary, async () => {
      await git(bare, "update-ref", "-d", "refs/heads/feature/incident");
      return "origin";
    }, "feature/incident", "--no-editor", "--no-agent");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("changed or disappeared after selection");
    expect(await git(primary, "for-each-ref", "refs/heads/feature")).toBe("");
    expect(await exists(join(directory, "primary repo-worktrees", "feature-incident"))).toBe(false);
  });
});

test("two remotes require an explicit choice and open the chosen one", async () => {
  await withRepository(async (primary, directory) => {
    await addBareRemote(primary, directory, "origin");
    const second = await addBareRemote(primary, directory, "upstream");
    await git(primary, "push", "origin", "trunk:feature/shared");
    await commit(primary, "extra.txt", "extra\n", "extra");
    await git(primary, "push", "upstream", "trunk:feature/shared");
    const unattended = await cli(primary, "feature/shared", "--no-editor", "--no-agent");
    expect(unattended.exitCode).toBe(1);
    expect(unattended.stderr).toContain("timber open -- 'origin/feature/shared'");
    expect(unattended.stderr).toContain("timber open -- 'upstream/feature/shared'");
    const labels: string[] = [];
    const result = await run(primary, async (_message, offered) => {
      labels.push(...offered.map(choice => choice.label));
      return "upstream";
    }, "feature/shared", "--no-editor", "--no-agent");
    expect(result.code).toBe(0);
    expect(labels.slice(0, 2).join(" ")).toContain("origin/feature/shared");
    const target = join(directory, "primary repo-worktrees", "feature-shared");
    expect(await git(target, "config", "branch.feature/shared.remote")).toBe("upstream");
    expect(await git(second, "rev-parse", "refs/heads/feature/shared")).toBe(await git(target, "rev-parse", "HEAD"));
  });
});

test("config remote limits which remotes are checked", async () => {
  await withRepository(async (primary, directory) => {
    await addBareRemote(primary, directory, "origin");
    await addBareRemote(primary, directory, "upstream");
    await git(primary, "push", "upstream", "trunk:feature/only-upstream");
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "trunk"\nremote = "origin"\n');
    const repository = await discoverRepository(primary);
    const config = await loadRepositoryConfig(repository);
    const inspection = await inspectNewBranchCollision(repository, "feature/only-upstream", config);
    expect(inspection.remotes.map(remote => remote.remote)).toEqual(["origin"]);
    expect(inspection.remotes[0]!.live).toEqual({ kind: "missing" });
  });
});

test("inspection matches exact refs only, not remote-looking local names or nested suffixes", async () => {
  await withRepository(async (primary, directory) => {
    const bare = await addBareRemote(primary, directory, "origin");
    await git(primary, "branch", "origin/x");
    await git(bare, "update-ref", "refs/heads/x/refs/heads/target", await git(primary, "rev-parse", "trunk"));
    const repository = await discoverRepository(primary);
    const config = await loadRepositoryConfig(repository);
    const nested = await inspectNewBranchCollision(repository, "target", config);
    expect(nested.remotes[0]!.live).toEqual({ kind: "missing" });
    const local = await inspectNewBranchCollision(repository, "origin/x", config);
    expect(local.local).not.toBeNull();
    expect(local.remotes).toEqual([]);
  });
});

test("local collision keeps its tip and upstream config and suggests open", async () => {
  await withRepository(async (primary, directory) => {
    const bare = await addBareRemote(primary, directory, "origin");
    await git(primary, "branch", "feature/local", "trunk");
    const tip = await git(primary, "rev-parse", "feature/local");
    const configBefore = await git(primary, "config", "--local", "--list");
    const before = await snapshot(primary, directory, bare);
    const result = await cli(primary, "feature/local", "--no-editor", "--no-agent");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Branch feature/local already exists. Use timber open instead.");
    expect(result.stderr).toContain("timber open -- 'feature/local'");
    expect(await git(primary, "rev-parse", "feature/local")).toBe(tip);
    expect(await git(primary, "config", "--local", "--list")).toBe(configBefore);
    expect(await snapshot(primary, directory, bare)).toEqual(before);
  });
});

test("--base with a remote collision refuses and keeps state", async () => {
  await withRepository(async (primary, directory) => {
    const { bare } = await incident(primary, directory);
    const before = await snapshot(primary, directory, bare);
    const result = await cli(primary, "feature/incident", "--base", "trunk", "--no-editor", "--no-agent");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--base trunk cannot be applied: branch feature/incident already exists on origin.");
    expect(await snapshot(primary, directory, bare)).toEqual(before);
  });
});

test("repositories without remotes still create new branches", async () => {
  await withRepository(async (primary, directory) => {
    const result = await cli(primary, "feature/plain", "--no-editor", "--no-agent");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Created feature/plain at ${join(directory, "primary repo-worktrees", "feature-plain")}`);
  });
});
