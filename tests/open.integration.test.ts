import { expect, test } from "bun:test";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { createOpenHandler } from "../src/commands/open";
import { loadRepositoryConfig } from "../src/config";
import { launchEditor } from "../src/editor";
import { createWorktree } from "../src/git/create-worktree";
import { resolveOpenTarget } from "../src/git/open-target";
import { discoverRepository } from "../src/git/repository";
import { runSetup } from "../src/hooks";
import type { CommandContext } from "../src/services";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const editorStub = fileURLToPath(new URL("./fixtures/editor-stub.ts", import.meta.url));

const cli = (cwd: string, ...args: string[]) => execa(process.execPath, [entry, ...args], {
  cwd, reject: false, timeout: 30_000, env: { CI: "true" },
});

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function snapshot(primary: string) {
  return {
    refs: await git(primary, "show-ref"),
    worktrees: await git(primary, "worktree", "list", "--porcelain", "-z"),
  };
}

async function addBareRemote(primary: string, directory: string, name: string): Promise<string> {
  const bare = join(directory, `${name}.git`);
  await git(directory, "init", "--bare", bare);
  await git(primary, "remote", "add", name, bare);
  return bare;
}

async function config(primary: string, lines: readonly string[]): Promise<void> {
  await writeFile(join(primary, ".timber.toml"), `${lines.join("\n")}\n`);
}

function toml(value: string): string {
  return JSON.stringify(value);
}

async function waitForJson(path: string): Promise<{ args: string[]; cwd: string }> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")) as { args: string[]; cwd: string }; }
    catch { await Bun.sleep(10); }
  }
  throw new Error(`Timed out waiting for editor fixture at ${path}`);
}

test("existing dirty and detached worktrees open offline from nested primary and linked directories", async () => {
  await withRepository(async (primary, directory) => {
    const linked = join(directory, "manual worktrees", "linked");
    const detached = join(directory, "manual detached");
    const nestedPrimary = join(primary, "nested");
    const nestedLinked = join(linked, "nested");
    await git(primary, "remote", "add", "offline", join(directory, "unavailable.git"));
    await config(primary, ['remote = "offline"']);
    await git(primary, "worktree", "add", "-b", "TIM-70_existing", linked);
    await git(primary, "worktree", "add", "--detach", detached);
    await mkdir(nestedPrimary);
    await mkdir(nestedLinked);

    await writeFile(join(linked, "tracked.txt"), "staged bytes\n");
    await git(linked, "add", "tracked.txt");
    await writeFile(join(linked, "tracked.txt"), "unstaged bytes\n");
    await writeFile(join(linked, "untracked.txt"), "keep this\n");
    await writeFile(join(linked, ".env"), "keep this too\n");

    const before = await snapshot(primary);
    const indexPath = join(await git(linked, "rev-parse", "--absolute-git-dir"), "index");
    const index = await readFile(indexPath);
    const fileBytes = await Promise.all(["tracked.txt", "untracked.txt", ".env"].map(async name =>
      [name, await readFile(join(linked, name))] as const));

    const prefix = await cli(nestedPrimary, "open", "TIM-70");
    const exact = await cli(nestedLinked, "open", "TIM-70_existing");
    const absolute = await cli(nestedLinked, "open", detached);
    for (const result of [prefix, exact, absolute]) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(prefix.stdout).toBe(`Opened existing worktree at ${linked}`);
    expect(exact.stdout).toBe(`Opened existing worktree at ${linked}`);
    expect(absolute.stdout).toBe(`Opened existing worktree at ${detached}`);
    expect(await snapshot(primary)).toEqual(before);
    expect(await readFile(indexPath)).toEqual(index);
    for (const [name, bytes] of fileBytes) expect(await readFile(join(linked, name))).toEqual(bytes);
  });
});

