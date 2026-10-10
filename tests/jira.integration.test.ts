import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNewHandler } from "../src/commands/new";
import { createOpenHandler } from "../src/commands/open";
import { placeholderHandlers, runCli } from "../src/cli";
import { loadRepositoryConfig } from "../src/config";
import { launchEditor } from "../src/editor";
import { resolveBase } from "../src/git/branches";
import { createWorktree } from "../src/git/create-worktree";
import { resolveOpenTarget } from "../src/git/open-target";
import { discoverRepository } from "../src/git/repository";
import { runSetup } from "../src/hooks";
import { resolveJiraTicket, type JiraRuntime } from "../src/jira/client";
import type { CommandHandlers } from "../src/services";
import type { RepositoryContext } from "../src/types";
import { git, withRepository } from "./helpers/git";

const jiraSite = "https://example.atlassian.net";
const jiraUrl = `${jiraSite}/browse/ABU-834`;

function jiraHarness(response: () => Response, credentials = true) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const runtime: JiraRuntime = {
    env: credentials
      ? { JIRA_EMAIL: "timber-test@example.invalid", JIRA_API_TOKEN: "synthetic-jira-token" }
      : {},
    timeoutMs: 1_000,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return response();
    },
  };
  return { runtime, requests };
}

function successfulIssue(title: string): Response {
  return Response.json({ key: "ABU-834", fields: { summary: title } });
}

function timeoutHarness() {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const runtime: JiraRuntime = {
    env: { JIRA_EMAIL: "timber-test@example.invalid", JIRA_API_TOKEN: "synthetic-jira-token" },
    timeoutMs: 10,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return await new Promise<Response>((_resolve, reject) => {
        if (!init.signal) {
          reject(new Error("Jira client did not pass an abort signal."));
          return;
        }
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("synthetic timeout marker", "AbortError"));
        }, { once: true });
      });
    },
  };
  return { runtime, requests };
}

function handlersFor(runtime: JiraRuntime): CommandHandlers {
  const shared = {
    discoverRepository,
    loadConfig: loadRepositoryConfig,
    createWorktree,
    runSetup,
    launchEditor,
  };
  return {
    ...placeholderHandlers,
    new: createNewHandler({
      ...shared,
      resolveBase,
      resolveJiraTicket: (config, key) => resolveJiraTicket(config, key, runtime),
    }),
    open: createOpenHandler({
      ...shared,
      resolveOpenTarget,
    }),
  };
}

async function command(
  cwd: string, handlers: CommandHandlers, ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    handlers,
    context: {
      cwd,
      io: {
        stdout: text => { stdout += text; },
        stderr: text => { stderr += text; },
      },
    },
  });
  return { code, stdout, stderr };
}

async function configureJira(primary: string, extras: readonly string[] = []): Promise<void> {
  const source = [
    'base_branch = "trunk"',
    "",
    "[jira]",
    `site_url = "${jiraSite}"`,
    ...extras,
    "",
  ].join("\n");
  await writeFile(join(primary, ".timber.toml"), source);
  await git(primary, "add", ".timber.toml");
  await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "Configure Jira for Timber");
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function textOrNull(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function gitState(
  primary: string,
  statusCwd: string,
  trackedFile: string,
  otherFiles: readonly string[],
  paths: readonly string[],
) {
  return {
    refs: await git(primary, "show-ref"),
    worktrees: await git(primary, "worktree", "list", "--porcelain", "-z"),
    status: await git(statusCwd, "status", "--porcelain", "--ignored", "-z"),
    tracked: await readFile(trackedFile, "utf8"),
    otherFiles: await Promise.all(otherFiles.map(textOrNull)),
    paths: await Promise.all(paths.map(pathExists)),
  };
}

test("new resolves a moved Jira issue from nested linked worktree using canonical key and hook task ID", async () => {
  await withRepository(async (primary, directory) => {
    const hook = 'printf "%s\\n" "$TIMBER_TASK_ID" > task-id.txt';
    await configureJira(primary, ["", "[hooks]", `post_create = [${JSON.stringify(hook)}]`]);
    const base = await git(primary, "rev-parse", "trunk");
    const linked = join(directory, "linked checkout");
    await git(primary, "worktree", "add", "-b", "context", linked, "trunk");
    await writeFile(join(linked, ".timber.toml"), "invalid [ TOML\n");
    const nested = join(linked, "nested", "deep");
    await mkdir(nested, { recursive: true });

    const harness = jiraHarness(() => Response.json({
      key: "XYZ-91", fields: { summary: "Fix café / login!" },
    }));
    const result = await command(nested, handlersFor(harness.runtime), "new", "ABU-834", "--no-editor");
    const target = join(directory, "primary repo-worktrees", "XYZ-91-fix-cafe-login");
    const canonicalUrl = `${jiraSite}/browse/XYZ-91`;

    expect(result).toEqual({
      code: 0,
      stdout: `Created XYZ-91-fix-cafe-login at ${target}\nJira: ${canonicalUrl}\n`,
      stderr: "",
    });
    expect(harness.requests).toHaveLength(1);
    expect(new URL(harness.requests[0]!.url).pathname).toBe("/rest/api/3/issue/ABU-834");
    expect(await git(primary, "rev-parse", "refs/heads/XYZ-91-fix-cafe-login")).toBe(base);
    expect(await git(target, "rev-parse", "HEAD")).toBe(base);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await readFile(join(target, "task-id.txt"), "utf8")).toBe("XYZ-91\n");
  });
});

