import { createServiceDouble } from "./helpers/services";
import { writeBaseAssociation } from "../src/git/base-metadata";
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
import { findJiraSuggestions, resolveJiraTicket, type JiraRuntime } from "../src/jira/client";
import type { CommandHandlers } from "../src/services";
import type { RepositoryContext } from "../src/types";
import { git, withRepository } from "./helpers/git";

const jiraSite = "https://example.atlassian.net";
const jiraUrl = `${jiraSite}/browse/ABU-834`;

async function publishRemoteBranches(primary: string, directory: string, names: string[]) {
  const remote = join(directory, "origin.git");
  const producer = join(directory, "producer");
  await git(directory, "clone", "--bare", primary, remote);
  await git(primary, "remote", "add", "origin", remote);
  await git(directory, "clone", remote, producer);
  for (const name of names) {
    await git(producer, "checkout", "-b", name, "trunk");
    await writeFile(join(producer, "remote-work.txt"), `Existing work on ${name}\n`);
    await git(producer, "add", "remote-work.txt");
    await git(producer, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Remote work");
    await git(producer, "push", "origin", name);
  }
  return { remote, producer };
}

test("open discovers an unfetched remote ticket branch and tracks its commits without Jira", async () => {
  await withRepository(async (primary, directory) => {
    await configureJira(primary, ["", "[hooks]", 'post_create = ["touch setup-sentinel.txt"]']);
    const name = "ABU-834-original-title";
    const { producer } = await publishRemoteBranches(primary, directory, [name]);
    const tip = await git(producer, "rev-parse", name);
    expect(await git(primary, "for-each-ref", "refs/remotes")).toBe("");
    await writeFile(join(primary, "tracked.txt"), "dirty primary\n");
    await writeFile(join(primary, ".env"), "ignored primary\n");
    const harness = jiraHarness(() => successfulIssue("Completely changed title"));
    const lifecycle = { setup: 0, editor: 0 };
    const result = await command(primary, handlersFor(harness.runtime, lifecycle), "open", "ABU-834", "--no-editor");
    const target = join(directory, "primary repo-worktrees", name);

    expect(result).toEqual({ code: 0, stdout: `Created worktree at ${target}\n`, stderr: "" });
    expect(await git(target, "rev-parse", "HEAD")).toBe(tip);
    expect(await git(target, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(`refs/remotes/origin/${name}`);
    expect(await readFile(join(target, "remote-work.txt"), "utf8")).toBe(`Existing work on ${name}\n`);
    expect(await git(primary, "for-each-ref", "refs/heads/ABU-834-completely-changed-title")).toBe("");
    expect(await readFile(join(primary, "tracked.txt"), "utf8")).toBe("dirty primary\n");
    expect(await readFile(join(primary, ".env"), "utf8")).toBe("ignored primary\n");
    expect(lifecycle.setup).toBe(1);
    expect(harness.requests).toHaveLength(0);
  });
});

test("open resumes an exact remote branch without Jira or a usable creation base", async () => {
  await withRepository(async (primary, directory) => {
    const name = "feature/existing";
    const { producer } = await publishRemoteBranches(primary, directory, [name]);
    await writeFile(join(primary, ".timber.toml"), 'base_branch = "missing"\n');
    const harness = jiraHarness(() => { throw new Error("Jira must not run"); }, false);
    const result = await command(primary, handlersFor(harness.runtime), "open", name, "--no-editor");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(await git(primary, "rev-parse", name)).toBe(await git(producer, "rev-parse", name));
    expect(harness.requests).toHaveLength(0);
  });
});

test("cancelling multiple live remote matches preserves refs, worktrees and user files without fetching", async () => {
  await withRepository(async (primary, directory) => {
    await configureJira(primary);
    await publishRemoteBranches(primary, directory, ["ABU-834-one", "ABU-834-two"]);
    await writeFile(join(primary, "tracked.txt"), "dirty primary\n");
    await writeFile(join(primary, "untracked.txt"), "untracked primary\n");
    await writeFile(join(primary, ".env"), "ignored primary\n");
    const root = join(directory, "primary repo-worktrees");
    const snapshot = () => gitState(primary, primary, join(primary, "tracked.txt"),
      [join(primary, "untracked.txt"), join(primary, ".env")], [root]);
    const before = await snapshot();
    const harness = jiraHarness(() => successfulIssue("Fresh title"));
    const lifecycle = { setup: 0, editor: 0 };
    const result = await commandWithChooser(primary, handlersFor(harness.runtime, lifecycle), async (_message, choices) => {
      expect(choices).toHaveLength(2);
      expect(choices.map(choice => choice.label).join(" ")).toContain("origin/ABU-834-one");
      return null;
    }, "open", "ABU-834", "--no-editor");
    expect(result).toEqual({ code: 0, stdout: "Cancelled.\n", stderr: "" });
    expect(lifecycle).toEqual({ setup: 0, editor: 0 });
    expect(await snapshot()).toEqual(before);
  });
});

test("failed live remote discovery does not create a replacement branch or alter user files", async () => {
  await withRepository(async (primary, directory) => {
    await configureJira(primary);
    await git(primary, "remote", "add", "origin", join(directory, "unavailable.git"));
    await writeFile(join(primary, "tracked.txt"), "dirty primary\n");
    const root = join(directory, "primary repo-worktrees");
    const snapshot = () => gitState(primary, primary, join(primary, "tracked.txt"), [], [root]);
    const before = await snapshot();
    const harness = jiraHarness(() => successfulIssue("Fresh title"));
    const lifecycle = { setup: 0, editor: 0 };
    const result = await command(primary, handlersFor(harness.runtime, lifecycle), "open", "ABU-834", "--no-editor");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Could not check existing remote branches");
    expect(result.stdout).toBe("");
    expect(lifecycle).toEqual({ setup: 0, editor: 0 });
    expect(await snapshot()).toEqual(before);
  });
});

test.each([false, true])("open revalidates a chosen live remote branch before fetching (deleted: %s)", async deleted => {
  await withRepository(async (primary, directory) => {
    await configureJira(primary);
    const chosen = "ABU-834-two";
    const { producer } = await publishRemoteBranches(primary, directory, ["ABU-834-one", chosen]);
    const harness = jiraHarness(() => successfulIssue("Fresh title"));
    const beforeRefs = await git(primary, "show-ref");
    const beforeTrees = await git(primary, "worktree", "list", "--porcelain");
    const result = await commandWithChooser(primary, handlersFor(harness.runtime), async (_message, choices) => {
      if (deleted) await git(producer, "push", "origin", "--delete", chosen);
      return choices.find(choice => choice.value.endsWith(chosen))!.value;
    }, "open", "ABU-834", "--no-editor");
    if (deleted) {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("no longer uniquely available");
      expect(await git(primary, "show-ref")).toBe(beforeRefs);
      expect(await git(primary, "worktree", "list", "--porcelain")).toBe(beforeTrees);
      expect(await pathExists(join(directory, "primary repo-worktrees"))).toBe(false);
    } else {
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(await git(primary, "rev-parse", chosen)).toBe(await git(producer, "rev-parse", chosen));
      expect(await git(primary, "for-each-ref", "refs/heads/ABU-834-one", "refs/remotes/origin/ABU-834-one")).toBe("");
    }
  });
});

function jiraHarness(response: (url: string, init: RequestInit) => Response, credentials = true) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const runtime: JiraRuntime = {
    env: credentials
      ? { JIRA_EMAIL: "timber-test@example.invalid", JIRA_API_TOKEN: "synthetic-jira-token" }
      : {},
    timeoutMs: 1_000,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return response(url, init);
    },
  };
  return { runtime, requests };
}

function successfulIssue(title: string): Response {
  return Response.json({ key: "ABU-834", fields: {
    summary: title,
    status: { name: "In Progress", statusCategory: { key: "indeterminate", name: "In Progress" } },
  } });
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

function handlersFor(
  runtime: JiraRuntime,
  lifecycle?: { setup: number; editor: number },
): CommandHandlers {
  const shared = {
    discoverRepository,
    loadConfig: loadRepositoryConfig,
    createWorktree, writeBaseAssociation,
    readWorkflowAssociation: async () => ({ kind: "unassigned" } as const),
    writeWorkflowAssociation: async () => {},
    runSetup: async (...args: Parameters<typeof runSetup>) => {
      if (lifecycle) lifecycle.setup += 1;
      return runSetup(...args);
    },
    launchEditor: async (...args: Parameters<typeof launchEditor>) => {
      if (lifecycle) lifecycle.editor += 1;
      return launchEditor(...args);
    },
    launchAgent: async () => ({ kind: "skipped" } as const),
  };
  return {
    ...placeholderHandlers,
    new: createNewHandler({ ...createServiceDouble(),
      ...shared,
      resolveBase,
      resolveJiraTicket: (config, key) => resolveJiraTicket(config, key, runtime),
      findJiraSuggestions: (config, key) => findJiraSuggestions(config, key, runtime),
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
  return commandWithChooser(cwd, handlers, undefined, ...args);
}

async function commandWithChooser(
  cwd: string,
  handlers: CommandHandlers,
  choose: ((message: string, choices: readonly { value: string; label: string }[]) => Promise<string | null>) | undefined,
  ...args: string[]
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
      ...(choose === undefined ? {} : { choose }),
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
      key: "XYZ-91", fields: {
        summary: "Fix café / login!",
        status: { name: "In Progress", statusCategory: { key: "indeterminate", name: "In Progress" } },
      },
    }));
    const result = await command(nested, handlersFor(harness.runtime), "new", "ABU-834", "--no-editor");
    const target = join(directory, "primary repo-worktrees", "XYZ-91-fix-cafe-login");
    const canonicalUrl = `${jiraSite}/browse/XYZ-91`;

    expect(result).toEqual({
      code: 0,
      stdout: `Created XYZ-91-fix-cafe-login at ${target}\nJira: ${canonicalUrl}\nXYZ-91 - Fix café / login!\n`,
      stderr: "",
    });
    expect(harness.requests).toHaveLength(1);
    expect(new URL(harness.requests[0]!.url).pathname).toBe("/rest/api/3/issue/ABU-834");
    expect(new URL(harness.requests[0]!.url).searchParams.get("fields")).toBe("summary,status");
    expect(await git(primary, "rev-parse", "refs/heads/XYZ-91-fix-cafe-login")).toBe(base);
    expect(await git(target, "rev-parse", "HEAD")).toBe(base);
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await readFile(join(target, "task-id.txt"), "utf8")).toBe("XYZ-91\n");
  });
});

