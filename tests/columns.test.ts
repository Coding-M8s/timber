import { expect, test } from "bun:test";
import { alignedRows, displayWidth } from "../src/columns";
import { expectColumnPositions } from "./helpers/columns";

test.each([
  ["ASCII", 5], ["界", 2], ["e\u0301", 1], ["\u0301", 0], ["ＡＢ", 4],
  ["😀", 2], ["👩‍💻", 2], ["🇺🇸", 2], ["1️⃣", 2], ["#\u20e3", 2],
  ["\\n\\t\\u001b", 10],
] as const)("display width of %s is %i cells", (value, expected) => {
  expect(displayWidth(value)).toBe(expected);
});

test("all columns align to widest rendered headers and values without truncation or final padding", () => {
  const cells = [
    ["BRANCH", "WORKFLOW", "STATUS", "PATH"],
    ["界e\u0301", "-", "clean", "/space path/界"],
    ["long-branch-name", "review", "dirty (2 modified, 1 untracked)", "/long path"],
    ["🇺🇸1️⃣", "investigation", "unknown (\\n\\u001b)", "/escaped\\tpath"],
  ];
  const widths = [
    [6, 8, 6, 4], [3, 1, 5, 14], [16, 6, 31, 10], [4, 13, 18, 14],
  ];
  expectColumnPositions(alignedRows(cells[0]!, cells.slice(1)), cells, widths);
});

test("empty rows render unpadded final header and header-based widths", () => {
  expect(alignedRows(["BRANCH", "PATH"], [])).toBe("BRANCH  PATH\n");
});

test("column padding uses visible widths for wide and combining characters", () => {
  expect(displayWidth("界")).toBe(2);
  expect(displayWidth("e\u0301")).toBe(1);
  const lines = alignedRows(["BRANCH", "WORKFLOW", "PATH"], [
    ["界", "review", "/wide"],
    ["e\u0301", "-", "/combining"],
  ]).trimEnd().split("\n");
  const column = lines[0]!.indexOf("WORKFLOW");
  expect(displayWidth(lines[1]!.slice(0, lines[1]!.indexOf("review")))).toBe(column);
  expect(displayWidth(lines[2]!.slice(0, lines[2]!.indexOf("-")))).toBe(column);
});
