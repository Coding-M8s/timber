import { expect } from "bun:test";

/** Widths are fixture facts, independent of the production width classifier. */
export function expectColumnPositions(
  output: string, cells: readonly (readonly string[])[], cellWidths: readonly (readonly number[])[],
): void {
  const lines = output.split("\n");
  expect(lines.pop()).toBe("");
  expect(lines).toHaveLength(cells.length);
  const widths = cells[0]!.map((_, column) => Math.max(...cellWidths.map(row => row[column]!)));
  const starts = widths.map((_, column) => widths.slice(0, column).reduce((sum, width) => sum + width + 2, 0));
  for (const [row, values] of cells.entries()) {
    const line = lines[row]!;
    let offset = 0;
    let visibleColumn = 0;
    for (const [column, cell] of values.entries()) {
      expect(visibleColumn).toBe(starts[column]!);
      expect(line.slice(offset, offset + cell.length)).toBe(cell);
      offset += cell.length;
      visibleColumn += cellWidths[row]![column]!;
      if (column < values.length - 1) {
        const gap = line.slice(offset).match(/^ */u)![0].length;
        expect(gap).toBe(widths[column]! - cellWidths[row]![column]! + 2);
        offset += gap;
        visibleColumn += gap;
      }
    }
    expect(line.slice(offset)).toBe("");
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
  }
}
