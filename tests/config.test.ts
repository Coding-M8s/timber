import { expect, test } from "bun:test";
import { execa } from "execa";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRepositoryConfig } from "../src/config";
import { repositoryFixture } from "./helpers/services";

test("returns normalized defaults when .timber.toml is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber config "));
  try {
    expect(await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }))).toEqual({
      baseBranch: null,
      remote: null,
      worktreeDir: null,
      editor: null,
      agent: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads the primary root config from nested and linked-worktree contexts", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber config "));
  const primaryRoot = join(root, "primary repo");
  const linked = join(root, "linked worktree");
  try {
    await execa("git", ["init", primaryRoot]);
    await execa("git", ["-C", primaryRoot, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await execa("git", [
      "-C", primaryRoot,
      "-c", "user.name=Timber Test",
      "-c", "user.email=timber-test@example.invalid",
      "commit", "--allow-empty", "-m", "initial",
    ]);
    await execa("git", ["-C", primaryRoot, "worktree", "add", "-b", "feature", linked]);
    await mkdir(join(primaryRoot, "nested"));
    await writeFile(join(primaryRoot, ".timber.toml"), 'base_branch = "main"\n');
    await writeFile(join(primaryRoot, "nested", ".timber.toml"), 'base_branch = "nested"\n');
    await writeFile(join(linked, ".timber.toml"), 'base_branch = "linked"\n');
    const nested = repositoryFixture({
      primaryWorktreeRoot: primaryRoot,
      currentWorktreeRoot: join(primaryRoot, "nested"),
      commonGitDir: join(primaryRoot, ".git"),
    });
    const linkedContext = repositoryFixture({
      primaryWorktreeRoot: primaryRoot,
      currentWorktreeRoot: linked,
      commonGitDir: join(primaryRoot, ".git"),
      currentBranch: "feature",
    });
    expect((await loadRepositoryConfig(nested)).baseBranch).toBe("main");
    expect((await loadRepositoryConfig(linkedContext)).baseBranch).toBe("main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses editor and agent commands and resolves worktree_dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber config "));
  try {
    await writeFile(join(root, ".timber.toml"), [
      'base_branch = "main"',
      'remote = "upstream"',
      'worktree_dir = "worktrees with spaces"',
      "[editor]",
      'command = "zed"',
      'args = ["--wait"]',
      "[agent]",
      'command = "claude"',
    ].join("\n"));
    const repository = repositoryFixture({ primaryWorktreeRoot: root });
    expect(await loadRepositoryConfig(repository)).toEqual({
      baseBranch: "main",
      remote: "upstream",
      worktreeDir: resolve(root, "worktrees with spaces"),
      editor: { command: "zed", args: ["--wait"], enabled: false },
      agent: { command: "claude", args: [], enabled: false },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defaults args and retains an explicitly enabled agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber config "));
  try {
    await writeFile(join(root, ".timber.toml"), '[editor]\ncommand = "zed"\n[agent]\ncommand = "claude"\nenabled = true\n');
    const config = await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }));
    expect(config.editor).toEqual({ command: "zed", args: [], enabled: false });
    expect(config.agent).toEqual({ command: "claude", args: [], enabled: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editor enabled is strict and preserves a configured command for explicit launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber editor config "));
  try {
    await writeFile(join(root, ".timber.toml"), '[editor]\ncommand = "zed"\nenabled = true\n');
    expect((await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }))).editor)
      .toEqual({ command: "zed", args: [], enabled: true });
    await writeFile(join(root, ".timber.toml"), '[editor]\ncommand = "zed"\nenabled = "false"\n');
    await expect(loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root })))
      .rejects.toThrow(/editor\.enabled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an absolute worktree_dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber config "));
  const absolute = join(root, "chosen worktrees");
  try {
    await writeFile(join(root, ".timber.toml"), `worktree_dir = "${absolute}"\n`);
    const config = await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }));
    expect(config.worktreeDir).toBe(absolute);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes Jira site URLs and maps an optional cloud ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber jira config "));
  try {
    await writeFile(join(root, ".timber.toml"), [
      '[jira]',
      'site_url = "https://example.atlassian.net/"',
      'cloud_id = "00000000-0000-4000-8000-000000000000"',
    ].join("\n"));
    expect(await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }))).toEqual({
      baseBranch: null,
      remote: null,
      worktreeDir: null,
      editor: null,
      agent: null,
      jira: {
        siteUrl: "https://example.atlassian.net",
        cloudId: "00000000-0000-4000-8000-000000000000",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads Jira config only from the primary root", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber jira config "));
  const primaryRoot = join(root, "primary repo");
  const linked = join(root, "linked worktree");
  try {
    await execa("git", ["init", primaryRoot]);
    await execa("git", ["-C", primaryRoot, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await execa("git", [
      "-C", primaryRoot,
      "-c", "user.name=Timber Test",
      "-c", "user.email=timber-test@example.invalid",
      "commit", "--allow-empty", "-m", "initial",
    ]);
    await execa("git", ["-C", primaryRoot, "worktree", "add", "-b", "feature", linked]);
    await mkdir(join(primaryRoot, "nested"));
    await writeFile(join(primaryRoot, ".timber.toml"), '[jira]\nsite_url = "https://primary.atlassian.net"\n');
    await writeFile(join(primaryRoot, "nested", ".timber.toml"), '[jira]\nsite_url = "https://nested.atlassian.net"\n');
    await writeFile(join(linked, ".timber.toml"), '[jira]\nsite_url = "https://linked.atlassian.net"\n');
    const nested = repositoryFixture({
      primaryWorktreeRoot: primaryRoot,
      currentWorktreeRoot: join(primaryRoot, "nested"),
      commonGitDir: join(primaryRoot, ".git"),
    });
    const linkedContext = repositoryFixture({
      primaryWorktreeRoot: primaryRoot,
      currentWorktreeRoot: linked,
      commonGitDir: join(primaryRoot, ".git"),
      currentBranch: "feature",
    });
    expect((await loadRepositoryConfig(nested)).jira?.siteUrl).toBe("https://primary.atlassian.net");
    expect((await loadRepositoryConfig(linkedContext)).jira?.siteUrl).toBe("https://primary.atlassian.net");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves surrounding whitespace in editor and agent executable paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber config "));
  try {
    await writeFile(join(root, ".timber.toml"), '[editor]\ncommand = " /tmp/editor "\n[agent]\ncommand = " /tmp/agent "\n');
    const config = await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }));
    expect(config.editor?.command).toBe(" /tmp/editor ");
    expect(config.agent?.command).toBe(" /tmp/agent ");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const section of ["", "editor", "agent"]) {
  test(`reports each unsupported key separately in ${section || "root"}`, async () => {
    const prefix = section === "" ? "" : `${section}.`;
    const source = section === "" ? "" : `[${section}]\ncommand = "tool"\n`;
    await expectConfigError(
      `${source}foo = "SECRET_MARKER"\nbar = "SECRET_MARKER"\n`,
      `${prefix}foo is not supported; ${prefix}bar is not supported`,
      "SECRET_MARKER",
    );
  });
}

test("preserves surrounding spaces in worktree_dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber config "));
  const relative = " worktrees ";
  try {
    await writeFile(join(root, ".timber.toml"), `worktree_dir = "${relative}"\n`);
    const config = await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }));
    expect(config.worktreeDir).toBe(resolve(root, relative));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function expectConfigError(source: string, expected: string, forbidden: string) {
  const root = await mkdtemp(join(tmpdir(), "timber config "));
  const configPath = join(root, ".timber.toml");
  try {
    await writeFile(configPath, source);
    const message = await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }))
      .then(() => "resolved", error => error instanceof Error ? error.message : "unknown error");
    expect(message).toContain(configPath);
    expect(message).toContain(expected);
    if (forbidden.length > 0) expect(message).not.toContain(forbidden);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const example of [
  { source: '[workflows."bad name"]\npost_create = []', field: "workflows.bad name" },
  { source: '[workflows.review]\npost_create = [" "]', field: "workflows.review.post_create" },
  { source: '[workflows.review.editor]\nargs = []', field: "workflows.review.editor.command" },
  { source: '[workflows.review.agent]\ncommand = "claude"\nenabled = true', field: "workflows.review.agent.enabled" },
  { source: '[workflows.review]\napi_token = "SECRET_MARKER"', field: "workflows.review.api_token" },
]) {
  test(`rejects invalid workflow field ${example.field} without exposing values`, async () => {
    await expectConfigError(example.source, example.field, "SECRET_MARKER");
  });
}