test("each Jira lookup failure preserves dirty, untracked, ignored, ref, worktree, and destination state", async () => {
  await withRepository(async (primary, directory) => {
    await configureJira(primary);
    await writeFile(join(primary, "tracked.txt"), "dirty tracked sentinel\n");
    await writeFile(join(primary, "untracked-sentinel.txt"), "keep untracked\n");
    await writeFile(join(primary, ".env"), "keep ignored\n");
    const root = join(directory, "primary repo-worktrees");
    const target = join(root, "ABU-834-fix-login");
    const before = await gitState(
      primary, primary, join(primary, "tracked.txt"),
      [join(primary, "untracked-sentinel.txt"), join(primary, ".env")], [root, target],
    );
    const failures = [
      {
        name: "missing credentials",
        harness: jiraHarness(() => { throw new Error("fetch must not run without credentials"); }, false),
        message: "JIRA_EMAIL",
        requests: 0,
      },
      {
        name: "401 authentication rejection",
        harness: jiraHarness(() => Response.json({ syntheticBodyMarker: "must stay hidden" }, { status: 401 })),
        message: "authentication rejected (401)",
        requests: 1,
      },
      {
        name: "403 access denial",
        harness: jiraHarness(() => Response.json({ syntheticBodyMarker: "must stay hidden" }, { status: 403 })),
        message: "access denied (403)",
        requests: 1,
      },
      {
        name: "404 unavailable issue",
        harness: jiraHarness(() => Response.json({ syntheticBodyMarker: "must stay hidden" }, { status: 404 })),
        message: "unavailable or not visible (404)",
        requests: 1,
      },
      {
        name: "429 rate limit",
        harness: jiraHarness(() => Response.json({ syntheticBodyMarker: "must stay hidden" }, { status: 429 })),
        message: "rate limited (429)",
        requests: 1,
      },
      {
        name: "500 server failure",
        harness: jiraHarness(() => Response.json({ syntheticBodyMarker: "must stay hidden" }, { status: 500 })),
        message: "unavailable (500)",
        requests: 1,
      },
      {
        name: "network failure",
        harness: jiraHarness(() => { throw new Error("synthetic network marker"); }),
        message: "network or redirect error",
        requests: 1,
      },
      {
        name: "timeout",
        harness: timeoutHarness(),
        message: "timed out after 10 ms",
        requests: 1,
      },
    ];

    for (const failure of failures) {
      const result = await command(primary, handlersFor(failure.harness.runtime), "new", "ABU-834", "--no-editor");

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(failure.message);
      expect(result.stderr).not.toContain("syntheticBodyMarker");
      expect(result.stderr).not.toContain("synthetic-jira-token");
      expect(result.stderr).not.toContain("synthetic network marker");
      expect(await gitState(
        primary, primary, join(primary, "tracked.txt"),
        [join(primary, "untracked-sentinel.txt"), join(primary, ".env")], [root, target],
      )).toEqual(before);
      expect(failure.harness.requests).toHaveLength(failure.requests);
    }
  });
});

test("ordinary slash branch worktree blocks a colliding Jira destination without changing its files or refs", async () => {
  await withRepository(async (primary, directory) => {
    await configureJira(primary);
    const repository: RepositoryContext = await discoverRepository(primary);
    const config = await loadRepositoryConfig(repository);
    const base = await resolveBase(repository, config);
    const ordinary = await createWorktree(repository, {
      kind: "new", branch: "ABU/834-fix-login", base,
    }, config);
    const target = join(directory, "primary repo-worktrees", "ABU-834-fix-login");
    expect(ordinary.path).toBe(target);
    await writeFile(join(target, "tracked.txt"), "keep dirty collision content\n");
    await writeFile(join(target, "collision-untracked.txt"), "keep untracked collision\n");
    await writeFile(join(target, ".env"), "keep ignored collision\n");
    const before = await gitState(
      primary, target, join(target, "tracked.txt"),
      [join(target, "collision-untracked.txt"), join(target, ".env")], [target],
    );
    const harness = jiraHarness(() => successfulIssue("Fix login"));

    const result = await command(primary, handlersFor(harness.runtime), "new", "ABU-834", "--no-editor");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Worktree path already exists");
    expect(await gitState(
      primary, target, join(target, "tracked.txt"),
      [join(target, "collision-untracked.txt"), join(target, ".env")], [target],
    )).toEqual(before);
    expect(await git(primary, "show-ref")).toContain("refs/heads/ABU/834-fix-login");
  });
});

