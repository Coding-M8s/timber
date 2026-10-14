export interface BashCompletionInput {
  cword: number;
  point: number;
  line: string;
  wordbreaks: string;
  words: readonly string[];
}

export function renderBashCompletion(): string {
  return [
    "_timber_complete() {",
    "  local candidate original_wordbreaks=${COMP_WORDBREAKS-}",
    "  local prefix=\"\" quote_state=unquoted current_word=\"\" current_fragment=\"\"",
    "  local character escaped=0 index delimiter_prefix_length candidate_fragment current_fragment_length completion_suffix encoded_candidate",
    "  local -a candidates=()",
    "  COMPREPLY=()",
    "  compopt +o default +o bashdefault +o dirnames +o nospace +o filenames +o noquote 2>/dev/null || :",
    "  compopt -o noquote 2>/dev/null || :",
    "  if [[ ! $COMP_POINT =~ ^[0-9]+$ ]] || (( ${#COMP_LINE} > 8192 || COMP_POINT > ${#COMP_LINE} )); then return 0; fi",
    "  prefix=${COMP_LINE:0:COMP_POINT}",
    "  for ((index = 0; index < ${#prefix}; index += 1)); do",
    "    character=${prefix:index:1}",
    "    if (( escaped )); then",
    "      if [[ $quote_state == double && $character != \"$\" && $character != $'\\x60' && $character != '\"' && $character != \"\\\\\" ]]; then",
    "        current_word+=\"\\\\$character\"",
    "        current_fragment+=\"\\\\$character\"",
    "      else",
    "        current_word+=$character",
    "        current_fragment+=$character",
    "      fi",
    "      escaped=0",
    "      continue",
    "    fi",
    "    if [[ $quote_state == single ]]; then",
    "      if [[ $character == \"'\" ]]; then quote_state=unquoted; else current_word+=$character; current_fragment+=$character; fi",
    "      continue",
    "    fi",
    "    if [[ $quote_state == double ]]; then",
    "      if [[ $character == '\"' ]]; then quote_state=unquoted; elif [[ $character == \"\\\\\" ]]; then escaped=1; else current_word+=$character; current_fragment+=$character; fi",
    "      continue",
    "    fi",
    "    if [[ $character == \"\\\\\" ]]; then escaped=1; continue; fi",
    "    if [[ $character == \"'\" ]]; then quote_state=single; continue; fi",
    "    if [[ $character == '\"' ]]; then quote_state=double; continue; fi",
    "    if [[ $character == \" \" || $character == $'\\t' || $character == $'\\n' ]]; then current_word=\"\"; current_fragment=\"\"; continue; fi",
    "    if [[ $original_wordbreaks == *\"$character\"* ]]; then current_word+=$character; current_fragment=\"\"; else current_word+=$character; current_fragment+=$character; fi",
    "  done",
    "  if (( escaped )); then return 0; fi",
    "  while IFS= read -r -d '' candidate; do candidates+=(\"$candidate\"); done < <(",
    "    \"${COMP_WORDS[0]}\" completion __query -- \"$COMP_CWORD\" \"$COMP_POINT\" \"$COMP_LINE\" \"$original_wordbreaks\" \"${COMP_WORDS[@]}\" 2>/dev/null",
    "  )",
    "  delimiter_prefix_length=$(( ${#current_word} - ${#current_fragment} ))",
    "  current_fragment_length=${#current_fragment}",
    "  for candidate in \"${candidates[@]}\"; do",
    "    [[ $candidate == \"$current_word\"* ]] || continue",
    "    candidate_fragment=${candidate:delimiter_prefix_length}",
    "    [[ $candidate_fragment == \"$current_fragment\"* ]] || continue",
    "    completion_suffix=${candidate_fragment:current_fragment_length}",
    "    if [[ $quote_state == unquoted ]]; then",
    "      printf -v encoded_candidate '%q' \"$candidate_fragment\"",
    "    else",
    "      encoded_candidate=$current_fragment",
    "      for ((index = 0; index < ${#completion_suffix}; index += 1)); do",
    "        character=${completion_suffix:index:1}",
    "        if [[ $quote_state == single && $character == \"'\" ]]; then",
    "          encoded_candidate+=\"'\\\\''\"",
    "        elif [[ $quote_state == double && ( $character == \"$\" || $character == $'\\x60' || $character == '\"' || $character == \"\\\\\" ) ]]; then",
    "          encoded_candidate+=\"\\\\$character\"",
    "        else",
    "          encoded_candidate+=$character",
    "        fi",
    "      done",
    "    fi",
    "    COMPREPLY+=(\"$encoded_candidate\")",
    "  done",
    "}",
    "complete -F _timber_complete timber",
    "",
  ].join("\n");
}

const maximumLineCharacters = 8192;
const maximumWords = 128;
const maximumWordBytes = 4096;
const forbiddenUnquoted = new Set([
  "$",
  String.fromCharCode(96),
  ";",
  "|",
  "&",
  "<",
  ">",
  "(",
  ")",
  "{",
  "}",
  "*",
  "?",
  "[",
  "]",
  "!",
  "~",
  "#",
]);

function controlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
}

function prefixAtCharacterOffset(line: string, point: number): string | null {
  const characters = Array.from(line);
  if (!Number.isInteger(point) || point < 0 || point > characters.length) return null;
  return characters.slice(0, point).join("");
}

export function decodeBashInput(input: BashCompletionInput): { words: readonly string[]; current: string } | null {
  if (!Number.isInteger(input.cword) || input.cword < 0 || input.cword >= input.words.length
    || input.words.length > maximumWords || Array.from(input.line).length > maximumLineCharacters
    || Buffer.byteLength(input.line, "utf8") > maximumLineCharacters * 4
    || input.wordbreaks.length > 256
    || input.words.some(word => typeof word !== "string" || Buffer.byteLength(word, "utf8") > maximumWordBytes || controlCharacter(word))) {
    return null;
  }

  const prefix = prefixAtCharacterOffset(input.line, input.point);
  if (prefix === null || controlCharacter(prefix)) return null;

  const completed: string[] = [];
  let current = "";
  let active = false;
  let quote: "single" | "double" | null = null;
  const chars = Array.from(prefix);

  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index]!;
    const next = chars[index + 1];

    if (quote === "single") {
      if (character === "'") quote = null;
      else current += character;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === "\\") {
        if (next === undefined) return null;
        if (next === "\n") {
          index += 1;
          continue;
        }
        if (next === "$" || next === String.fromCharCode(96) || next === '"' || next === "\\") {
          current += next;
        } else {
          current += "\\" + next;
        }
        index += 1;
        continue;
      }
      if (character === "$" || character === String.fromCharCode(96)) return null;
      current += character;
      continue;
    }

    if (character === " " || character === "\t" || character === "\n") {
      if (active) {
        completed.push(current);
        current = "";
        active = false;
      }
      continue;
    }
    if (character === "'") {
      quote = "single";
      active = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      active = true;
      continue;
    }
    if (character === "\\") {
      if (next === undefined) return null;
      if (next === "\n") {
        index += 1;
        continue;
      }
      current += next;
      active = true;
      index += 1;
      continue;
    }
    if (forbiddenUnquoted.has(character)) return null;
    current += character;
    active = true;
  }

  return { words: completed, current: active ? current : "" };
}