test("each Jira lookup failure preserves dirty, untracked, ignored, ref, worktree, and destination state", async () => {
  await withRepository(async (primary, directory) => {
    await configureJira(primary, ["", "[hooks]", 'post_create = ["touch hook-sentinel.txt"]']);
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
        harness: jiraHarness(url => url.includes("/search/jql")
          ? Response.json({ issues: [], isLast: true })
          : Response.json({ syntheticBodyMarker: "must stay hidden" }, { status: 404 })),
        message: "unavailable or not visible (404)",
        requests: 2,
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
      {
        name: "completed issue with a custom status name",
        harness: jiraHarness(url => url.includes("/search/jql")
          ? Response.json({ issues: [], isLast: true })
          : Response.json({
            key: "XYZ-91",
            fields: {
              summary: "PRIVATE_SUMMARY_MARKER",
              status: { name: "Clôturé", statusCategory: { key: "done", name: "Done" } },
            },
          })),
        message: "Jira issue XYZ-91 is complete",
        requests: 2,
      },
      {
        name: "missing status category",
        harness: jiraHarness(() => Response.json({
          key: "XYZ-92", fields: { summary: "Fix login" },
        })),
        message: "Jira issue XYZ-92 has an unknown status category",
        requests: 1,
      },
      {
        name: "unknown status category even when display name says Done",
        harness: jiraHarness(() => Response.json({
          key: "XYZ-93",
          fields: { summary: "Fix login", status: { name: "Done", statusCategory: { key: "custom", name: "Done" } } },
        })),
        message: "Jira issue XYZ-93 has an unknown status category",
        requests: 1,
      },
    ];

    for (const failure of failures) {
      const lifecycle = { setup: 0, editor: 0 };
      const result = await command(primary, handlersFor(failure.harness.runtime, lifecycle), "new", "ABU-834", "--no-editor");

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(failure.message);
      expect(result.stderr).not.toContain("syntheticBodyMarker");
      expect(result.stderr).not.toContain("synthetic-jira-token");
      expect(result.stderr).not.toContain("synthetic network marker");
      expect(result.stderr).not.toContain("PRIVATE_SUMMARY_MARKER");
      expect(lifecycle).toEqual({ setup: 0, editor: 0 });
      expect(await gitState(
        primary, primary, join(primary, "tracked.txt"),
        [join(primary, "untracked-sentinel.txt"), join(primary, ".env")], [root, target],
      )).toEqual(before);
      expect(failure.harness.requests).toHaveLength(failure.requests);
    }
  });
});