for (const example of [
  { source: "base_branch = 77777", field: "base_branch", value: "77777" },
  { source: "remote = 77777", field: "remote", value: "77777" },
  { source: "worktree_dir = 77777", field: "worktree_dir", value: "77777" },
  { source: 'worktree_dir = " "', field: "worktree_dir", value: "" },
  { source: '[editor]\ncommand = ""', field: "editor.command", value: "" },
  { source: '[editor]\ncommand = " "', field: "editor.command", value: "" },
  { source: '[editor]\ncommand = "zed"\nargs = "--wait"', field: "editor.args", value: "--wait" },
  { source: '[editor]\ncommand = "zed"\nargs = [77777]', field: "editor.args", value: "77777" },
  { source: '[agent]\ncommand = "claude"\nenabled = 77777', field: "agent.enabled", value: "77777" },
  { source: '[agent]\nenabled = false', field: "agent.command", value: "false" },
  { source: '[agent]\ncommand = " "', field: "agent.command", value: "" },
  { source: 'api_token = "SECRET_MARKER"', field: "api_token", value: "SECRET_MARKER" },
  { source: '[agent]\ncommand = "claude"\ntoken = "SECRET_MARKER"', field: "token", value: "SECRET_MARKER" },
  { source: '[jira]\nsite_url = "https://example.atlassian.net"\napi_token = "SECRET_MARKER"', field: "jira.api_token", value: "SECRET_MARKER" },
  { source: '[jira]\nsite_url = "https://example.atlassian.net"\nemail = "SECRET_MARKER"', field: "jira.email", value: "SECRET_MARKER" },
  { source: '[jira]\nsite_url = "https://example.atlassian.net"\ncloud_id = "not-a-uuid"', field: "jira.cloud_id", value: "not-a-uuid" },
]) {
  test(`rejects invalid config at ${example.field}`, async () => {
    await expectConfigError(example.source, example.field, example.value);
  });
}

