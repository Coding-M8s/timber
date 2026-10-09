import { expect, spyOn, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { EditorResult, RepositoryConfig } from "../src/types";
import { worktreeFixture } from "./helpers/services";
import { launchEditor } from "../src/editor";

const editorStubPath = fileURLToPath(new URL("./fixtures/editor-stub.ts", import.meta.url));
const editorParentPath = fileURLToPath(new URL("./fixtures/editor-launch-parent.ts", import.meta.url));
const secretMarker = "TIMBER_EDITOR_SECRET_MARKER_MUST_NOT_BE_PRINTED";

function config(editor: RepositoryConfig["editor"], agent: RepositoryConfig["agent"] = null): RepositoryConfig {
  return { baseBranch: null, remote: null, worktreeDir: null, editor, agent };
}

function quotePosix(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error(`Timed out waiting for fixture file: ${path}`);
}

async function waitForFileContent(path: string, expected: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await readFile(path, "utf8") === expected) return;
    } catch {
      // The fixture may not have created the marker yet.
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for fixture marker ${expected}: ${path}`);
}

function expectFailedResult(result: EditorResult, worktreePath: string): Extract<EditorResult, { kind: "failed" }> {
  if (result.kind !== "failed") throw new Error(`Expected editor failure, received ${result.kind}`);
  const retryCommand = `timber open -- ${quotePosix(worktreePath)}`;
  expect(result.message).toContain(worktreePath);
  expect(result.message.toLowerCase()).toContain("fix");
  expect(result.message).toContain("PATH");
  expect(result.message).toContain(retryCommand);
  expect(result.message).not.toContain(secretMarker);
  expect(result.retryCommand).not.toContain(secretMarker);
  expect(result.retryCommand).toBe(retryCommand);
  return result;
}

async function launchExpectedFailure(
  worktreePath: string,
  command: string,
  args: readonly string[],
): Promise<Extract<EditorResult, { kind: "failed" }>> {
  const result = await launchEditor(
    worktreeFixture({ path: worktreePath, pathExists: await exists(worktreePath), isPrimary: false }),
    config({ command, args }),
    false,
  );
  return expectFailedResult(result, worktreePath);
}

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa("git", args, { cwd });
  return result.stdout;
}

async function snapshotRepository(primaryPath: string, worktreePath: string) {
  const filePaths = [
    join(worktreePath, ".gitignore"),
    join(worktreePath, "tracked.txt"),
    join(worktreePath, "untracked.txt"),
    join(worktreePath, "ignored.txt"),
  ];
  const files: Record<string, string> = {};
  for (const path of filePaths) files[path] = (await readFile(path)).toString("hex");

  return {
    files,
    refs: await runGit(primaryPath, "show-ref"),
    status: await runGit(worktreePath, "status", "--porcelain=v1", "--ignored"),
    worktrees: await runGit(primaryPath, "worktree", "list", "--porcelain"),
  };
}

test("skips editor launch when no editor is configured", async () => {
  const result = await launchEditor(worktreeFixture(), config(null), false);

  expect(result).toEqual({ kind: "skipped" });
});

test("explicit disable skips both the editor and an enabled agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber-editor-disabled-"));
  const editorCapture = join(directory, "editor-capture.json");
  const agentCapture = join(directory, "agent-capture.json");
  const heartbeat = join(directory, "heartbeat");

  try {
    const result = await launchEditor(
      worktreeFixture(),
      config(
        { command: process.execPath, args: [editorStubPath, "capture", editorCapture, heartbeat] },
        { command: process.execPath, args: [editorStubPath, "capture", agentCapture, heartbeat], enabled: true },
      ),
      true,
    );

    expect(result).toEqual({ kind: "skipped" });
    await Bun.sleep(100);
    expect(await exists(editorCapture)).toBe(false);
    expect(await exists(agentCapture)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("passes configured arguments and the selected worktree path literally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber-editor-argv-"));
  const markerPath = join(directory, "shell-marker");
  const capturePath = join(directory, "capture.json");
  const heartbeatPath = join(directory, "heartbeat");
  const worktreePath = join(directory, "worktree space ' $(touch path-marker);");
  const pathMarkerPath = join(worktreePath, "path-marker");

  const extraArgs = ["", "--wait", `$(touch ${markerPath})`, ";", "with spaces ' and quotes"];
  const configuredArgs = Object.freeze([
    editorStubPath,
    "linger",
    capturePath,
    heartbeatPath,
    ...extraArgs,
  ]);

  try {
    await mkdir(worktreePath);
    const result = await launchEditor(
      worktreeFixture({ path: worktreePath }),
      config({ command: process.execPath, args: configuredArgs }),
      false,
    );

    expect(result).toEqual({ kind: "launched" });
    const capture = JSON.parse(await waitForFile(capturePath)) as { args: string[]; cwd: string };
    expect(capture.args).toEqual([...extraArgs, worktreePath]);
    expect(capture.cwd).toBe(worktreePath);
    await waitForFileContent(heartbeatPath, "alive");
    await waitForFileContent(`${heartbeatPath}.finished`, "finished");
    await Bun.sleep(50);
    expect(await exists(markerPath)).toBe(false);
    expect(await exists(pathMarkerPath)).toBe(false);
    expect(configuredArgs).toEqual([
      editorStubPath,
      "linger",
      capturePath,
      heartbeatPath,
      ...extraArgs,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns a safe retry result and preserves a dirty real worktree when the executable is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber-editor-git-"));
  const primaryPath = join(directory, "primary repo");
  const worktreePath = join(directory, "linked worktree ' snapshot");
  const missingExecutable = join(directory, "missing editor command");
  const stdoutSpy = spyOn(process.stdout, "write");
  const stderrSpy = spyOn(process.stderr, "write");

  try {
    await mkdir(primaryPath);
    await runGit(primaryPath, "init", "--quiet", "--initial-branch=main");
    await runGit(primaryPath, "config", "user.name", "Timber Test");
    await runGit(primaryPath, "config", "user.email", "timber-test@example.invalid");
    await writeFile(join(primaryPath, ".gitignore"), "ignored.txt\n");
    await writeFile(join(primaryPath, "tracked.txt"), "base bytes\n");
    await runGit(primaryPath, "add", ".gitignore", "tracked.txt");
    await runGit(primaryPath, "commit", "--quiet", "-m", "synthetic base");
    await runGit(primaryPath, "worktree", "add", "--quiet", "-b", "feature/editor-test", worktreePath);

    await writeFile(join(worktreePath, "tracked.txt"), "modified bytes\n");
    await writeFile(join(worktreePath, "untracked.txt"), "untracked bytes\n");
    await writeFile(join(worktreePath, "ignored.txt"), "ignored bytes\n");
    const before = await snapshotRepository(primaryPath, worktreePath);

    const result = await launchExpectedFailure(worktreePath, missingExecutable, [secretMarker]);

    expect(result.message).toContain("not found");
    expect(result.message).not.toContain(missingExecutable);
    expect(result.retryCommand).toBe(String.raw`timber open -- '${directory}/linked worktree '\'' snapshot'`);
    expect(await snapshotRepository(primaryPath, worktreePath)).toEqual(before);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }

  expect(stdoutSpy).not.toHaveBeenCalled();
  expect(stderrSpy).not.toHaveBeenCalled();
});

