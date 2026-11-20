import { expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const stub = fileURLToPath(new URL("./fixtures/agent-stub.ts", import.meta.url));
const terminal = fileURLToPath(new URL("./helpers/pty-runner.py", import.meta.url));
let serial = 0;

async function pty(cwd: string, directory: string, args: string[], env: Record<string, string>): Promise<{ exitCode: number; output: string }> {
  const payload = join(directory, `pty-${serial++}.json`);
  await writeFile(payload, JSON.stringify({ cwd, command: [process.execPath, entry, ...args], env }));
  const result = await execa("python3", ["-B", terminal, payload], { timeout: 30_000 });
  return JSON.parse(result.stdout);
}

async function configure(primary: string, capture: string) {
  await writeFile(join(primary, ".timber.toml"), [
    'base_branch = "trunk"', "[agent]", "enabled = true",
    `command = ${JSON.stringify(process.execPath)}`, `args = ${JSON.stringify([stub, "capture", capture])}`,
  ].join("\n"));
}

async function handoffFolder(directory: string): Promise<string> {
  const folder = join(directory, "handoff");
  await mkdir(folder, { mode: 0o700 });
  await chmod(folder, 0o700);
  return folder;
}

const posix = process.platform !== "win32";

test.skipIf(!posix)("new in an app terminal hands the created worktree to the app and starts no agent here", async () => {
  await withRepository(async (primary, directory) => {
    const capture = join(directory, "capture.json");
    await configure(primary, capture);
    const folder = await handoffFolder(directory);
    const result = await pty(primary, directory, ["new", "feature/app", "--no-editor"], { TIMBER_APP_HANDOFF: folder });
    expect(result.exitCode).toBe(0);
    const target = join(directory, "primary repo-worktrees", "feature-app");
    expect(result.output).toContain("in the Timber app with its agent");
    expect(await Bun.file(capture).exists()).toBe(false);
    const names = await readdir(folder);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9]+-[0-9]+-[0-9a-f]{12}\.json$/u);
    const file = join(folder, names[0]!);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      schemaVersion: 1, command: "new", repository: { primaryWorktreeRoot: primary },
      worktree: { path: target, branch: "feature/app" }, agent: true,
    });
    expect(await git(target, "rev-parse", "HEAD")).toBe(await git(primary, "rev-parse", "trunk"));
  });
});

test.skipIf(!posix)("new with --no-agent still hands off, asking for a shell", async () => {
  await withRepository(async (primary, directory) => {
    await configure(primary, join(directory, "capture.json"));
    const folder = await handoffFolder(directory);
    const result = await pty(primary, directory, ["new", "plain", "--no-editor", "--no-agent"], { TIMBER_APP_HANDOFF: folder });
    expect(result.exitCode).toBe(0);
    const [name] = await readdir(folder);
    expect(JSON.parse(await readFile(join(folder, name!), "utf8")).agent).toBe(false);
  });
});

test.skipIf(!posix)("an unusable handoff folder is refused before Git changes and Timber runs as outside the app", async () => {
  await withRepository(async (primary, directory) => {
    const capture = join(directory, "capture.json");
    await configure(primary, capture);
    const open = join(directory, "shared");
    await mkdir(open);
    await chmod(open, 0o755);
    const link = join(directory, "link");
    await symlink(await handoffFolder(directory), link);
    for (const [index, value] of [open, link, "relative", join(directory, "missing")].entries()) {
      const result = await pty(primary, directory, ["new", `outside-${index}`, "--no-editor"], { TIMBER_APP_HANDOFF: value });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("running as outside the Timber app");
      expect(JSON.parse(await readFile(capture, "utf8")).cwd).toBe(join(directory, "primary repo-worktrees", `outside-${index}`));
    }
    expect(await readdir(open)).toEqual([]);
    expect(await readdir(join(directory, "handoff"))).toEqual([]);
  });
});

test.skipIf(!posix)("open of an existing worktree stays in this terminal in the app", async () => {
  await withRepository(async (primary, directory) => {
    const tree = join(directory, "existing tree");
    await git(primary, "worktree", "add", "-b", "existing", tree);
    const capture = join(directory, "capture.json");
    await configure(primary, capture);
    const folder = await handoffFolder(directory);
    const result = await pty(primary, directory, ["open", tree, "--no-editor"], { TIMBER_APP_HANDOFF: folder });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(capture, "utf8")).cwd).toBe(tree);
    expect(await readdir(folder)).toEqual([]);
  });
});
