import { expect, test } from "bun:test";
import { createIgnoredPathIndex } from "../src/git/ignored-path-index";

// Reference behavior from the original nested scan, independent of the index.
function scan(paths: readonly string[], tracked: string, ignoreCase: boolean) {
  return paths.find(path => {
    const ignored = path.replace(/\/$/u, "");
    const left = ignoreCase ? tracked.toLowerCase() : tracked;
    const right = ignoreCase ? ignored.toLowerCase() : ignored;
    return left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
  });
}

const cases: [string[], string, string | undefined][] = [
  [[], "cache", undefined],
  [["cache/"], "cache", "cache/"],
  [["cache"], "cache/entry", "cache"],
  [["cache/entry"], "cache", "cache/entry"],
  [["cache/"], "cached/entry", undefined],
  [["cached/entry"], "cache", undefined],
  [["cache/z", "cache/a"], "cache", "cache/z"],
  [["cache/entry", "cache"], "cache/entry", "cache/entry"],
  [["cache", "cache/entry"], "cache/entry", "cache"],
  [["cache/entry/deep", "cache"], "cache/entry", "cache/entry/deep"],
  [["cache/", "cache"], "cache", "cache/"],
  [["秘密/環境/"], "秘密/環境/file", "秘密/環境/"],
  [["é/file"], "e\u0301/file", undefined],
  [["odd\n'\tname/"], "odd\n'\tname/file", "odd\n'\tname/"],
  [["__proto__/constructor"], "__proto__", "__proto__/constructor"],
];

for (const ignoreCase of [false, true]) {
  test.each(cases)(`collision and original first-match spelling (ignoreCase=${ignoreCase}): %j, %s`, (paths, tracked, expected) => {
    expect(createIgnoredPathIndex(paths, ignoreCase)(tracked)).toBe(expected);
  });

  test(`differential scan equivalence across 7,500 generated cases (ignoreCase=${ignoreCase})`, () => {
    let seed = 110;
    const random = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 0x100000000) * limit);
    };
    const segments = ["a", "aa", "A", "cache", "Cache", "é", "e\u0301", "İ", "i\u0307", "Σ", "ς", "秘密", "😀", "\uD800", "x\n\t'", "__proto__"];
    const path = () => Array.from({ length: 1 + random(4) }, () => segments[random(segments.length)]!).join("/");
    for (let i = 0; i < 7500; i++) {
      const shared = path();
      const paths = Array.from({ length: random(12) }, path);
      paths.splice(random(paths.length + 1), 0, shared + (random(2) ? "/" : ""));
      paths.splice(random(paths.length + 1), 0, shared + "/child");
      const index = createIgnoredPathIndex(paths, ignoreCase);
      // Reuse one index across unrelated, exact, descendant and ancestor reads.
      for (const tracked of [path(), shared, shared + "/child/file", shared.split("/")[0]!]) {
        expect(index(tracked)).toBe(scan(paths, tracked, ignoreCase));
      }
    }
  });
}

test("case folding matches the previous platform rule without Unicode normalization", () => {
  const paths = ["Cache/İ/", "cache/i\u0307/file", "Σ/"];
  expect(createIgnoredPathIndex(paths, false)("cache/i\u0307/file")).toBe(paths[1]);
  expect(createIgnoredPathIndex(paths, true)("cache/i\u0307/file")).toBe(paths[0]);
  expect(createIgnoredPathIndex(paths, true)("σ/file")).toBe("Σ/");
  expect(createIgnoredPathIndex(paths, true)("ς/file")).toBeUndefined();
  expect(createIgnoredPathIndex(["Cache/"])("cache/file")).toBe(process.platform === "win32" ? "Cache/" : undefined);
});
