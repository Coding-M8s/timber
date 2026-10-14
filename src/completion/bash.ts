import type { CompletionRequest } from "./candidates";

/**
 * Decode shell quoting as data, never expand variables or evaluate shell source.
 * Parse the line rather than COMP_WORDS so Bash's colon/equal word breaks and
 * partially quoted/escaped filenames do not split a Timber selector.
 */
export function parseBashCompletion(
  line: string, wordBreaks = "",
): Pick<CompletionRequest, "words" | "prefix"> & {
  quote: "'" | '"' | null; replacementPrefix: string; hasExpansion: boolean;
} {
  const input = line;
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  let replacementPrefix = "";
  let hasExpansion = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (character === "\\" && quote !== "'") {
      const next = input[index + 1];
      if (next !== undefined && (quote === null || ['$', '"', "\\", "\n", String.fromCharCode(96)].includes(next))) {
        if (next !== "\n") {
          word += next;
          started = true;
        }
        index++;
        continue;
      }
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else {
        word += character;
        if (quote === '"' && (character === "$" || character === "!" || character === String.fromCharCode(96))) hasExpansion = true;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/[ \t\n]/u.test(character)) {
      if (started) words.push(word);
      word = "";
      started = false;
      replacementPrefix = "";
      hasExpansion = false;
    } else if (";|&()<>".includes(character)) {
      // A new shell command after a separator; no shell operation is executed.
      words.length = 0;
      word = "";
      started = false;
      replacementPrefix = "";
      hasExpansion = false;
    } else {
      word += character;
      started = true;
      if ("$!*?[{~".includes(character) || character === String.fromCharCode(96)) hasExpansion = true;
      if (wordBreaks.includes(character)) replacementPrefix = word;
    }
  }
  return { words: words.slice(1), prefix: word, quote, replacementPrefix, hasExpansion };
}

/** Explicit quoting keeps substitutions literal, including in an unfinished quote. */
export function formatBashCandidate(candidate: string, quote: "'" | '"' | null): string {
  if (quote === '"') {
    const escaped = candidate.replace(/[\\$"]/gu, "\\$&")
      .replaceAll(String.fromCharCode(96), "\\" + String.fromCharCode(96))
      .replaceAll("!", "\"'!'\"");
    return '"' + escaped + '"';
  }
  const literal = "'" + candidate.replaceAll("'", "'\\''") + "'";
  return /^[a-zA-Z0-9_./=-]+$/u.test(candidate) ? candidate : literal;
}

/** Bash inserts the already quoted selectors without filename processing. */
export function bashCompletionScript(): string {
  return [
    "# Bash completion for Timber. Load with: source <(timber completion bash)",
    "_timber_complete() {",
    '  local candidate line="${COMP_LINE:0:COMP_POINT}"',
    "  COMPREPLY=()",
    "  while IFS= read -r -d '' candidate; do",
    '    COMPREPLY+=("$candidate")',
    '  done < <("${COMP_WORDS[0]}" __complete --bash --word-breaks "$COMP_WORDBREAKS" -- "$line" 2>/dev/null)',
    "}",
    "complete -o noquote -F _timber_complete timber",
    "",
  ].join("\n");
}
