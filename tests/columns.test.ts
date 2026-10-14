import { expect, test } from "bun:test";
import { alignedRows, displayWidth } from "../src/columns";

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
