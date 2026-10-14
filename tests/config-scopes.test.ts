import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepositoryConfig } from "../src/config";
import { repositoryFixture } from "./helpers/services";

async function scopes(run: (root: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "timber-scopes-"));
  const configRoot = join(root, "config");
  await mkdir(join(configRoot, "timber"), { recursive: true });
  try { await run(root, { HOME: root, XDG_CONFIG_HOME: configRoot }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("global defaults apply and relative worktree paths resolve from the primary repository", async () => {
  await scopes(async (root, env) => {
    await writeFile(join(env.XDG_CONFIG_HOME!, "timber/config.toml"),
      'base_branch = "trunk"\nremote = "upstream"\nworktree_dir = "../shared trees"\n[editor]\ncommand = "code"\nargs = ["--new-window"]\n');
    const config = await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }), env);
    expect(config.baseBranch).toBe("trunk");
    expect(config.remote).toBe("upstream");
    expect(config.worktreeDir).toBe(join(root, "../shared trees"));
    expect(config.editor).toEqual({ command: "code", args: ["--new-window"] });
  });
});

test("repository tables replace global tables without mixing command arguments or hook lists", async () => {
  await scopes(async (root, env) => {
    await writeFile(join(env.XDG_CONFIG_HOME!, "timber/config.toml"),
      '[editor]\ncommand = "code"\nargs = ["--new-window"]\n[agent]\ncommand = "codex"\nenabled = true\nargs = ["old"]\n[hooks]\npost_create = ["global"]\n[jira]\nsite_url = "https://global.atlassian.net"\ncloud_id = "00000000-0000-4000-8000-000000000000"\n');
    await writeFile(join(root, ".timber.toml"),
      '[editor]\ncommand = "zed"\n[agent]\ncommand = "claude"\n[hooks]\npost_create = ["local"]\n[jira]\nsite_url = "https://local.atlassian.net/"\n');
    const config = await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }), env);
    expect(config.editor).toEqual({ command: "zed", args: [] });
    expect(config.agent).toEqual({ command: "claude", args: [], enabled: false });
    expect(config.hooks).toEqual({ postCreate: ["local"] });
    expect(config.jira).toEqual({ siteUrl: "https://local.atlassian.net" });
  });
});

test("explicit local false disables all inherited integrations", async () => {
  await scopes(async (root, env) => {
    await writeFile(join(env.XDG_CONFIG_HOME!, "timber/config.toml"),
      '[editor]\ncommand = "code"\n[agent]\ncommand = "codex"\nenabled = true\n[hooks]\npost_create = ["global"]\n[jira]\nsite_url = "https://global.atlassian.net"\n');
    await writeFile(join(root, ".timber.toml"), 'editor = false\nagent = false\nhooks = false\njira = false\n');
    expect(await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }), env)).toEqual({
      baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null,
    });
  });
});

test("an invalid overwritten global value still fails without printing source values", async () => {
  await scopes(async (root, env) => {
    await writeFile(join(env.XDG_CONFIG_HOME!, "timber/config.toml"), 'remote = 1234567\n');
    await writeFile(join(root, ".timber.toml"), 'remote = "origin"\n');
    const failure = await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }), env).catch(e => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("timber/config.toml");
    expect(failure.message).toContain("remote");
    expect(failure.message).not.toContain("1234567");
  });
});

test("empty or relative XDG_CONFIG_HOME uses the home fallback", async () => {
  await scopes(async (root) => {
    await mkdir(join(root, ".config/timber"), { recursive: true });
    await writeFile(join(root, ".config/timber/config.toml"), 'remote = "home-remote"\n');
    for (const xdg of ["", "relative"]) {
      const config = await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }),
        { HOME: root, XDG_CONFIG_HOME: xdg });
      expect(config.remote).toBe("home-remote");
    }
  });
});
