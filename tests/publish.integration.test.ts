import { expect, test } from "bun:test";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { git, withRepository } from "./helpers/git";
import { commit, entry, fixture } from "./helpers/rebase";

// Closed stdin and no user or system Git configuration: no credential helper can answer.
const cli = (cwd: string, ...args: string[]) => execa(process.execPath, ["--no-env-file", entry, ...args], {
  cwd, reject: false, timeout: 30_000, stdin: "ignore",
  env: { CI: "true", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
});
const record = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const branch = "TIM-28-feature";
const upstream = `refs/remotes/origin/${branch}`;
const remoteTip = (remote: string, name = branch) => git(remote, "rev-parse", "--verify", `refs/heads/${name}`);
/** Every local ref and branch setting, to prove a stop changed nothing. */
const localState = async (cwd: string) => [
  await git(cwd, "for-each-ref", "--format=%(refname) %(objectname)"),
  (await execa("git", ["config", "--get-regexp", "^branch\\."], { cwd, reject: false })).stdout,
].join("\n");

test("a branch with no upstream is published and tracked, a later commit is pushed, and a rerun is up to date", async () => {
  await withRepository(async (primary, directory) => {
    const { remote, target } = await fixture(primary, directory);
    const first = await commit(target, "feature.txt", "feature\n");
    const output = join(directory, "publish result.json");
    const result = await cli(primary, "publish", "TIM-28", "--result-file", output);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Published ${first} to origin/${branch}. Upstream set.`);
    const data = await record(output);
    expect(data).toMatchObject({ schemaVersion: 1, command: "publish", outcome: "succeeded", exitCode: 0,
      materialized: false, diagnostic: null, repository: { primaryWorktreeRoot: primary },
      worktree: { path: target, canonicalPath: await realpath(target), branch, head: first },
      publish: { result: "published", remote: "origin", upstream, pushedCommit: first } });
    expect(data).not.toHaveProperty("worktrees");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(await remoteTip(remote)).toBe(first);
    expect(await git(target, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(upstream);

    // Human mode has the same behavior: a fast-forward push to the existing upstream.
    const second = await commit(target, "feature.txt", "more\n");
    const human = await cli(primary, "publish", target);
    expect(human.exitCode).toBe(0);
    expect(human.stdout.endsWith(`Published ${second} to origin/${branch}.`)).toBe(true);
    expect(await remoteTip(remote)).toBe(second);

    const again = join(directory, "again.json");
    const before = await localState(primary);
    const rerun = await cli(primary, "publish", branch, "--result-file", again);
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout.endsWith("Already up to date.")).toBe(true);
    expect(await record(again)).toMatchObject({ outcome: "succeeded", exitCode: 0, diagnostic: null,
      publish: { result: "up-to-date", remote: "origin", upstream, pushedCommit: second } });
    expect(await localState(primary)).toBe(before);
    expect(await remoteTip(remote)).toBe(second);
  });
});

test("a remote that moved on is refused without a force push or any local ref change", async () => {
  await withRepository(async (primary, directory) => {
    const { remote, publisher, target } = await fixture(primary, directory);
    await commit(target, "feature.txt", "feature\n");
    expect((await cli(primary, "publish", target)).exitCode).toBe(0);
    await git(publisher, "fetch", "origin");
    await git(publisher, "checkout", "-b", branch, `origin/${branch}`);
    const theirs = await commit(publisher, "theirs.txt", "theirs\n");
    await git(publisher, "push", "origin", branch);
    const mine = await commit(target, "mine.txt", "mine\n");
    const before = await localState(primary);
    const output = join(directory, "refused.json");
    const result = await cli(primary, "publish", target, "--result-file", output);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("has moved on");
    const data = await record(output);
    expect(data).toMatchObject({ command: "publish", outcome: "failed", exitCode: 1, worktree: { path: target, head: mine },
      publish: { result: "refused", remote: "origin", upstream, pushedCommit: null } });
    expect(data.diagnostic).toContain("Timber never force-pushes");
    expect(await localState(primary)).toBe(before);
    expect(await remoteTip(remote)).toBe(theirs);
    // Human mode refuses the same way.
    const human = await cli(primary, "publish", target);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain("has moved on");
    expect(await remoteTip(remote)).toBe(theirs);
  });
});

test("missing credentials fail with a sign-in reason and no prompt while standard input is closed", async () => {
  // Any request is answered with a credential challenge, as a private remote would.
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1",
    fetch: () => new Response("sign in", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="test"' } }) });
  try {
    await withRepository(async (primary, directory) => {
      const { target } = await fixture(primary, directory);
      await commit(target, "feature.txt", "feature\n");
      await git(primary, "remote", "set-url", "origin", `http://127.0.0.1:${server.port}/private.git`);
      const before = await localState(primary);
      const output = join(directory, "sign-in.json");
      const result = await cli(primary, "publish", target, "--result-file", output);
      expect(result.exitCode).toBe(1);
      expect(result.timedOut).toBe(false);
      const data = await record(output);
      expect(data).toMatchObject({ command: "publish", outcome: "failed", exitCode: 1,
        publish: { result: "failed", remote: "origin", upstream, pushedCommit: null } });
      expect(data.diagnostic).toContain("needs a sign-in");
      expect(await localState(primary)).toBe(before);
    });
  } finally {
    await server.stop(true);
  }
});

test("detached, missing, unmatched and differently named upstream targets are refused before any push", async () => {
  await withRepository(async (primary, directory) => {
    const { remote, target } = await fixture(primary, directory);
    const tip = await commit(target, "feature.txt", "feature\n");
    const main = await remoteTip(remote, "main");
    const refused = async (name: string, selector: string, message: string, worktree: unknown) => {
      const output = join(directory, `${name}.json`);
      const result = await cli(primary, "publish", "--result-file", output, "--", selector);
      expect(result.exitCode).toBe(1);
      const data = await record(output);
      expect(data).toMatchObject({ command: "publish", outcome: "failed", exitCode: 1, worktree,
        publish: { result: "refused", pushedCommit: null } });
      expect(data.diagnostic).toContain(message);
      return data;
    };

    // An upstream on another branch must never receive this branch's commits.
    await git(target, "branch", "--set-upstream-to=origin/main");
    const named = await refused("named", target, "different name", { path: target });
    expect(named.publish).toMatchObject({ remote: null, upstream: null });
    await git(target, "branch", "--unset-upstream");

    await refused("unmatched", "no-such-branch", "No registered worktree matches", null);

    await git(target, "checkout", "--detach");
    await refused("detached", target, "detached HEAD", { path: target, branch: null, detached: true });
    await git(target, "checkout", branch);

    await rm(target, { recursive: true });
    await refused("missing", target, "missing or stale", { path: target, pathExists: false });

    expect(await remoteTip(remote, "main")).toBe(main);
    expect(await git(remote, "for-each-ref", "refs/heads")).not.toContain(branch);
    expect(await git(primary, "rev-parse", branch)).toBe(tip);
  });
});
