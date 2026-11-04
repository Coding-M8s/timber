import { expect, test } from "bun:test";
import { parseGithubInput } from "../src/github/input";
import { parseGithubRemoteUrl, resolveGithubRepository } from "../src/github/repository";
import { repositoryFixture } from "./helpers/services";

test("GitHub input is exact and does not normalize invalid selectors", () => {
  expect(parseGithubInput("github:123")).toEqual({ number: 123 });
  expect(parseGithubInput("feature/foo")).toBeNull();
  for (const input of ["github:0", "github:01", "github:-1", "github:123 extra", "github: 1", "github:9007199254740992"]) {
    expect(() => parseGithubInput(input)).toThrow();
  }
});

test("GitHub remote URLs accept ordinary Git transports and reject host/path tricks", () => {
  for (const url of ["https://github.com/team/project.git", "git@github.com:team/project.git", "ssh://git@github.com/team/project"]) {
    expect(parseGithubRemoteUrl(url)).toEqual({ owner: "team", name: "project" });
  }
  for (const url of ["https://github.com.evil/team/project", "https://token@github.com/team/project", "https://github.com/team/project?x=1", "https://github.com/team/../project", "https://github.com/team/project/extra", "https://github.com/team/project\n"]) {
    expect(() => parseGithubRemoteUrl(url)).toThrow();
  }
});

test("issue remote precedence is explicit, configured, then origin without changing base", async () => {
  const repository = repositoryFixture({ remotes: [{ name: "origin", defaultBranchRef: null }, { name: "upstream", defaultBranchRef: null }] });
  const config = { baseBranch: "main", remote: null, worktreeDir: null, editor: null, agent: null };
  const reads: string[][] = [];
  const read = async (_cwd: string, args: string[]) => { reads.push(args); return ["https://github.com/team/project.git"]; };
  await resolveGithubRepository(repository, config, undefined, read);
  expect(reads[0]).toEqual(["remote", "get-url", "--all", "--", "origin"]);
  await resolveGithubRepository(repository, { ...config, remote: "origin" }, "upstream", read);
  expect(reads[1]!.at(-1)).toBe("upstream");
  await expect(resolveGithubRepository(repository, config, "missing", read)).rejects.toThrow();
  await expect(resolveGithubRepository(repository, config, "origin", async () => ["https://other.example/a/b"])).rejects.toThrow();
  await expect(resolveGithubRepository(repository, config, "origin", async () => ["https://github.com/a/b", "https://github.com/c/d"])).rejects.toThrow();
});