for (const example of [
  { value: "http://example.atlassian.net", label: "non-HTTPS" },
  { value: "https://example.atlassian.net:8443", label: "nondefault port" },
  { value: "https://user@example.atlassian.net", label: "userinfo" },
  { value: "https://example.atlassian.net/path", label: "path" },
  { value: "https://example.atlassian.net/a/..", label: "normalized-away path" },
  { value: "https://example.atlassian.net/%2e%2e", label: "encoded normalized-away path" },
  { value: "https://example.atlassian.net?query", label: "query" },
  { value: "https://example.atlassian.net#fragment", label: "fragment" },
  { value: "https://example.invalid", label: "non-Atlassian host" },
  { value: " https://example.atlassian.net", label: "leading whitespace" },
  { value: "https://example\\\\atlassian.net", label: "backslash" },
  { value: "https://example.atlassian.net\\n", label: "control character" },
]) {
  test(`rejects unsafe Jira site URL (${example.label}) without exposing it`, async () => {
    await expectConfigError(
      `[jira]\nsite_url = "${example.value}"\n`,
      "jira.site_url",
      example.value.replaceAll("\\", ""),
    );
  });
}

test("does not expose source values when TOML parsing fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber config "));
  const configPath = join(root, ".timber.toml");
  try {
    await writeFile(configPath, 'base_branch = "SECRET_MARKER"\nremote = [\n');
    const message = await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }))
      .then(() => "resolved", error => error instanceof Error ? error.message : "unknown error");
    expect(message).toContain(configPath);
    expect(message).toContain("Invalid TOML");
    expect(message).not.toContain("SECRET_MARKER");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a config path that is a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber config "));
  const configPath = join(root, ".timber.toml");
  try {
    await mkdir(configPath);
    await expect(loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root })))
      .rejects.toThrow(configPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses trusted post_create commands without trimming shell source", async () => {
  const root = await mkdtemp(join(tmpdir(), "timber hooks config "));
  try {
    await writeFile(join(root, ".timber.toml"), '[hooks]\npost_create = [" printf first ", "printf second"]\n');
    expect((await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }))).hooks)
      .toEqual({ postCreate: [" printf first ", "printf second"] });
    await writeFile(join(root, ".timber.toml"), "[hooks]\n");
    expect((await loadRepositoryConfig(repositoryFixture({ primaryWorktreeRoot: root }))).hooks)
      .toEqual({ postCreate: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const example of [
  { source: 'hooks = "SECRET_MARKER"', field: "hooks" },
  { source: '[hooks]\npre_delete = "SECRET_MARKER"', field: "hooks.pre_delete" },
  { source: '[hooks]\npre_delete = [77777]', field: "hooks.pre_delete.0" },
  { source: '[hooks]\npre_delete = [" "]', field: "hooks.pre_delete.0" },
  { source: '[hooks]\npre_delete = ["bad\\u0000source"]', field: "hooks.pre_delete.0" },
  { source: '[hooks]\npost_create = "SECRET_MARKER"', field: "hooks.post_create" },
  { source: '[hooks]\npost_create = [77777]', field: "hooks.post_create.0" },
  { source: '[hooks]\npost_create = [" "]', field: "hooks.post_create.0" },
  { source: '[hooks]\npost_create = ["bad\\u0000source"]', field: "hooks.post_create.0" },
  { source: '[hooks]\npost_remove = ["SECRET_MARKER"]', field: "hooks.post_remove" },
]) {
  test(`rejects invalid hooks at ${example.field} without exposing shell source`, async () => {
    await expectConfigError(example.source, example.field, "SECRET_MARKER");
  });
}
