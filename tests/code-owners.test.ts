import { expect, test } from "bun:test";
import { ownersOf, parseCodeOwners } from "../src/git/code-owners";

const owners = (content: string, path: string) => ownersOf(path, parseCodeOwners(content)).map(owner => owner.name);

test("patterns match as GitHub documents them", () => {
  const cases: [string, string[], string[]][] = [
    ["*", ["a", "a/b/c.js"], []],
    ["*.js", ["a.js", "x/y/a.js"], ["a.jsx", "js"]],
    ["/build/logs/", ["build/logs/a", "build/logs/x/a"], ["x/build/logs/a", "build/logs"]],
    ["docs/*", ["docs/getting-started.md"], ["docs/build-app/troubleshooting.md", "x/docs/a.md"]],
    ["apps/", ["apps/a", "x/apps/y/a"], ["apps"]],
    ["/docs/", ["docs/a", "docs/x/a"], ["x/docs/a"]],
    ["**/logs", ["logs", "build/logs", "scripts/logs/x", "deeply/nested/logs/a"], ["mylogs"]],
    ["/a/**/z", ["a/z", "a/b/z", "a/b/c/z/inside"], ["b/z", "a/bz"]],
    ["src/**", ["src/a", "src/b/c"], ["src", "x/src/a"]],
    ["/README.md", ["README.md"], ["docs/README.md"]],
    ["docs/README.md", ["docs/README.md"], ["x/docs/README.md"]],
    ["file?.txt", ["file1.txt", "d/fileA.txt"], ["file.txt", "file10.txt"]],
    ["/with\\ space.txt", ["with space.txt"], ["with"]],
    ["/a.b", ["a.b"], ["axb"]],
    ["*.JS", [], ["a.js"]],
    ["/", [], ["a", "a/b"]],
    ["!*.js", [], ["a.js"]],
    ["/[ab].js", [], ["a.js", "[ab].js"]],
    ["\\#x", [], ["#x"]],
  ];
  for (const [pattern, yes, no] of cases) {
    for (const path of yes) expect([pattern, path, owners(`${pattern} @alice`, path)]).toEqual([pattern, path, ["alice"]]);
    for (const path of no) expect([pattern, path, owners(`${pattern} @alice`, path)]).toEqual([pattern, path, []]);
  }
});

test("the last matching line decides, also when it names nobody or only an email", () => {
  const file = "﻿# owners\r\n\r\n* @alice @acme/core # everyone\r\n/docs/ docs@example.invalid\r\n/docs/api/ @bob docs@example.invalid #note\r\n/vendor/\r\n";
  expect(owners(file, "src/a")).toEqual(["alice", "acme/core"]);
  expect(owners(file, "docs/a")).toEqual([]);
  expect(owners(file, "docs/api/a")).toEqual(["bob"]);
  expect(owners(file, "vendor/a")).toEqual([]);
});

test("a line with an owner GitHub cannot read is skipped, so an earlier line still applies", () => {
  for (const bad of ["alice", "@", "@-bad", "@acme/core/x", "@a;rm"]) {
    expect(owners(`* @alice\n*.js @bob ${bad}`, "a.js")).toEqual(["alice"]);
  }
});

test("a hostile pattern is answered without exponential backtracking", () => {
  const started = performance.now();
  expect(owners(`/${"*a".repeat(200)}b @alice`, "a".repeat(2000))).toEqual([]);
  expect(owners(`/${"**/a/".repeat(100)}b @alice`, "a/".repeat(1000) + "c")).toEqual([]);
  // A file too large to match stops instead of stalling.
  const many = parseCodeOwners(Array.from({ length: 200_000 }, (_, index) => `/d${index}/ @x`).join("\n"));
  const budget = { steps: 1_000_000 };
  expect(() => { for (let file = 0; file < 3000; file++) ownersOf(`src/${file}`, many, budget); }).toThrow("too large to match");
  expect(performance.now() - started).toBeLessThan(5_000);
});