test("declining a Jira prefix suggestion preserves the real repository and all user files", async () => {
  await withRepository(async (primary, directory) => {
    await configureJira(primary, ["", "[hooks]", 'post_create = ["touch hook-sentinel.txt"]']);
    await writeFile(join(primary, "tracked.txt"), "dirty tracked sentinel\n");
    await writeFile(join(primary, "untracked-sentinel.txt"), "keep untracked\n");
    await writeFile(join(primary, ".env"), "keep ignored\n");
    const root = join(directory, "primary repo-worktrees");
    const target = join(root, "ABU-40-candidate-title");
    const before = await gitState(
      primary, primary, join(primary, "tracked.txt"),
      [join(primary, "untracked-sentinel.txt"), join(primary, ".env")], [root, target],
    );
    const harness = jiraHarness(url => url.includes("/search/jql")
      ? Response.json({ issues: [{
        key: "ABU-40",
        fields: {
          summary: "Candidate title",
          status: { statusCategory: { key: "indeterminate" } },
        },
      }], isLast: true })
      : new Response(null, { status: 404 }));
    let chooserCalls = 0;
    const lifecycle = { setup: 0, editor: 0 };
    const result = await commandWithChooser(
      primary,
      handlersFor(harness.runtime, lifecycle),
      async (_message, choices) => {
        chooserCalls += 1;
        expect(choices).toEqual([{ value: "ABU-40", label: "ABU-40 - Candidate title" }]);
        return null;
      },
      "new", "ABU-4", "--no-editor",
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Cancelled.\n");
    expect(result.stderr).toBe("");
    expect(chooserCalls).toBe(1);
    expect(harness.requests).toHaveLength(2);
    expect(lifecycle).toEqual({ setup: 0, editor: 0 });
    expect(await gitState(
      primary, primary, join(primary, "tracked.txt"),
      [join(primary, "untracked-sentinel.txt"), join(primary, ".env")], [root, target],
    )).toEqual(before);
  });
});

test("revalidates a chosen Jira suggestion and preserves Git state if it becomes Done", async () => {
  await withRepository(async (primary, directory) => {
    await configureJira(primary, ["", "[hooks]", 'post_create = ["touch hook-sentinel.txt"]']);
    await writeFile(join(primary, "tracked.txt"), "dirty tracked sentinel\n");
    await writeFile(join(primary, "untracked-sentinel.txt"), "keep untracked\n");
    await writeFile(join(primary, ".env"), "keep ignored\n");
    const root = join(directory, "primary repo-worktrees");
    const target = join(root, "ABU-40-candidate-title");
    const before = await gitState(
      primary, primary, join(primary, "tracked.txt"),
      [join(primary, "untracked-sentinel.txt"), join(primary, ".env")], [root, target],
    );
    const harness = jiraHarness(url => {
      const request = new URL(url);
      if (request.pathname.endsWith("/search/jql")) {
        return Response.json({ issues: [{
          key: "ABU-40",
          fields: {
            summary: "Candidate title",
            status: { statusCategory: { key: "new" } },
          },
        }], isLast: true });
      }
      if (request.pathname.endsWith("/issue/ABU-4")) return new Response(null, { status: 404 });
      return Response.json({ key: "ABU-40", fields: {
        summary: "PRIVATE_SUMMARY_MARKER",
        status: { name: "Clôturé", statusCategory: { key: "done", name: "Done" } },
      } });
    });
    let chooserCalls = 0;
    const lifecycle = { setup: 0, editor: 0 };
    const result = await commandWithChooser(
      primary,
      handlersFor(harness.runtime, lifecycle),
      async (_message, choices) => {
        chooserCalls += 1;
        expect(choices).toHaveLength(1);
        return "ABU-40";
      },
      "new", "ABU-4", "--no-editor",
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Jira issue ABU-40 is complete");
    expect(result.stderr).not.toContain("PRIVATE_SUMMARY_MARKER");
    expect(result.stderr).not.toContain("Clôturé");
    expect(chooserCalls).toBe(1);
    expect(harness.requests).toHaveLength(3);
    expect(new URL(harness.requests[2]!.url).pathname).toBe("/rest/api/3/issue/ABU-40");
    expect(lifecycle).toEqual({ setup: 0, editor: 0 });
    expect(await gitState(
      primary, primary, join(primary, "tracked.txt"),
      [join(primary, "untracked-sentinel.txt"), join(primary, ".env")], [root, target],
    )).toEqual(before);
  });
});

test("creates from a single Jira suggestion only after explicit selection and exact revalidation", async () => {
  await withRepository(async (primary, directory) => {
    await configureJira(primary);
    const base = await git(primary, "rev-parse", "trunk");
    const harness = jiraHarness(url => {
      const request = new URL(url);
      if (request.pathname.endsWith("/search/jql")) {
        return Response.json({ issues: [{
          key: "ABU-40",
          fields: {
            summary: "Stale search title",
            status: { statusCategory: { key: "indeterminate" } },
          },
        }], isLast: true });
      }
      if (request.pathname.endsWith("/issue/ABU-4")) return new Response(null, { status: 404 });
      return Response.json({
        key: "ABU-40",
        fields: {
          summary: "Fresh title",
          status: { name: "In Progress", statusCategory: { key: "new", name: "To Do" } },
        },
      });
    });
    const target = join(directory, "primary repo-worktrees", "ABU-40-fresh-title");
    let chooserCalls = 0;
    const result = await commandWithChooser(
      primary,
      handlersFor(harness.runtime),
      async (message, choices) => {
        chooserCalls += 1;
        expect(message).toMatch(/unavailable or not visible[\s\S]*Did you mean/i);
        expect(choices).toEqual([{ value: "ABU-40", label: "ABU-40 - Stale search title" }]);
        return "ABU-40";
      },
      "new", "ABU-4", "--no-editor",
    );

    expect(result).toEqual({
      code: 0,
      stdout: `Created ABU-40-fresh-title at ${target}\nJira: ${jiraSite}/browse/ABU-40\nABU-40 - Fresh title\n`,
      stderr: "",
    });
    expect(chooserCalls).toBe(1);
    expect(harness.requests).toHaveLength(3);
    expect(new URL(harness.requests[0]!.url).pathname).toBe("/rest/api/3/issue/ABU-4");
    const search = new URL(harness.requests[1]!.url);
    expect(search.pathname).toBe("/rest/api/3/search/jql");
    expect(search.searchParams.get("jql")).toBe('project = "ABU" AND statusCategory != Done ORDER BY key ASC');
    expect(new URL(harness.requests[2]!.url).pathname).toBe("/rest/api/3/issue/ABU-40");
    expect(await git(primary, "rev-parse", "refs/heads/ABU-40-fresh-title")).toBe(base);
    expect(await git(target, "rev-parse", "HEAD")).toBe(base);
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
    expect(first.stdout).toBe(`Created ABU-834-fix-cafe-login at ${firstTarget}\nJira: ${jiraUrl}\nABU-834 - Fix café / login!\n`);

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
    expect(changed.stdout).toBe(`Created ABU-834-fix-recovery-flow at ${changedTarget}\nJira: ${jiraUrl}\nABU-834 - Fix recovery flow\n`);
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
    expect(result.stdout).toBe(`Created ABU-834-fails-in-setup at ${target}\nJira: ${jiraUrl}\nABU-834 - Fails in setup\n`);
    expect(result.stderr).toContain("Setup post_create step 2 failed");
    expect(await git(primary, "rev-parse", "refs/heads/ABU-834-fails-in-setup")).toBe(await git(primary, "rev-parse", "trunk"));
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await readFile(join(target, "setup-sentinel.txt"), "utf8")).toBe("");
  });
});

test("editor startup failure after Jira creation retains its worktree", async () => {
  await withRepository(async (primary, directory) => {
    const missingEditor = join(directory, "missing timber editor");
    await configureJira(primary, ["", "[editor]", `command = ${JSON.stringify(missingEditor)}`, "enabled = true"]);
    const harness = jiraHarness(() => successfulIssue("Fails in editor"));
    const result = await command(primary, handlersFor(harness.runtime), "new", "ABU-834");
    const target = join(directory, "primary repo-worktrees", "ABU-834-fails-in-editor");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`Created ABU-834-fails-in-editor at ${target}\nJira: ${jiraUrl}\nABU-834 - Fails in editor\n`);
    expect(result.stderr).toContain("Could not start the configured editor");
    expect(result.stderr).toContain("timber open --");
    expect(await git(primary, "rev-parse", "refs/heads/ABU-834-fails-in-editor")).toBe(await git(primary, "rev-parse", "trunk"));
    expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("original\n");
  });
});