test("local branches get one worktree beneath the configured primary-relative directory", async () => {
  await withRepository(async (primary, directory) => {
    const nested = join(primary, "nested");
    await mkdir(nested);
    await git(primary, "branch", "feature/local");
    await config(primary, ['worktree_dir = "../created trees"']);
    const path = join(directory, "created trees", "feature-local");
    const branchHead = await git(primary, "rev-parse", "refs/heads/feature/local");

    const first = await cli(nested, "open", "feature/local");
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe(`Created worktree at ${path}`);
    expect(first.stderr).toBe("");
    expect(await git(path, "branch", "--show-current")).toBe("feature/local");
    expect(await git(path, "rev-parse", "HEAD")).toBe(branchHead);
    const inventory = await snapshot(primary);

    const second = await cli(nested, "open", "feature/local");
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe(`Opened existing worktree at ${path}`);
    expect(second.stderr).toBe("");
    expect(await snapshot(primary)).toEqual(inventory);
  });
});

test("remote-only creation refreshes a stale selected ref and later reuses it offline", async () => {
  await withRepository(async (primary, directory) => {
    const bare = await addBareRemote(primary, directory, "origin");
    await git(primary, "branch", "feature/remote");
    await git(primary, "push", "origin", "feature/remote");
    await git(primary, "fetch", "origin");
    const stale = await git(primary, "rev-parse", "refs/remotes/origin/feature/remote");
    await git(primary, "checkout", "feature/remote");
    await writeFile(join(primary, "tracked.txt"), "remote update\n");
    await git(primary, "add", "tracked.txt");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "remote update");
    const fresh = await git(primary, "rev-parse", "HEAD");
    await git(primary, "push", "origin", "feature/remote");
    await git(primary, "checkout", "trunk");
    await git(primary, "update-ref", "refs/remotes/origin/feature/remote", stale);
    await git(primary, "branch", "-D", "feature/remote");
    await config(primary, ['remote = "origin"', 'worktree_dir = "../created trees"']);
    const nested = join(primary, "nested");
    await mkdir(nested);
    const path = join(directory, "created trees", "feature-remote");

    const created = await cli(nested, "open", "origin/feature/remote");
    expect(created.stderr).toBe("");
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toBe(`Created worktree at ${path}`);
    expect(created.stderr).toBe("");
    expect(await git(path, "rev-parse", "HEAD")).toBe(fresh);
    expect(await git(primary, "rev-parse", "refs/remotes/origin/feature/remote")).toBe(fresh);
    expect(await git(primary, "config", "branch.feature/remote.remote")).toBe("origin");
    expect(await git(primary, "config", "branch.feature/remote.merge")).toBe("refs/heads/feature/remote");
    expect(fresh).not.toBe(stale);
    const beforeOfflineReuse = await snapshot(primary);

    await git(primary, "remote", "set-url", "origin", join(directory, "unavailable.git"));
    const reused = await cli(nested, "open", "origin/feature/remote");
    expect(reused.exitCode).toBe(0);
    expect(reused.stdout).toBe(`Opened existing worktree at ${path}`);
    expect(reused.stderr).toBe("");
    expect(await snapshot(primary)).toEqual(beforeOfflineReuse);
    expect(await exists(bare)).toBe(true);
  });
});