test("duplicate and changed Jira titles behave deterministically; ticket open remains offline", async () => {
  await withRepository(async (primary, directory) => {
    await configureJira(primary);
    let summary = "Fix café / login!";
    const harness = jiraHarness(() => successfulIssue(summary));
    const onlineHandlers = handlersFor(harness.runtime);
    const first = await command(primary, onlineHandlers, "new", "ABU-834", "--no-editor");
    const firstTarget = join(directory, "primary repo-worktrees", "ABU-834-fix-cafe-login");
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(`Created ABU-834-fix-cafe-login at ${firstTarget}\nJira: ${jiraUrl}\n`);

    const beforeDuplicate = await gitState(
      primary, firstTarget, join(firstTarget, "tracked.txt"), [], [firstTarget],
    );
    const duplicate = await command(primary, onlineHandlers, "new", "ABU-834", "--no-editor");
    expect(duplicate.code).toBe(1);
    expect(duplicate.stdout).toBe("");
    expect(duplicate.stderr).toContain("Branch ABU-834-fix-cafe-login is already checked out");
    expect(await gitState(
      primary, firstTarget, join(firstTarget, "tracked.txt"), [], [firstTarget],
    )).toEqual(beforeDuplicate);

    const fetchesBeforeOpen = harness.requests.length;
    const offlineRuntime = jiraHarness(() => { throw new Error("offline Jira lookup must not run"); }, false);
    const opened = await command(primary, handlersFor(offlineRuntime.runtime), "open", "ABU-834", "--no-editor");
    expect(opened).toEqual({ code: 0, stdout: `Opened existing worktree at ${firstTarget}\n`, stderr: "" });
    expect(harness.requests).toHaveLength(fetchesBeforeOpen);
    expect(offlineRuntime.requests).toHaveLength(0);

    summary = "Fix recovery flow";
    const changed = await command(primary, onlineHandlers, "new", "ABU-834", "--no-editor");
    const changedTarget = join(directory, "primary repo-worktrees", "ABU-834-fix-recovery-flow");
    expect(changed.code).toBe(0);
    expect(changed.stdout).toBe(`Created ABU-834-fix-recovery-flow at ${changedTarget}\nJira: ${jiraUrl}\n`);
    expect(await git(primary, "rev-parse", "refs/heads/ABU-834-fix-recovery-flow")).toBe(await git(primary, "rev-parse", "trunk"));

    const ambiguousRuntime = jiraHarness(() => { throw new Error("offline Jira lookup must not run"); }, false);
    const offlineHandlers = handlersFor(ambiguousRuntime.runtime);
    const firstAmbiguous = await command(primary, offlineHandlers, "open", "ABU-834", "--no-editor");
    const secondAmbiguous = await command(primary, offlineHandlers, "open", "ABU-834", "--no-editor");
    expect(firstAmbiguous.code).toBe(1);
    expect(firstAmbiguous.stderr).toEqual(secondAmbiguous.stderr);
    expect(firstAmbiguous.stderr).toContain("ABU-834-fix-cafe-login");
    expect(firstAmbiguous.stderr).toContain("ABU-834-fix-recovery-flow");
    expect(ambiguousRuntime.requests).toHaveLength(0);
  });
});

test("setup failure after Jira creation retains its worktree and hook files", async () => {
  await withRepository(async (primary, directory) => {
    await configureJira(primary, ["", "[hooks]", 'post_create = ["touch setup-sentinel.txt", "false"]']);
    const harness = jiraHarness(() => successfulIssue("Fails in setup"));
    const result = await command(primary, handlersFor(harness.runtime), "new", "ABU-834");
    const target = join(directory, "primary repo-worktrees", "ABU-834-fails-in-setup");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`Created ABU-834-fails-in-setup at ${target}\nJira: ${jiraUrl}\n`);
    expect(result.stderr).toContain("Setup post_create step 2 failed");
    expect(await git(primary, "rev-parse", "refs/heads/ABU-834-fails-in-setup")).toBe(await git(primary, "rev-parse", "trunk"));
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await readFile(join(target, "setup-sentinel.txt"), "utf8")).toBe("");
  });
});

test("editor startup failure after Jira creation retains its worktree", async () => {
  await withRepository(async (primary, directory) => {
    const missingEditor = join(directory, "missing timber editor");
    await configureJira(primary, ["", "[editor]", `command = ${JSON.stringify(missingEditor)}`]);
    const harness = jiraHarness(() => successfulIssue("Fails in editor"));
    const result = await command(primary, handlersFor(harness.runtime), "new", "ABU-834");
    const target = join(directory, "primary repo-worktrees", "ABU-834-fails-in-editor");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`Created ABU-834-fails-in-editor at ${target}\nJira: ${jiraUrl}\n`);
    expect(result.stderr).toContain("Could not start the configured editor");
    expect(result.stderr).toContain("timber open --");
    expect(await git(primary, "rev-parse", "refs/heads/ABU-834-fails-in-editor")).toBe(await git(primary, "rev-parse", "trunk"));
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
  });
});
