import { expect, test } from "bun:test";
import { access, chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { checkAppIntegration } from "../src/app-config/check";
import { knownSecrets, safeAppDiagnostic } from "../src/app-config/input";
import type { AppConfigInput } from "../src/app-config/input";
import { configFileSchema, parseConfigSource } from "../src/config";
import { renderConfig } from "../src/setup/render";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const exists = (path: string) => access(path).then(() => true, () => false);
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const jiraToken = "JIRA-SECRET-TOKEN-7f3a";
const jiraEmail = "private.person@example.invalid";
const linearToken = "lin_api_SECRET_91c2";
const bitbucketToken = "ATATT_BITBUCKET_SECRET_5d1e";
const bitbucketEmail = "bitbucket.person@example.invalid";
const bitbucketLogin = { email: bitbucketEmail, token: bitbucketToken };
const bitbucketBasic = `Basic ${Buffer.from(`${bitbucketEmail}:${bitbucketToken}`).toString("base64")}`;

interface Fixture {
  primary: string;
  directory: string;
  config: string;
  globalConfig: string;
  env: { XDG_CONFIG_HOME: string; CI: string; GH_TOKEN: string; GITHUB_TOKEN: string };
  /** Runs the real CLI with no terminal, stdin closed and CI on. */
  cli(...args: string[]): Promise<{ exitCode: number | undefined; stdout: string; stderr: string; args: string[] }>;
  read(scope?: string): Promise<any>;
  /** Writes a private draft file and applies it; returns the process and its result record. */
  apply(input: unknown, ...extra: string[]): Promise<{ run: Awaited<ReturnType<Fixture["cli"]>>; record: any; streams: string }>;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withRepository(async (primary, directory) => {
    const home = join(directory, "xdg");
    const env = { XDG_CONFIG_HOME: home, CI: "true", GH_TOKEN: "", GITHUB_TOKEN: "" };
    let files = 0;
    const cli: Fixture["cli"] = async (...args) => {
      const result = await execa(process.execPath, ["--no-env-file", entry, "__app-config", ...args], {
        cwd: primary, reject: false, timeout: 20_000, stdin: "ignore",
        env: { ...env, JIRA_EMAIL: undefined, JIRA_API_TOKEN: undefined, LINEAR_API_KEY: undefined, BITBUCKET_EMAIL: undefined, BITBUCKET_API_TOKEN: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, args };
    };
    const fixture: Fixture = {
      primary, directory, env, cli, config: join(primary, ".timber.toml"), globalConfig: join(home, "timber/config.toml"),
      read: async (scope = "repository") => JSON.parse((await cli("read", "--scope", scope)).stdout),
      apply: async (input, ...extra) => {
        const inputFile = join(directory, `draft-${++files}.json`), resultFile = join(directory, `result-${files}.json`);
        await writeFile(inputFile, typeof input === "string" ? input : JSON.stringify(input), { mode: 0o600 });
        const scope = extra.includes("--scope") ? [] : ["--scope", "repository"];
        const run = await cli("apply", ...scope, ...extra, "--input-file", inputFile, "--result-file", resultFile);
        const raw = await readFile(resultFile, "utf8");
        return { run, record: JSON.parse(raw), streams: [run.stdout, run.stderr, raw, run.args.join(" ")].join("\n") };
      },
    };
    await run(fixture);
  });
}

const draft = { default_tracker: "jira", base_branch: "trunk",
  editor: { command: "code", args: ["--new-window"], enabled: true },
  hooks: { post_create: ["bun install"] }, jira: { site_url: "https://example.atlassian.net" } };

test("read reports scope values, inherited effective values and the destination without a terminal", async () => {
  await withFixture(async fixture => {
    // Setup creates these private; mirror that so the result does not depend on umask.
    await mkdir(join(fixture.globalConfig, ".."), { recursive: true, mode: 0o700 });
    await writeFile(fixture.globalConfig, 'remote = "upstream"\nbase_branch = "main"\n[agent]\ncommand = "claude"\n');
    const source = 'base_branch = "trunk"\nagent = false\n';
    await writeFile(fixture.config, source);
    const run = await fixture.cli("read", "--scope", "repository");
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    const local = JSON.parse(run.stdout);
    expect(local).toMatchObject({ schemaVersion: 1, scope: "repository", path: fixture.config, exists: true, tracked: false,
      values: { base_branch: "trunk", agent: false }, effective: { base_branch: "trunk", remote: "upstream" },
      credentials: { jira: { configured: false, state: "none", environmentOverride: false }, linear: { state: "none", environmentOverride: false },
        bitbucket: { state: "none", environmentOverride: false } } });
    expect(local.effective.agent).toBeUndefined();
    expect(local.revision).toMatch(/^[a-f0-9]{64}$/);
    const machine = await fixture.read("global");
    expect(machine).toMatchObject({ scope: "global", path: fixture.globalConfig, tracked: false,
      values: { remote: "upstream", agent: { command: "claude", args: [], enabled: false } }, effective: { base_branch: "main" } });
    // Reading is offline and writes nothing.
    expect(await readFile(fixture.config, "utf8")).toBe(source);
    expect(await git(fixture.primary, "status", "--porcelain", "--", ".git/info/exclude")).toBe("");
  });
});

test("read reports an absent file and refuses unusable arguments before any work", async () => {
  await withFixture(async fixture => {
    expect(await fixture.read()).toMatchObject({ exists: false, revision: null, values: {}, effective: {} });
    for (const args of [["read"], ["read", "--scope", "everywhere"], ["read", "--scope", "global", "--edit-tracked"], ["write", "--scope", "global"]]) {
      const run = await fixture.cli(...args);
      expect(run.exitCode).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toStartWith("error: ");
    }
    const outside = await execa(process.execPath, ["--no-env-file", entry, "__app-config", "read", "--scope", "repository"],
      { cwd: fixture.directory, reject: false, stdin: "ignore", env: fixture.env });
    expect(outside.exitCode).toBe(1);
    expect(outside.stderr).toContain("--scope global");
  });
});

test("apply saves the file setup would save, hides it from Git, and returns the next revision", async () => {
  await withFixture(async fixture => {
    const { revision } = await fixture.read();
    const { run, record } = await fixture.apply({ schemaVersion: 1, revision, values: draft });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Saved repository settings");
    const saved = await readFile(fixture.config, "utf8");
    expect(saved).toBe(renderConfig(configFileSchema.parse(draft)));
    expect(record).toMatchObject({ schemaVersion: 1, command: "config", outcome: "succeeded", exitCode: 0, worktree: null,
      materialized: false, diagnostic: null, repository: { primaryWorktreeRoot: fixture.primary },
      config: { result: "saved", scope: "repository", path: fixture.config, invalidFields: [],
        credentials: { jira: "unchanged", linear: "unchanged", bitbucket: "unchanged" } } });
    expect(await readFile(join(fixture.primary, ".git/info/exclude"), "utf8")).toContain("/.timber.toml\n");
    expect(await git(fixture.primary, "status", "--porcelain")).toBe("");
    // The returned revision lets the app keep editing without another read.
    const reread = await fixture.read();
    expect(reread.revision).toBe(record.config.revision);
    expect(reread.values).toEqual(parseConfigSource(saved, "saved.toml"));
    const next = await fixture.apply({ schemaVersion: 1, revision: record.config.revision, values: { ...draft, base_branch: "release" } });
    expect(next.record.config.result).toBe("saved");
    expect(parseConfigSource(await readFile(fixture.config, "utf8"), "saved.toml").base_branch).toBe("release");
    // No leftover locks or staging files.
    expect((await readdir(fixture.primary)).filter(name => name.includes(".tmp"))).toEqual([]);
    expect(await exists(join(fixture.primary, ".git/timber-setup.lock"))).toBe(false);
  });
});

test("apply and read keep the issue list settings for __app-issues", async () => {
  await withFixture(async fixture => {
    const values = { ...draft, jira: { site_url: "https://example.atlassian.net", board: 12, project: "ENG" },
      github: { project: "acme/5", milestone: "v2" }, linear: { team: "LIN" } };
    const { revision } = await fixture.read();
    const { record } = await fixture.apply({ schemaVersion: 1, revision, values });
    expect(record.config.result).toBe("saved");
    expect((await fixture.read()).values).toMatchObject({ jira: values.jira, github: values.github, linear: values.linear });
  });
});

test("apply to the global scope works outside a repository and creates the destination", async () => {
  await withFixture(async fixture => {
    const inputFile = join(fixture.directory, "global.json"), resultFile = join(fixture.directory, "global-result.json");
    await writeFile(inputFile, JSON.stringify({ schemaVersion: 1, revision: null, values: { remote: "upstream" } }));
    const run = await execa(process.execPath, ["--no-env-file", entry, "__app-config", "apply", "--scope", "global", "--input-file", inputFile, "--result-file", resultFile],
      { cwd: fixture.directory, reject: false, stdin: "ignore", env: fixture.env });
    expect(run.exitCode).toBe(0);
    expect(await json(resultFile)).toMatchObject({ command: "config", outcome: "succeeded", repository: null,
      config: { result: "saved", scope: "global", path: fixture.globalConfig } });
    expect(parseConfigSource(await readFile(fixture.globalConfig, "utf8"), "global.toml")).toEqual({ remote: "upstream" });
    expect(await exists(fixture.config)).toBe(false);
  });
});

test.each([
  ["a wrong type", { ...draft, editor: { command: 7 } }, "editor.command is invalid"],
  ["an unsupported key", { ...draft, colour: "PRIVATE-VALUE" }, "colour is not supported"],
  ["a non-Atlassian Jira site", { ...draft, jira: { site_url: "https://PRIVATE-VALUE.example.com" } }, "jira.site_url is invalid"],
  ["an edited workflow", { ...draft, workflows: { review: { post_create: ["PRIVATE-VALUE"] } } }, "workflows cannot be changed here"],
  ["an edited backup retention", { ...draft, backup_retention_days: 3 }, "backup_retention_days cannot be changed here"],
])("apply with %s names the field, prints no value, and changes nothing", async (_name, values, field) => {
  await withFixture(async fixture => {
    const source = 'base_branch = "trunk"\n\n[workflows.review]\npost_create = ["bun test"]\n';
    await writeFile(fixture.config, source);
    const exclude = await readFile(join(fixture.primary, ".git/info/exclude"), "utf8");
    const { revision } = await fixture.read();
    const { run, record, streams } = await fixture.apply({ schemaVersion: 1, revision, values,
      credentials: { linear: { token: linearToken } } });
    expect(run.exitCode).toBe(1);
    expect(record).toMatchObject({ command: "config", outcome: "failed", exitCode: 1,
      config: { result: "invalid", invalidFields: [field], revision: null } });
    expect(record.diagnostic).toContain(field);
    expect(run.stderr).toContain(field);
    expect(streams).not.toContain("PRIVATE-VALUE");
    expect(streams).not.toContain(linearToken);
    expect(await readFile(fixture.config, "utf8")).toBe(source);
    expect(await readFile(join(fixture.primary, ".git/info/exclude"), "utf8")).toBe(exclude);
    expect(await exists(join(fixture.env.XDG_CONFIG_HOME, "timber/credentials"))).toBe(false);
  });
});

test("apply rejects a malformed input file without echoing it or creating settings", async () => {
  await withFixture(async fixture => {
    for (const [input, expected] of [
      [`{"schemaVersion":1,"values":{"token":"${jiraToken}"`, "not valid JSON"],
      [{ schemaVersion: 2, revision: null, values: {} }, "schemaVersion is invalid"],
      [{ schemaVersion: 1, values: {} }, "revision is invalid"],
      [{ schemaVersion: 1, revision: null, values: {}, credentials: { jira: { email: jiraEmail, token: jiraToken, extra: true } } }, "credentials.jira.extra is not supported"],
      [{ schemaVersion: 1, revision: null, values: {}, credentials: { jira: { email: jiraEmail, token: jiraToken } } }, "credentials.jira needs a configured Jira site"],
      [{ schemaVersion: 1, revision: null, values: draft, credentials: { jira: { email: "not-an-email", token: jiraToken } } }, "credentials.jira is invalid"],
    ] as const) {
      const { run, record, streams } = await fixture.apply(input);
      expect(run.exitCode).toBe(1);
      expect(record.outcome).toBe("failed");
      expect(record.diagnostic).toContain(expected);
      expect(streams).not.toContain(jiraToken);
      expect(streams).not.toContain(jiraEmail);
      expect(await exists(fixture.config)).toBe(false);
    }
  });
});

test("apply refuses when the file changed after it was read, including creation and removal", async () => {
  await withFixture(async fixture => {
    // Created by someone else after an absent read.
    const absent = await fixture.read();
    await writeFile(fixture.config, 'remote = "theirs"\n');
    const created = await fixture.apply({ schemaVersion: 1, revision: absent.revision, values: draft });
    expect(created.run.exitCode).toBe(1);
    expect(created.record).toMatchObject({ outcome: "failed", config: { result: "conflict", revision: null } });
    expect(created.record.diagnostic).toContain("changed since they were read");
    expect(await readFile(fixture.config, "utf8")).toBe('remote = "theirs"\n');
    // Edited by someone else after a read.
    const before = await fixture.read();
    await writeFile(fixture.config, 'remote = "theirs"\nbase_branch = "main"\n');
    const edited = await fixture.apply({ schemaVersion: 1, revision: before.revision, values: draft });
    expect(edited.record.config.result).toBe("conflict");
    expect(await readFile(fixture.config, "utf8")).toBe('remote = "theirs"\nbase_branch = "main"\n');
    // A fresh read makes the same draft applicable.
    const fresh = await fixture.read();
    expect((await fixture.apply({ schemaVersion: 1, revision: fresh.revision, values: draft })).record.config.result).toBe("saved");
  });
});

test("workflow tables, arena presets and inherited machine defaults survive an apply", async () => {
  await withFixture(async fixture => {
    // Setup creates these private; mirror that so the result does not depend on umask.
    await mkdir(join(fixture.globalConfig, ".."), { recursive: true, mode: 0o700 });
    const machine = 'remote = "upstream"\n\n[workflows.shared]\npost_create = ["bun install"]\n';
    await writeFile(fixture.globalConfig, machine);
    await writeFile(fixture.config, [
      '# hand-written comment', 'base_branch = "trunk"', 'worktree_dir = "../trees"', '',
      '[arena.agents.fast]', 'tool = "codex"', 'command = "codex"', 'args = []', '',
      '[workflows.review]', 'description = "Review"', 'post_create = ["bun test"]', '',
      '[workflows.review.agent]', 'command = "claude"', 'args = ["--review"]', '',
    ].join("\n").replace('worktree_dir = "../trees"', 'worktree_dir = "../trees"\nbackup_retention_days = false\nbackup_storage_warning = "1GiB"'));
    const before = await fixture.read();
    // Omitting the tables and repeating them unchanged are both accepted. Backup settings are
    // carried over too, so an app that does not know them can never turn automatic deletion back on.
    const { workflows, arena, backup_retention_days, backup_storage_warning, ...managed } = before.values;
    expect({ backup_retention_days, backup_storage_warning }).toEqual({ backup_retention_days: false, backup_storage_warning: "1GiB" });
    const omitted = await fixture.apply({ schemaVersion: 1, revision: before.revision, values: { ...managed, base_branch: "main" } });
    expect(omitted.record.config.result).toBe("saved");
    const repeated = await fixture.apply({ schemaVersion: 1, revision: omitted.record.config.revision,
      values: { ...before.values, base_branch: "release", editor: { command: "zed", args: [], enabled: false } } });
    expect(repeated.record.config.result).toBe("saved");
    const after = await fixture.read();
    expect(after.values.workflows).toEqual(workflows);
    expect(after.values.arena).toEqual(arena);
    expect(after.values).toMatchObject({ backup_retention_days: false, backup_storage_warning: "1GiB" });
    expect(after.values).toMatchObject({ base_branch: "release", worktree_dir: "../trees", editor: { command: "zed" } });
    expect(after.effective).toMatchObject({ remote: "upstream", workflows: { shared: { post_create: ["bun install"] }, review: { description: "Review" } } });
    // A key left out of a complete draft is removed from this scope and inherits again.
    const { worktree_dir: _removed, ...without } = after.values;
    await fixture.apply({ schemaVersion: 1, revision: after.revision, values: without });
    expect((await fixture.read()).values.worktree_dir).toBeUndefined();
    expect(await readFile(fixture.globalConfig, "utf8")).toBe(machine);
  });
});

test("credentials are saved privately and never reach arguments, streams, records or settings", async () => {
  await withFixture(async fixture => {
    const store = join(fixture.env.XDG_CONFIG_HOME, "timber/credentials");
    const saved = await fixture.apply({ schemaVersion: 1, revision: null, values: draft,
      credentials: { jira: { email: jiraEmail, token: jiraToken }, linear: { token: linearToken }, bitbucket: bitbucketLogin } });
    expect(saved.run.exitCode).toBe(0);
    expect(saved.record.config).toMatchObject({ result: "saved", credentials: { jira: "saved", linear: "saved", bitbucket: "saved" } });
    for (const secret of [jiraToken, jiraEmail, linearToken, bitbucketToken, bitbucketEmail]) expect(saved.streams).not.toContain(secret);
    expect(await readFile(fixture.config, "utf8")).not.toContain(bitbucketToken);
    expect(await readFile(fixture.config, "utf8")).not.toContain(jiraToken);
    // The existing private stores hold them under the existing rules.
    expect((await json(join(store, "jira.json"))).records).toEqual([{ siteUrl: "https://example.atlassian.net", email: jiraEmail, token: jiraToken }]);
    expect(await json(join(store, "linear.json"))).toEqual({ version: 1, token: linearToken });
    expect(await json(join(store, "bitbucket.json"))).toEqual({ version: 1, email: bitbucketEmail, token: bitbucketToken });
    if (process.platform !== "win32") {
      expect((await stat(join(store, "jira.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(store, "bitbucket.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(store)).mode & 0o777).toBe(0o700);
    }
    const read = await fixture.cli("read", "--scope", "repository");
    expect(JSON.parse(read.stdout).credentials).toEqual({ jira: { configured: true, state: "saved", environmentOverride: false },
      linear: { state: "saved", environmentOverride: false }, bitbucket: { state: "saved", environmentOverride: false } });
    for (const secret of [jiraToken, jiraEmail, linearToken, bitbucketToken, bitbucketEmail]) expect(read.stdout + read.stderr).not.toContain(secret);
    // Leaving credentials out keeps them; null removes them.
    const kept = await fixture.apply({ schemaVersion: 1, revision: saved.record.config.revision, values: { ...draft, remote: "origin" } });
    expect(kept.record.config.credentials).toEqual({ jira: "unchanged", linear: "unchanged", bitbucket: "unchanged" });
    expect((await fixture.read()).credentials.bitbucket.state).toBe("saved");
    expect((await fixture.read()).credentials.jira.state).toBe("saved");
    const removed = await fixture.apply({ schemaVersion: 1, revision: kept.record.config.revision, values: draft,
      credentials: { jira: null, linear: null, bitbucket: null } });
    expect(removed.record.config.credentials).toEqual({ jira: "removed", linear: "removed", bitbucket: "removed" });
    expect(await exists(join(store, "bitbucket.json"))).toBe(false);
    expect(await exists(join(store, "jira.json"))).toBe(false);
    expect(await exists(join(store, "linear.json"))).toBe(false);
  });
});

test("a failed save keeps credentials unpublished and a shared draft file is refused", async () => {
  await withFixture(async fixture => {
    await writeFile(fixture.config, 'remote = "theirs"\n');
    const stale = await fixture.apply({ schemaVersion: 1, revision: null, values: draft,
      credentials: { jira: { email: jiraEmail, token: jiraToken }, linear: { token: linearToken }, bitbucket: bitbucketLogin } });
    expect(stale.record.config.result).toBe("conflict");
    for (const secret of [jiraToken, jiraEmail, linearToken, bitbucketToken, bitbucketEmail]) expect(stale.streams).not.toContain(secret);
    expect(await exists(join(fixture.env.XDG_CONFIG_HOME, "timber/credentials"))).toBe(false);
    if (process.platform === "win32") return;
    const inputFile = join(fixture.directory, "shared.json"), resultFile = join(fixture.directory, "shared-result.json");
    await writeFile(inputFile, JSON.stringify({ schemaVersion: 1, revision: (await fixture.read()).revision, values: draft,
      credentials: { linear: { token: linearToken } } }));
    await chmod(inputFile, 0o644);
    const run = await fixture.cli("apply", "--scope", "repository", "--input-file", inputFile, "--result-file", resultFile);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("mode 0600");
    expect(await readFile(fixture.config, "utf8")).toBe('remote = "theirs"\n');
  });
});

test("an invalid Bitbucket login is named without echoing it and saves nothing", async () => {
  await withFixture(async fixture => {
    for (const login of [{ email: "not-an-email SECRET", token: bitbucketToken }, { email: bitbucketEmail, token: "has space SECRET" },
      { email: bitbucketEmail, token: "" }]) {
      const { run, record, streams } = await fixture.apply({ schemaVersion: 1, revision: null, values: draft, credentials: { bitbucket: login } });
      expect(run.exitCode).toBe(1);
      expect(record.config).toMatchObject({ result: "invalid", invalidFields: ["credentials.bitbucket is invalid"],
        credentials: { bitbucket: "unchanged" } });
      for (const secret of [login.email, login.token, "SECRET"].filter(Boolean)) expect(streams).not.toContain(secret);
    }
    const extra = await fixture.apply({ schemaVersion: 1, revision: null, values: draft,
      credentials: { bitbucket: { ...bitbucketLogin, username: "SECRET" } } });
    expect(extra.record.diagnostic).toContain("credentials.bitbucket.username is not supported");
    expect(extra.streams).not.toContain(bitbucketToken);
    expect(await exists(fixture.config)).toBe(false);
    expect(await exists(join(fixture.env.XDG_CONFIG_HOME, "timber"))).toBe(false);
  });
});

test("a Bitbucket draft is hidden from diagnostics, and an unreadable or absent store is reported without values", async () => {
  await withFixture(async fixture => {
    const secrets = knownSecrets({}, { schemaVersion: 1, values: {}, credentials: { bitbucket: bitbucketLogin } });
    expect(secrets).toEqual(expect.arrayContaining([bitbucketToken, bitbucketEmail]));
    expect(safeAppDiagnostic(new Error(`failed for ${bitbucketEmail}:${bitbucketToken}`), secrets, "fallback"))
      .toBe("failed for [hidden]:[hidden]");
    // Removing a login that was never saved changes nothing.
    const none = await fixture.apply({ schemaVersion: 1, revision: null, values: {}, credentials: { bitbucket: null } });
    expect(none.record.config).toMatchObject({ result: "saved", credentials: { bitbucket: "unchanged" } });
    const store = join(fixture.env.XDG_CONFIG_HOME, "timber/credentials");
    expect(await exists(join(store, "bitbucket.json"))).toBe(false);
    await mkdir(store, { recursive: true, mode: 0o700 });
    await writeFile(join(store, "bitbucket.json"), `{"version":1,"email":"${bitbucketEmail}"`, { mode: 0o600 });
    const read = await fixture.cli("read", "--scope", "global");
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout).credentials.bitbucket).toEqual({ state: "unreadable", environmentOverride: false });
    expect(read.stdout + read.stderr).not.toContain(bitbucketEmail);
  });
});

test("a config publish that fails after the credentials published rolls the Bitbucket login back", async () => {
  await withFixture(async fixture => {
    const store = join(fixture.env.XDG_CONFIG_HOME, "timber/credentials/bitbucket.json");
    // A shared rule that unignores the file cannot be overridden by the Git-local exclusion.
    await writeFile(join(fixture.primary, ".gitignore"), "!.timber.toml\n");
    const first = await fixture.apply({ schemaVersion: 1, revision: null, values: draft, credentials: { bitbucket: bitbucketLogin } });
    expect(first.record.config).toMatchObject({ result: "refused", credentials: { bitbucket: "unchanged" } });
    for (const secret of [bitbucketToken, bitbucketEmail]) expect(first.streams).not.toContain(secret);
    expect(await exists(store)).toBe(false);
    expect(await exists(fixture.config)).toBe(false);
    // An existing login survives a replacement and a removal that fail the same way.
    const global = await fixture.apply({ schemaVersion: 1, revision: null, values: {}, credentials: { bitbucket: bitbucketLogin } }, "--scope", "global");
    expect(global.record.config).toMatchObject({ result: "saved", credentials: { bitbucket: "saved" } });
    const before = await readFile(store, "utf8");
    for (const bitbucket of [{ email: "other@example.invalid", token: "ATATT_OTHER" }, null]) {
      const failed = await fixture.apply({ schemaVersion: 1, revision: null, values: draft, credentials: { bitbucket } });
      expect(failed.record.config.result).toBe("refused");
      expect(await readFile(store, "utf8")).toBe(before);
    }
    expect(await exists(fixture.config)).toBe(false);
  });
});

test("a tracked repository file is refused until the caller answers with --edit-tracked", async () => {
  await withFixture(async fixture => {
    await writeFile(fixture.config, 'remote = "origin"\n');
    await git(fixture.primary, "add", "-f", ".timber.toml");
    await git(fixture.primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "track config");
    const head = await git(fixture.primary, "rev-parse", "HEAD");
    const read = await fixture.read();
    expect(read.tracked).toBe(true);
    const refused = await fixture.apply({ schemaVersion: 1, revision: read.revision, values: draft });
    expect(refused.run.exitCode).toBe(1);
    expect(refused.record).toMatchObject({ outcome: "failed", config: { result: "refused" } });
    expect(refused.record.diagnostic).toContain("--edit-tracked");
    expect(await readFile(fixture.config, "utf8")).toBe('remote = "origin"\n');
    const edited = await fixture.apply({ schemaVersion: 1, revision: read.revision, values: draft }, "--edit-tracked");
    expect(edited.record.config.result).toBe("saved");
    // The working file changed; the index and refs did not.
    expect(await git(fixture.primary, "status", "--porcelain")).toBe(" M .timber.toml");
    expect(await git(fixture.primary, "rev-parse", "HEAD")).toBe(head);
  });
});

test("apply runs no hook, launches no tool, and leaves refs and worktrees alone", async () => {
  await withFixture(async fixture => {
    const marker = join(fixture.directory, "ran");
    const refs = await git(fixture.primary, "for-each-ref");
    const { record } = await fixture.apply({ schemaVersion: 1, revision: null, values: {
      hooks: { post_create: [`touch '${marker}'`], pre_delete: [`touch '${marker}'`] },
      editor: { command: "touch", args: [marker], enabled: true }, agent: { command: "touch", args: [marker], enabled: true } } });
    expect(record.config.result).toBe("saved");
    expect(await exists(marker)).toBe(false);
    expect(await git(fixture.primary, "for-each-ref")).toBe(refs);
    expect((await git(fixture.primary, "worktree", "list", "--porcelain")).match(/^worktree /gmu)).toHaveLength(1);
  });
});

test("an existing result file is never reused", async () => {
  await withFixture(async fixture => {
    const inputFile = join(fixture.directory, "draft.json"), resultFile = join(fixture.directory, "taken.json");
    await writeFile(inputFile, JSON.stringify({ schemaVersion: 1, revision: null, values: draft }));
    await writeFile(resultFile, "keep me");
    const run = await fixture.cli("apply", "--scope", "repository", "--input-file", inputFile, "--result-file", resultFile);
    expect(run.exitCode).toBe(1);
    expect(await readFile(resultFile, "utf8")).toBe("keep me");
    expect(await exists(fixture.config)).toBe(false);
  });
});

// Connection checks: the network is replaced at the fetch seam, everything else is real.
interface Call { url: string; authorization: string }
function runtime(env: Record<string, string>, respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  return { calls, runtime: { env, timeoutMs: 2_000, fetch: async (url: string, init: RequestInit) => {
    calls.push({ url, authorization: new Headers(init.headers).get("authorization") ?? "" });
    return respond(url);
  } } };
}
const ok = (body: unknown, code = 200) => () => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const status = (code: number) => () => new Response(`denied ${jiraToken} ${linearToken} ${bitbucketToken}`, { status: code });
const input = (values: Record<string, unknown>, credentials?: AppConfigInput["credentials"]): AppConfigInput =>
  ({ schemaVersion: 1, values, ...(credentials === undefined ? {} : { credentials }) });

test("check uses draft credentials for Jira and Linear and saves nothing", async () => {
  await withFixture(async fixture => {
    const env = { XDG_CONFIG_HOME: fixture.env.XDG_CONFIG_HOME };
    const jira = runtime(env, ok({ accountId: "abc" }));
    expect(await checkAppIntegration("jira", fixture.primary, "repository",
      input(draft, { jira: { email: jiraEmail, token: jiraToken } }), jira.runtime))
      .toEqual({ schemaVersion: 1, integration: "jira", ok: true, source: "draft", account: null, diagnostic: null });
    expect(jira.calls).toEqual([{ url: "https://example.atlassian.net/rest/api/3/myself",
      authorization: `Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString("base64")}` }]);
    const linear = runtime(env, ok({ data: { viewer: { id: "user" } } }));
    expect(await checkAppIntegration("linear", fixture.primary, undefined, input({}, { linear: { token: linearToken } }), linear.runtime))
      .toMatchObject({ ok: true, source: "draft", diagnostic: null });
    expect(linear.calls).toEqual([{ url: "https://api.linear.app/graphql", authorization: linearToken }]);
    expect(await exists(fixture.config)).toBe(false);
    expect(await exists(join(fixture.env.XDG_CONFIG_HOME, "timber"))).toBe(false);
  });
});

test("check without a draft uses saved credentials, and the environment when it overrides them", async () => {
  await withFixture(async fixture => {
    await fixture.apply({ schemaVersion: 1, revision: null, values: draft,
      credentials: { jira: { email: jiraEmail, token: jiraToken }, linear: { token: linearToken } } });
    const env = { XDG_CONFIG_HOME: fixture.env.XDG_CONFIG_HOME };
    const jira = runtime(env, ok({ accountId: "abc" }));
    expect(await checkAppIntegration("jira", fixture.primary, undefined, undefined, jira.runtime)).toMatchObject({ ok: true, source: "saved" });
    expect(jira.calls[0]!.authorization).toBe(`Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString("base64")}`);
    const linear = runtime(env, ok({ data: { viewer: { id: "user" } } }));
    expect(await checkAppIntegration("linear", fixture.primary, undefined, undefined, linear.runtime)).toMatchObject({ ok: true, source: "saved" });
    expect(linear.calls[0]!.authorization).toBe(linearToken);
    const override = runtime({ ...env, LINEAR_API_KEY: "lin_api_ENVIRONMENT" }, ok({ data: { viewer: { id: "user" } } }));
    expect(await checkAppIntegration("linear", fixture.primary, undefined, undefined, override.runtime)).toMatchObject({ ok: true, source: "environment" });
    expect(override.calls[0]!.authorization).toBe("lin_api_ENVIRONMENT");
    // A draft that only changes the site still checks the saved pair for that site's identity.
    const other = runtime(env, ok({ accountId: "abc" }));
    expect(await checkAppIntegration("jira", fixture.primary, "repository",
      input({ jira: { site_url: "https://other.atlassian.net" } }), other.runtime)).toMatchObject({ ok: false, source: "saved" });
    expect(other.calls).toEqual([]);
    const github = runtime({ ...env, GH_TOKEN: "ghp_ENVIRONMENT_TOKEN" }, ok({ login: "octo-user" }));
    expect(await checkAppIntegration("github", fixture.primary, undefined, undefined, github.runtime))
      .toEqual({ schemaVersion: 1, integration: "github", ok: true, source: "environment", account: "octo-user", diagnostic: null });
    expect(github.calls).toEqual([{ url: "https://api.github.com/user", authorization: "Bearer ghp_ENVIRONMENT_TOKEN" }]);
  });
});

test("a failed check returns a safe diagnostic for every integration", async () => {
  await withFixture(async fixture => {
    const env = { XDG_CONFIG_HOME: fixture.env.XDG_CONFIG_HOME, GH_TOKEN: "ghp_ENVIRONMENT_TOKEN" };
    const credentials = { jira: { email: jiraEmail, token: jiraToken }, linear: { token: linearToken } };
    const leaky = () => { throw new Error(`socket failed for ${jiraToken} ${linearToken} ghp_ENVIRONMENT_TOKEN`); };
    for (const respond of [status(401), status(403), status(500), leaky, ok({ unexpected: `${jiraToken} ${linearToken}` })]) {
      for (const integration of ["jira", "linear", "github"] as const) {
        const result = await checkAppIntegration(integration, fixture.primary, "repository", input(draft, credentials), runtime(env, respond).runtime);
        expect(result).toMatchObject({ integration, ok: false, account: null });
        expect(result.diagnostic).toBeTruthy();
        for (const secret of [jiraToken, jiraEmail, linearToken, "ghp_ENVIRONMENT_TOKEN"]) expect(JSON.stringify(result)).not.toContain(secret);
      }
    }
    // Problems found before any request are results too.
    const none = runtime({ XDG_CONFIG_HOME: fixture.env.XDG_CONFIG_HOME }, ok({}));
    expect((await checkAppIntegration("jira", fixture.primary, undefined, undefined, none.runtime)).diagnostic).toContain("Jira is not configured");
    expect((await checkAppIntegration("jira", fixture.primary, "repository", input({ jira: false }), none.runtime)).diagnostic).toContain("this draft");
    expect((await checkAppIntegration("jira", fixture.primary, "repository", input({ editor: { command: 7 } }), none.runtime)).diagnostic).toContain("editor.command is invalid");
    expect((await checkAppIntegration("jira", fixture.primary, "repository", input(draft, { jira: null }), none.runtime)).diagnostic).toContain("removes");
    expect((await checkAppIntegration("linear", fixture.primary, undefined, input({}, { linear: { token: "has space" } }), none.runtime)).diagnostic).toContain("credentials.linear is invalid");
    expect((await checkAppIntegration("linear", fixture.primary, undefined, undefined, none.runtime)).diagnostic).toContain("Linear credentials are missing");
    expect(none.calls).toEqual([]);
    expect(await exists(fixture.config)).toBe(false);
  });
});

test("the check command prints one object, exits by result, and keeps a draft's secrets private", async () => {
  await withFixture(async fixture => {
    const inputFile = join(fixture.directory, "check.json");
    await writeFile(inputFile, JSON.stringify({ schemaVersion: 1, values: draft, credentials: { linear: { token: "has space SECRET" } } }), { mode: 0o600 });
    const linear = await fixture.cli("check", "linear", "--input-file", inputFile);
    expect(linear.exitCode).toBe(1);
    expect(JSON.parse(linear.stdout)).toEqual({ schemaVersion: 1, integration: "linear", ok: false, source: null, account: null,
      diagnostic: "Invalid settings draft: credentials.linear is invalid." });
    expect(linear.stdout + linear.stderr).not.toContain("SECRET");
    const jira = await fixture.cli("check", "jira", "--scope", "repository");
    expect(jira.exitCode).toBe(1);
    expect(JSON.parse(jira.stdout)).toMatchObject({ integration: "jira", ok: false });
    await writeFile(inputFile, "{broken");
    const broken = await fixture.cli("check", "jira", "--input-file", inputFile);
    expect(JSON.parse(broken.stdout)).toMatchObject({ ok: false, diagnostic: "The input file is not valid JSON. Nothing was saved." });
    for (const args of [["check"], ["check", "gitlab"], ["check", "jira", "--result-file", join(fixture.directory, "x.json")]]) {
      const run = await fixture.cli(...args);
      expect(run.exitCode).toBe(1);
      expect(run.stdout).toBe("");
    }
    expect(await exists(fixture.config)).toBe(false);
    expect(await exists(join(fixture.env.XDG_CONFIG_HOME, "timber"))).toBe(false);
  });
});

test("check bitbucket sends one read-only request with the draft, saved or environment login", async () => {
  await withFixture(async fixture => {
    const env = { XDG_CONFIG_HOME: fixture.env.XDG_CONFIG_HOME };
    const methods: string[] = [];
    const draftCheck = runtime(env, ok({ account_id: "abc" }));
    const recording = { ...draftCheck.runtime, fetch: async (url: string, init: RequestInit) => {
      methods.push(`${init.method} ${init.redirect}`); return draftCheck.runtime.fetch(url, init);
    } };
    expect(await checkAppIntegration("bitbucket", fixture.primary, undefined, input({}, { bitbucket: bitbucketLogin }), recording))
      .toEqual({ schemaVersion: 1, integration: "bitbucket", ok: true, source: "draft", account: null, diagnostic: null });
    expect(draftCheck.calls).toEqual([{ url: "https://api.bitbucket.org/2.0/user", authorization: bitbucketBasic }]);
    expect(methods).toEqual(["GET error"]);
    // A token with only the pull request scopes cannot read the account; Bitbucket still recognised the login.
    // The body Bitbucket sent for a real API token lacking a scope, with the scope lists shortened.
    const scoped = runtime(env, () => new Response(JSON.stringify({ type: "error", error: {
      message: "Your credentials lack one or more required privilege scopes.",
      detail: { required: ["read:user:bitbucket"], granted: ["read:pullrequest:bitbucket", "write:pullrequest:bitbucket"] } } }),
    { status: 403, headers: { "content-type": "application/json" } }));
    expect(await checkAppIntegration("bitbucket", fixture.primary, undefined, input({}, { bitbucket: bitbucketLogin }), scoped.runtime))
      .toMatchObject({ ok: true, source: "draft", diagnostic: null });
    expect(await exists(join(fixture.env.XDG_CONFIG_HOME, "timber"))).toBe(false);
    // Without a draft: the saved login, unless the environment overrides it, and the draft wins over both.
    await fixture.apply({ schemaVersion: 1, revision: null, values: {}, credentials: { bitbucket: bitbucketLogin } }, "--scope", "global");
    const saved = runtime(env, ok({}));
    expect(await checkAppIntegration("bitbucket", fixture.primary, undefined, undefined, saved.runtime)).toMatchObject({ ok: true, source: "saved" });
    expect(saved.calls[0]!.authorization).toBe(bitbucketBasic);
    const overrideEnv = { ...env, BITBUCKET_EMAIL: "env@example.invalid", BITBUCKET_API_TOKEN: "ATATT_ENVIRONMENT" };
    const override = runtime(overrideEnv, ok({}));
    expect(await checkAppIntegration("bitbucket", fixture.primary, undefined, undefined, override.runtime)).toMatchObject({ ok: true, source: "environment" });
    expect(override.calls[0]!.authorization).toBe(`Basic ${Buffer.from("env@example.invalid:ATATT_ENVIRONMENT").toString("base64")}`);
    const partial = runtime({ ...env, BITBUCKET_API_TOKEN: "ATATT_ENVIRONMENT" }, ok({}));
    const failed = await checkAppIntegration("bitbucket", fixture.primary, undefined, undefined, partial.runtime);
    expect(failed).toMatchObject({ ok: false, source: "environment" });
    expect(failed.diagnostic).toContain("No saved login was used");
    expect(JSON.stringify(failed)).not.toContain("ATATT_ENVIRONMENT");
    expect(partial.calls).toEqual([]);
    const preferred = runtime(overrideEnv, ok({}));
    expect(await checkAppIntegration("bitbucket", fixture.primary, undefined, input({}, { bitbucket: bitbucketLogin }), preferred.runtime))
      .toMatchObject({ ok: true, source: "draft" });
    expect(preferred.calls[0]!.authorization).toBe(bitbucketBasic);
  });
});

test("a failed Bitbucket check returns a fixed diagnostic and no credential", async () => {
  await withFixture(async fixture => {
    const env = { XDG_CONFIG_HOME: fixture.env.XDG_CONFIG_HOME, BITBUCKET_EMAIL: "env@example.invalid", BITBUCKET_API_TOKEN: "ATATT_ENVIRONMENT" };
    const leaky = () => { throw new Error(`socket failed for ${bitbucketToken} ${bitbucketEmail}`); };
    const redirected = () => { const response = new Response("{}", { status: 200 }); Object.defineProperty(response, "redirected", { value: true }); return response; };
    const late = () => new Promise<Response>(() => {});
    for (const [respond, expected] of [[status(401), "did not accept the login"], [status(403), "network device denied"],
      [ok({ type: "error", error: { message: "Forbidden" } }, 403), "network device denied"], [status(429), "rate limited"], [status(500), "retry when Bitbucket"],
      [status(404), "retry when Bitbucket"], [leaky, "network or redirect failure"], [redirected, "retry when Bitbucket"],
      [ok([`${bitbucketToken}`]), "invalid current-user response"], [late, "in time"]] as const) {
      const check = runtime(env, respond);
      const result = await checkAppIntegration("bitbucket", fixture.primary, undefined, input({}, { bitbucket: bitbucketLogin }),
        { ...check.runtime, timeoutMs: 200 });
      expect(result).toMatchObject({ integration: "bitbucket", ok: false, source: "draft", account: null });
      expect(result.diagnostic).toContain(expected);
      for (const secret of [bitbucketToken, bitbucketEmail, "ATATT_ENVIRONMENT", "env@example.invalid"]) expect(JSON.stringify(result)).not.toContain(secret);
      expect(check.calls).toHaveLength(1);
    }
    // Problems found before any request are results too.
    const none = runtime({ XDG_CONFIG_HOME: fixture.env.XDG_CONFIG_HOME }, ok({}));
    expect((await checkAppIntegration("bitbucket", fixture.primary, undefined, input({}, { bitbucket: null }), none.runtime)).diagnostic).toContain("removes");
    const invalid = await checkAppIntegration("bitbucket", fixture.primary, undefined,
      input({}, { bitbucket: { email: bitbucketEmail, token: "has space" } }), none.runtime);
    expect(invalid).toMatchObject({ source: null, diagnostic: "Invalid settings draft: credentials.bitbucket is invalid." });
    expect(JSON.stringify(invalid)).not.toContain(bitbucketEmail);
    expect((await checkAppIntegration("bitbucket", fixture.primary, undefined, undefined, none.runtime)).diagnostic).toContain("Bitbucket login is missing");
    expect(none.calls).toEqual([]);
  });
});

test("the check and read commands handle Bitbucket from the command line", async () => {
  await withFixture(async fixture => {
    const inputFile = join(fixture.directory, "bitbucket.json");
    await writeFile(inputFile, JSON.stringify({ schemaVersion: 1, values: {}, credentials: { bitbucket: { email: bitbucketEmail, token: "has space SECRET" } } }), { mode: 0o600 });
    const run = await fixture.cli("check", "bitbucket", "--input-file", inputFile);
    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({ schemaVersion: 1, integration: "bitbucket", ok: false, source: null, account: null,
      diagnostic: "Invalid settings draft: credentials.bitbucket is invalid." });
    for (const secret of ["SECRET", bitbucketEmail]) expect(run.stdout + run.stderr).not.toContain(secret);
    const usage = await fixture.cli("check", "gitlab");
    expect(usage.stderr).toContain("github, linear, jira, bitbucket");
    // Either variable alone marks the override, and its value is never printed.
    for (const variable of ["BITBUCKET_EMAIL", "BITBUCKET_API_TOKEN"]) {
      const read = await execa(process.execPath, ["--no-env-file", entry, "__app-config", "read", "--scope", "global"],
        { cwd: fixture.primary, reject: false, stdin: "ignore", env: { ...fixture.env, BITBUCKET_EMAIL: undefined, BITBUCKET_API_TOKEN: undefined, [variable]: "ENV_SECRET_VALUE" } });
      expect(read.exitCode).toBe(0);
      expect(JSON.parse(read.stdout).credentials.bitbucket).toEqual({ state: "none", environmentOverride: true });
      expect(read.stdout + read.stderr).not.toContain("ENV_SECRET_VALUE");
    }
  });
});

test("the commands stay out of help", async () => {
  const help = await execa(process.execPath, ["--no-env-file", entry, "--help"], { reject: false, stdin: "ignore", env: { CI: "true" } });
  expect(help.stdout).not.toContain("__app-config");
});