test("exact local branch wins over same-named remote; explicit incompatible remote fails without adopting it", async () => {
  await withRepository(async (primary, directory) => {
    const bareOrigin = await addBareRemote(primary, directory, "origin");
    const bareUpstream = await addBareRemote(primary, directory, "upstream");
    const base = await git(primary, "rev-parse", "HEAD");
    await git(primary, "branch", "feature/shared", base);
    await writeFile(join(primary, "tracked.txt"), "remote only commit\n");
    await git(primary, "add", "tracked.txt");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "remote only commit");
    const remoteHead = await git(primary, "rev-parse", "HEAD");
    await git(primary, "push", "origin", "HEAD:refs/heads/feature/shared");
    await git(primary, "push", "upstream", "HEAD:refs/heads/feature/shared");
    await git(primary, "fetch", "origin");
    await git(primary, "fetch", "upstream");
    await git(primary, "config", "branch.feature/shared.remote", "origin");
    await git(primary, "config", "branch.feature/shared.merge", "refs/heads/feature/shared");
    await config(primary, ['remote = "upstream"']);
    const localHead = await git(primary, "rev-parse", "refs/heads/feature/shared");
    const nested = join(primary, "nested");
    await mkdir(nested);
    const localPath = join(directory, "primary repo-worktrees", "feature-shared");

    const local = await cli(nested, "open", "feature/shared");
    expect(local.stderr).toBe("");
    expect(local.exitCode).toBe(0);
    expect(local.stdout).toBe(`Created worktree at ${localPath}`);
    expect(await git(localPath, "rev-parse", "HEAD")).toBe(localHead);
    expect(localHead).not.toBe(remoteHead);

    await git(primary, "worktree", "remove", localPath);
    const beforeExplicitRemote = await snapshot(primary);
    const explicit = await cli(nested, "open", "upstream/feature/shared");
    expect(explicit.exitCode).toBe(1);
    expect(explicit.stdout).toBe("");
    expect(explicit.stderr).toMatch(/Branch feature\/shared already exists/i);
    expect(await snapshot(primary)).toEqual(beforeExplicitRemote);
    expect(await git(primary, "rev-parse", "refs/remotes/origin/feature/shared")).toBe(remoteHead);
    expect(await git(primary, "rev-parse", "refs/remotes/upstream/feature/shared")).toBe(remoteHead);
    expect(await exists(bareOrigin)).toBe(true);
    expect(await exists(bareUpstream)).toBe(true);
  });
});

test("configured remote selects among duplicate remote branch names", async () => {
  await withRepository(async (primary, directory) => {
    await addBareRemote(primary, directory, "origin");
    await addBareRemote(primary, directory, "upstream");
    await git(primary, "branch", "feature/shared");
    await git(primary, "checkout", "feature/shared");
    await writeFile(join(primary, "tracked.txt"), "upstream version\n");
    await git(primary, "add", "tracked.txt");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "upstream version");
    const upstreamHead = await git(primary, "rev-parse", "HEAD");
    await git(primary, "push", "upstream", "feature/shared");
    await git(primary, "checkout", "trunk");
    await writeFile(join(primary, "tracked.txt"), "origin version\n");
    await git(primary, "add", "tracked.txt");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "origin version");
    const originHead = await git(primary, "rev-parse", "HEAD");
    await git(primary, "push", "origin", "HEAD:refs/heads/feature/shared");
    await git(primary, "fetch", "origin");
    await git(primary, "fetch", "upstream");
    await git(primary, "branch", "-D", "feature/shared");
    await config(primary, ['remote = "upstream"']);
    const path = join(directory, "primary repo-worktrees", "feature-shared");

    const result = await cli(primary, "open", "feature/shared");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`Created worktree at ${path}`);
    expect(await git(path, "rev-parse", "HEAD")).toBe(upstreamHead);
    expect(await git(path, "rev-parse", "HEAD")).not.toBe(originHead);
  });
});

