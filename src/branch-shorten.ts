/**
 * Cut `characters` (Unicode code points) to at most `maximum`, preferring the last
 * complete word. Falls back to a hard cut when no whole word fits.
 */
export function shortenAtWord(characters: readonly string[], maximum: number, separators: ReadonlySet<string>): string {
  const trim = (end: number): string => {
    let stop = end;
    while (stop > 0 && separators.has(characters[stop - 1]!)) stop -= 1;
    return characters.slice(0, stop).join("");
  };
  if (characters.length <= maximum) return characters.join("");
  if (separators.has(characters[maximum]!)) {
    const whole = trim(maximum);
    if (whole.length > 0) return whole;
  } else {
    for (let index = maximum - 1; index > 0; index -= 1) {
      if (!separators.has(characters[index]!)) continue;
      const whole = trim(index);
      if (whole.length > 0) return whole;
      break;
    }
  }
  return trim(maximum);
}

/**
 * When `maximum` cuts through a word, return the prefix extended forward to the
 * end of that word (trailing separators removed). Returns undefined when the text
 * fits or the limit already falls on a word boundary.
 */
export function finishWordAt(characters: readonly string[], maximum: number, separators: ReadonlySet<string>): string | undefined {
  if (characters.length <= maximum) return undefined;
  if (separators.has(characters[maximum]!) || separators.has(characters[maximum - 1]!)) return undefined;
  let end = maximum;
  while (end < characters.length && !separators.has(characters[end]!)) end += 1;
  return characters.slice(0, end).join("");
}