test("returns a safe permission diagnostic for a non-executable editor file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber-editor-eacces-"));
  const worktreePath = join(directory, "worktree");
  const editorPath = join(directory, "editor");

  try {
    await mkdir(worktreePath);
    await writeFile(editorPath, "#!/bin/sh\nexit 0\n");
    await chmod(editorPath, 0o600);

    const result = await launchExpectedFailure(worktreePath, editorPath, [secretMarker]);

    expect(result.message).toContain("Permission was denied");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns a safe retry result when the worktree directory has been deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber-editor-deleted-cwd-"));
  const worktreePath = join(directory, "deleted worktree");

  try {
    await mkdir(worktreePath);
    await rm(worktreePath, { recursive: true });

    const result = await launchExpectedFailure(worktreePath, process.execPath, [secretMarker]);

    expect(result.message).toContain("not found");
    expect(result.message).toContain("did not remove or modify the workspace");
    expect(result.message).toContain("Check whether the worktree still exists");
    expect(result.message).not.toContain("retained at");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps a non-directory worktree cwd to a fixed diagnostic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber-editor-notdir-"));
  const worktreePath = join(directory, "worktree-file");

  try {
    await writeFile(worktreePath, "not a directory\n");

    const result = await launchExpectedFailure(worktreePath, process.execPath, [secretMarker]);

    expect(result.message).toContain("not a directory");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns a generic safe retry result for invalid subprocess arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber-editor-invalid-arg-"));
  const worktreePath = join(directory, "worktree");

  try {
    await mkdir(worktreePath);

    const result = await launchExpectedFailure(worktreePath, process.execPath, [`invalid\0${secretMarker}`]);

    expect(result.message).not.toContain("\0");
    expect(result.message).not.toContain("ERR_INVALID_ARG_VALUE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parent exits before the long-lived editor heartbeat and the editor survives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber-editor-parent-linger-"));
  const worktreePath = join(directory, "worktree");
  const capturePath = join(directory, "capture.json");
  const heartbeatPath = join(directory, "heartbeat");
  const payloadPath = join(directory, "payload.json");
  let parentInvoked = false;

  try {
    await mkdir(worktreePath);
    await writeFile(payloadPath, JSON.stringify({
      worktree: worktreeFixture({ path: worktreePath, isPrimary: false }),
      config: config({
        command: process.execPath,
        args: [editorStubPath, "linger", capturePath, heartbeatPath],
      }),
      disabled: false,
      expectedKind: "launched",
      reportParentPid: true,
    }));

    parentInvoked = true;
    const parent = await execa(process.execPath, [editorParentPath, payloadPath], { timeout: 1000 });
    const result = JSON.parse(parent.stdout);
    expect(result).toEqual({ kind: "launched" });
    expect(parent.stderr).toBe("");

    expect(await waitForFile(heartbeatPath, 3000)).toBe("parent-exited");
    await waitForFileContent(`${heartbeatPath}.finished`, "finished", 3000);
  } finally {
    if (parentInvoked) {
      await waitForFileContent(`${heartbeatPath}.finished`, "finished", 3000).catch(() => {});
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("late nonzero editor exit does not reject or disclose configured arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timber-editor-parent-late-failure-"));
  const worktreePath = join(directory, "worktree");
  const capturePath = join(directory, "capture.json");
  const heartbeatPath = join(directory, "heartbeat");
  const payloadPath = join(directory, "payload.json");
  let parentInvoked = false;

  try {
    await mkdir(worktreePath);
    await writeFile(payloadPath, JSON.stringify({
      worktree: worktreeFixture({ path: worktreePath, isPrimary: false }),
      config: config({
        command: process.execPath,
        args: [editorStubPath, "late-failure", capturePath, heartbeatPath, secretMarker],
      }),
      disabled: false,
      expectedKind: "launched",
      waitForEditorExit: { path: heartbeatPath, content: "late-failure-exited", timeoutMs: 3000 },
      exitDrainMs: 50,
    }));

    parentInvoked = true;
    const parent = await execa(process.execPath, [editorParentPath, payloadPath], { timeout: 4000 });
    const result = JSON.parse(parent.stdout);
    expect(result).toEqual({ kind: "launched" });
    expect(parent.exitCode).toBe(0);
    expect(parent.stderr).toBe("");
    expect(parent.stdout).not.toContain(secretMarker);
    expect(parent.stderr).not.toContain(secretMarker);
    expect(await readFile(heartbeatPath, "utf8")).toBe("late-failure-exited");
  } finally {
    if (parentInvoked) await waitForFileContent(heartbeatPath, "late-failure-exited", 4000).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