test("exact explicit remote selects its ref and unique ticket prefix opens without substring guessing", async () => {
  await withRepository(async (primary, directory) => {
    await addBareRemote(primary, directory, "origin");
    await addBareRemote(primary, directory, "upstream");
    await git(primary, "branch", "feature/shared");
    await git(primary, "checkout", "feature/shared");
    await writeFile(join(primary, "tracked.txt"), "upstream version\n");
    await git(primary, "add", "tracked.txt");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "upstream version");
    await git(primary, "push", "upstream", "feature/shared");
    await git(primary, "checkout", "trunk");
    await writeFile(join(primary, "tracked.txt"), "origin version\n");
    await git(primary, "add", "tracked.txt");
    await git(primary, "-c", "user.name=Timber Test", "-c", "user.email=test@example.invalid", "commit", "-m", "origin version");
    const originHead = await git(primary, "rev-parse", "HEAD");
    await git(primary, "push", "origin", "HEAD:refs/heads/feature/shared");
    await git(primary, "fetch", "origin");
    await git(primary, "fetch", "upstream");
    await git(primary, "branch", "-D", "feature/shared");
    await config(primary, ['remote = "upstream"']);
    const explicitPath = join(directory, "primary repo-worktrees", "feature-shared");

    const explicit = await cli(primary, "open", "origin/feature/shared");
    expect(explicit.stderr).toBe("");
    expect(explicit.exitCode).toBe(0);
    expect(explicit.stdout).toBe(`Created worktree at ${explicitPath}`);
    expect(await git(explicitPath, "rev-parse", "HEAD")).toBe(originHead);

    await git(primary, "branch", "TIM-80_one");
    await git(primary, "branch", "TIM-800-no");
    await git(primary, "branch", "TIM-81-one");
    await git(primary, "branch", "TIM-81_two");
    const prefixPath = join(directory, "primary repo-worktrees", "TIM-80_one");
    const prefix = await cli(primary, "open", "TIM-80");
    expect(prefix.exitCode).toBe(0);
    expect(prefix.stdout).toBe(`Created worktree at ${prefixPath}`);
    expect(await git(prefixPath, "branch", "--show-current")).toBe("TIM-80_one");
    const beforeRejectedPrefix = await snapshot(primary);

    const boundary = await cli(primary, "open", "TIM-8");
    expect(boundary.exitCode).toBe(1);
    expect(boundary.stderr).toContain("No existing branch or worktree matches");
    const ambiguous = await cli(primary, "open", "TIM-81");
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stdout).toBe("");
    expect(ambiguous.stderr).toContain("TIM-81-one");
    expect(ambiguous.stderr).toContain("TIM-81_two");
    expect(await snapshot(primary)).toEqual(beforeRejectedPrefix);
  });
});

test("missing, unknown, empty, and unregistered absolute targets fail without Git changes", async () => {
  await withRepository(async (primary, directory) => {
    const before = await snapshot(primary);
    const missing = await cli(primary, "open");
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("error:");
    expect(missing.stderr).not.toContain("not implemented");

    for (const input of ["", "missing/branch", join(directory, "not registered")]) {
      const result = await cli(primary, "open", input);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(input === "" ? "Provide an existing branch" : "No existing branch or worktree matches");
      expect(result.stderr).not.toContain("Created worktree");
      expect(result.stderr).not.toContain("not implemented");
    }
    expect(await snapshot(primary)).toEqual(before);
  });
});

test("interactive ambiguity creates only the explicitly selected local branch worktree", async () => {
  await withRepository(async (primary, directory) => {
    await git(primary, "branch", "TIM-121-one");
    await git(primary, "branch", "TIM-121-two");
    const destination = join(directory, "primary repo-worktrees", "TIM-121-two");
    let chooserCalls = 0;
    let stdout = "";
    let stderr = "";
    const context: CommandContext = {
      cwd: primary,
      io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
      choose: async (message, choices) => {
        chooserCalls++;
        expect(message).toContain("2 targets");
        expect(choices.map(choice => choice.value)).toEqual([
          "branch:refs/heads/TIM-121-one", "branch:refs/heads/TIM-121-two",
        ]);
        return "branch:refs/heads/TIM-121-two";
      },
    };
    const open = createOpenHandler({
      discoverRepository,
      loadConfig: loadRepositoryConfig,
      resolveOpenTarget,
      createWorktree,
      runSetup,
      launchEditor,
      launchAgent: async () => ({ kind: "skipped" }),
    });

    await open("TIM-121", {}, context);

    expect(chooserCalls).toBe(1);
    expect(stdout).toBe(`Created worktree at ${destination}\n`);
    expect(stderr).toBe("");
    expect(await git(destination, "branch", "--show-current")).toBe("TIM-121-two");
    const worktrees = await git(primary, "worktree", "list", "--porcelain");
    expect(worktrees).toContain(`worktree ${destination}`);
    expect(worktrees).toContain("branch refs/heads/TIM-121-two");
    expect(worktrees).not.toContain("branch refs/heads/TIM-121-one");
  });
});

