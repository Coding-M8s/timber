import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { execa } from "execa";

const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const tagObject = "c".repeat(40);
const ref = "repos/test/timber/git/ref/tags/v0.2.0";
const annotated = `repos/test/timber/git/tags/${tagObject}`;
const cases = [
  { name: "matching lightweight tag", responses: { [ref]: { object: { type: "commit", sha: commit } } }, passes: true },
  { name: "moved lightweight tag", responses: { [ref]: { object: { type: "commit", sha: otherCommit } } }, passes: false },
  { name: "matching annotated tag", responses: {
    [ref]: { object: { type: "tag", sha: tagObject } },
    [annotated]: { object: { type: "commit", sha: commit } },
  }, passes: true },
  { name: "moved annotated tag", responses: {
    [ref]: { object: { type: "tag", sha: tagObject } },
    [annotated]: { object: { type: "commit", sha: otherCommit } },
  }, passes: false },
  { name: "missing tag or failed API", responses: {}, passes: false },
  { name: "noncommit target", responses: { [ref]: { object: { type: "tree", sha: commit } } }, passes: false },
  { name: "cyclic annotated tag", responses: {
    [ref]: { object: { type: "tag", sha: tagObject } },
    [annotated]: { object: { type: "tag", sha: tagObject } },
  }, passes: false },
];

for (const fixture of cases) {
  test(`remote release identity checks ${fixture.name} without GitHub writes`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "timber-remote-release-"));
    try {
      const calls = join(cwd, "calls.jsonl");
      const metadata = join(cwd, "build-info.json");
      await writeFile(metadata, JSON.stringify({ tag: "v0.2.0", sourceCommit: commit, sourceDirty: false }));
      await writeFile(join(cwd, "gh"), `#!/usr/bin/env python3
import json, os, sys
with open(os.environ["TIMBER_TEST_CALLS"], "a") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
responses = json.loads(os.environ["TIMBER_TEST_RESPONSES"])
if len(sys.argv) != 3 or sys.argv[1] != "api" or sys.argv[2] not in responses:
    sys.exit(1)
print(json.dumps(responses[sys.argv[2]]))
`, { mode: 0o755 });
      const result = await execa("python3", ["-B", resolve("scripts/verify-release-tag.py"),
        "--repo", "test/timber", "--tag", "v0.2.0", "--build-info", metadata], {
        reject: false,
        env: {
          PATH: `${cwd}${delimiter}${process.env.PATH}`,
          TIMBER_TEST_CALLS: calls,
          TIMBER_TEST_RESPONSES: JSON.stringify(fixture.responses),
        },
      });
      if (fixture.passes) {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(commit);
      } else {
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Release tag verification failed:");
      }
      const requests = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(requests[0]).toEqual(["api", ref]);
      expect(requests.every(args => args.length === 2 && args[0] === "api")).toBe(true);
      expect(requests.length).toBeLessThanOrEqual(10);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
