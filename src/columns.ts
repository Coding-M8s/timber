/** Visible terminal width for the escaped, untruncated text Timber prints. */
export function displayWidth(value: string): number {
  const segments = new Intl.Segmenter("en", { granularity: "grapheme" });
  let width = 0;
  for (const { segment } of segments.segment(value)) {
    const point = segment.codePointAt(0)!;
    if (/^\p{Mark}/u.test(segment)) continue;
    const wide = /\p{Extended_Pictographic}/u.test(segment)
      || /^\p{Regional_Indicator}{2}$/u.test(segment)
      || /^[#*0-9]\ufe0f?\u20e3$/u.test(segment)
      || point >= 0x1100 && (point <= 0x115f || point >= 0x2329 && point <= 0x232a
        || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3
        || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f
        || point >= 0xff01 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6
        || point >= 0x20000 && point <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

export function alignedRows(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) => Math.max(displayWidth(header),
    ...rows.map(row => displayWidth(row[index] ?? ""))));
  const render = (row: readonly string[]) => row.map((cell, index) => index === row.length - 1
    ? cell : cell + " ".repeat(widths[index]! - displayWidth(cell) + 2)).join("");
  return [render(headers), ...rows.map(render)].join("\n") + "\n";
}