test("unavailable and deleted remote branches fail discovery without creating refs or paths", async () => {
  for (const mode of ["unavailable", "deleted"] as const) {
    await withRepository(async (primary, directory) => {
      const bare = await addBareRemote(primary, directory, "origin");
      await git(primary, "branch", "feature/remote-fail");
      await git(primary, "push", "origin", "feature/remote-fail");
      await git(primary, "fetch", "origin");
      const cached = await git(primary, "rev-parse", "refs/remotes/origin/feature/remote-fail");
      await git(primary, "branch", "-D", "feature/remote-fail");
      if (mode === "unavailable") {
        await git(primary, "remote", "set-url", "origin", join(directory, "unavailable.git"));
      } else {
        await git(bare, "update-ref", "-d", "refs/heads/feature/remote-fail");
      }
      await config(primary, ['remote = "origin"']);
      const path = join(directory, "primary repo-worktrees", "feature-remote-fail");
      const before = await snapshot(primary);
      const trackedBytes = await readFile(join(primary, "tracked.txt"));

      const result = await cli(primary, "open", "origin/feature/remote-fail");
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(mode === "unavailable"
        ? /Could not check existing remote branches/i
        : /No existing branch or worktree matches/i);
      expect(await git(primary, "rev-parse", "refs/remotes/origin/feature/remote-fail")).toBe(cached);
      expect(await exists(path)).toBe(false);
      expect(await readFile(join(primary, "tracked.txt"))).toEqual(trackedBytes);
      expect(await snapshot(primary)).toEqual(before);
    });
  }
});

test("destination file and directory collisions preserve their contents, refs, and worktree inventory", async () => {
  await withRepository(async (primary, directory) => {
    const root = join(directory, "custom targets");
    await mkdir(root);
    await git(primary, "branch", "feature/file-collision");
    await git(primary, "branch", "feature/directory-collision");
    const file = join(root, "feature-file-collision");
    const tree = join(root, "feature-directory-collision");
    await writeFile(file, "preserve file\n");
    await mkdir(tree);
    await writeFile(join(tree, "keep.txt"), "preserve directory\n");
    await config(primary, [`worktree_dir = ${toml(root)}`]);
    const before = await snapshot(primary);

    for (const branch of ["feature/file-collision", "feature/directory-collision"]) {
      const result = await cli(primary, "open", branch);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/Worktree path already exists/i);
    }
    expect(await readFile(file, "utf8")).toBe("preserve file\n");
    expect(await readFile(join(tree, "keep.txt"), "utf8")).toBe("preserve directory\n");
    expect(await snapshot(primary)).toEqual(before);
  });
});

test("a missing or prunable selected worktree is rejected and never replaced", async () => {
  await withRepository(async (primary, directory) => {
    const path = join(directory, "primary repo-worktrees", "feature-prunable");
    await git(primary, "worktree", "add", "-b", "feature/prunable", path);
    await rm(path, { recursive: true });
    const before = await snapshot(primary);

    const result = await cli(primary, "open", "feature/prunable");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Cannot open (missing|prunable) worktree/i);
    expect(await exists(path)).toBe(false);
    expect(await git(primary, "show-ref", "--verify", "refs/heads/feature/prunable")).toContain("refs/heads/feature/prunable");
    expect(await snapshot(primary)).toEqual(before);
  });
});

test("editor receives literal args and --no-editor suppresses startup", async () => {
  await withRepository(async (primary, directory) => {
    const capture = join(directory, "editor capture.json");
    const heartbeat = join(directory, "editor heartbeat");
    const noEditorCapture = join(directory, "no editor capture.json");
    const extra = ["", "--wait", "$(touch should-not-exist)", ";", "quoted ' value"];
    await git(primary, "branch", "feature/editor");
    await git(primary, "branch", "feature/no-editor");
    await config(primary, [
      "[editor]",
      `command = ${toml(process.execPath)}`,
      "enabled = true",
      `args = [${[editorStub, "capture", capture, heartbeat, ...extra].map(toml).join(", ")}]`,
    ]);
    const editorPath = join(directory, "primary repo-worktrees", "feature-editor");

    const launched = await cli(primary, "open", "feature/editor");
    expect(launched.exitCode).toBe(0);
    expect(launched.stdout).toBe(`Created worktree at ${editorPath}`);
    expect(launched.stderr).toBe("");
    const captured = await waitForJson(capture);
    expect(captured.args).toEqual([...extra, editorPath]);
    expect(captured.cwd).toBe(editorPath);

    await config(primary, [
      "[editor]",
      `command = ${toml(process.execPath)}`,
      "enabled = true",
      `args = [${[editorStub, "capture", noEditorCapture, heartbeat].map(toml).join(", ")}]`,
    ]);
    const noEditorPath = join(directory, "primary repo-worktrees", "feature-no-editor");
    const skipped = await cli(primary, "open", "feature/no-editor", "--no-editor");
    expect(skipped.exitCode).toBe(0);
    expect(skipped.stdout).toBe(`Created worktree at ${noEditorPath}`);
    expect(skipped.stderr).toBe("");
    await Bun.sleep(100);
    expect(await exists(noEditorCapture)).toBe(false);
  });
});

test("open honors disabled editor config and explicit --editor for an existing worktree", async () => {
  await withRepository(async (primary, directory) => {
    const capture = join(directory, "editor opt-in capture.json");
    const heartbeat = join(directory, "editor opt-in heartbeat");
    await git(primary, "branch", "feature/editor-opt-in");
    await config(primary, [
      "[editor]", `command = ${toml(process.execPath)}`,
      `args = [${[editorStub, "capture", capture, heartbeat].map(toml).join(", ")}]`,
    ]);
    const first = await cli(primary, "open", "feature/editor-opt-in");
    expect(first.exitCode).toBe(0);
    await Bun.sleep(100);
    expect(await exists(capture)).toBe(false);

    const second = await cli(primary, "open", "feature/editor-opt-in", "--editor");
    expect(second.exitCode).toBe(0);
    const target = join(directory, "primary repo-worktrees", "feature-editor-opt-in");
    expect(await waitForJson(capture)).toEqual({ args: [target], cwd: target });
  });
});

test("open --editor without a configured command preserves refs and worktrees", async () => {
  await withRepository(async (primary) => {
    await git(primary, "branch", "feature/missing-editor");
    const before = await snapshot(primary);
    const result = await cli(primary, "open", "feature/missing-editor", "--editor");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Configure an editor");
    expect(await snapshot(primary)).toEqual(before);
  });
});

test("editor startup failure returns success, retains the worktree, and absolute-path retry reuses it", async () => {
  await withRepository(async (primary, directory) => {
    const missingExecutable = join(directory, "missing editor command");
    await git(primary, "branch", "feature/editor-failure");
    await config(primary, ["[editor]", `command = ${toml(missingExecutable)}`, "enabled = true"]);
    const path = join(directory, "primary repo-worktrees", "feature-editor-failure");

    const created = await cli(primary, "open", "feature/editor-failure");
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toBe(`Created worktree at ${path}`);
    expect(created.stderr).toContain("Could not start the configured editor");
    expect(created.stderr).toContain(`timber open --editor -- '${path}'`);
    const inventory = await snapshot(primary);

    const retried = await cli(primary, "open", path);
    expect(retried.exitCode).toBe(0);
    expect(retried.stdout).toBe(`Opened existing worktree at ${path}`);
    expect(retried.stderr).toContain(`timber open --editor -- '${path}'`);
    expect(await snapshot(primary)).toEqual(inventory);
  });
});

test("open safely displays a real control-character worktree path on success, editor failure, and ambiguity", async () => {
  await withRepository(async (primary, directory) => {
    const marker = join(directory, "retry-injection-marker");
    const controlPath = join(directory, `linked-\u001b[2JFAKE\nROW\u007f\u0085\u009b\u2028\u2029 $(touch ${marker}) 'quoted' \\path`);
    const ambiguityPath = join(directory, "ambiguous-\u009b\nPATH");
    const missingEditor = join(directory, "missing editor executable");
    await git(primary, "worktree", "add", "-b", "feature/control", controlPath);
    await git(primary, "worktree", "add", "-b", "TIM-92_one", ambiguityPath);
    await git(primary, "branch", "TIM-92_two");
    await config(primary, ["[editor]", `command = ${toml(missingEditor)}`, "enabled = true"]);

    const opened = await cli(primary, "open", "feature/control", "--no-editor");
    expect(opened.stderr).toBe("");
    expect(opened.exitCode).toBe(0);
    expect(opened.stdout).toContain("Opened existing worktree at \"");
    expect(opened.stdout).toContain("\\u001b[2JFAKE\\nROW\\u007f\\u0085\\u009b\\u2028\\u2029");
    expect(opened.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u);
    expect(opened.stderr).toBe("");

    const failedEditor = await cli(primary, "open", "feature/control");
    expect(failedEditor.exitCode).toBe(0);
    expect(failedEditor.stdout).toContain("\\u001b[2JFAKE\\nROW\\u007f\\u0085\\u009b\\u2028\\u2029");
    expect(failedEditor.stderr).toContain("Could not start the configured editor");
    expect(failedEditor.stderr).toContain("\\u001b[2JFAKE\\nROW\\u007f\\u0085\\u009b\\u2028\\u2029");
    expect(failedEditor.stderr).toContain("retry with: timber open --editor -- $");
    expect(failedEditor.stderr).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u);

    const retryPrefix = "retry with: timber open --editor -- ";
    const retryStart = failedEditor.stderr.indexOf(retryPrefix);
    expect(retryStart).toBeGreaterThanOrEqual(0);
    const bashWord = failedEditor.stderr.slice(retryStart + retryPrefix.length).trim();
    let retryPath = "";
    for (const locale of ["C", "C.UTF-8"]) {
      const decoded = await execa("bash", ["-c", 'eval "printf %s $1"', "timber-open-retry-test", bashWord], {
        cwd: directory, reject: false, env: { ...process.env, LC_ALL: locale },
      });
      expect(decoded.exitCode).toBe(0);
      expect(decoded.stdout).toBe(controlPath);
      retryPath = decoded.stdout;
    }
    expect(await exists(marker)).toBe(false);
    const retried = await cli(primary, "open", retryPath);
    expect(retried.exitCode).toBe(0);
    expect(retried.stdout).toContain("Opened existing worktree at ");
    expect(retried.stderr).toContain("retry with: timber open --editor -- $");
    expect(await exists(marker)).toBe(false);

    const ambiguous = await cli(primary, "open", "TIM-92");
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stdout).toBe("");
    expect(ambiguous.stderr).toContain("\\u009b\\nPATH");
    expect(ambiguous.stderr).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u);
    expect(ambiguous.stderr.split("\n")).toHaveLength(3);

    const unsafeInput = "missing-\u001b\nINPUT\u007f\u009b\u2028\u2029";
    const missing = await cli(primary, "open", unsafeInput);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("missing-\\u001b\\nINPUT\\u007f\\u009b\\u2028\\u2029");
    expect(missing.stderr).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u);
  });
});

test("open preserves colliding local and remote branch identities and gives truthful guidance", async () => {
  await withRepository(async (primary, directory) => {
    await addBareRemote(primary, directory, "TIM-42");
    await git(primary, "branch", "TIM-42/TIM-42-one");
    await git(primary, "push", "TIM-42", "HEAD:refs/heads/TIM-42-one");
    await git(primary, "fetch", "TIM-42");
    await config(primary, ['remote = "TIM-42"']);
    const before = await snapshot(primary);

    const result = await cli(primary, "open", "TIM-42");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Local branch TIM-42/TIM-42-one");
    expect(result.stderr).toContain("Git ref: refs/heads/TIM-42/TIM-42-one");
    expect(result.stderr).toContain("Remote branch TIM-42/TIM-42-one");
    expect(result.stderr).toContain("Git ref: refs/remotes/TIM-42/TIM-42-one");
    expect(result.stderr).toContain("shadowed by known remote prefix TIM-42");
    expect(result.stderr).toContain("create a Git worktree");
    expect(result.stderr).toContain("absolute-worktree-path");
    expect(result.stderr).toContain("Exact selector: TIM-42/TIM-42-one");
    expect(result.stderr.match(/Exact selector:/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("open -- 'TIM-42/TIM-42-one'");
    expect(await snapshot(primary)).toEqual(before);
  });
});
