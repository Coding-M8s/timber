/** Fish tokenizes the active process; Timber supplies raw NUL-delimited candidates. */
export function fishCompletionScript(): string {
  return [
    "# Fish completion for Timber. Load with: timber completion fish | source",
    "function __timber_tokenize",
    "    read --null --local text",
    "    set -l length (math (string length -- \"$text\") - 1)",
    "    if test $length -gt 0",
    "        set -l words",
    // commandline adds one newline; limit the read without trimming user data.
    '        printf %s "$text" | read --null --nchars $length --tokenize --list words',
    "        if set -q words[1]",
    "            printf '%s\\0' $words",
    "        end",
    "    end",
    "end",
    "function __timber_complete",
    "    set -l tokens (commandline -pc | __timber_tokenize | string split0)",
    "    set -l prefix (commandline -ct | __timber_tokenize | string split0)",
    "    if set -q prefix[1]",
    "        set -e tokens[-1]",
    "    else",
    '        set prefix ""',
    "    end",
    "    if not set -q tokens[1]; return; end",
    "    set -l executable $tokens[1]",
    "    set -e tokens[1]",
    '    command $executable __complete --fish -- "$prefix" $tokens 2>/dev/null | string split0',
    "end",
    "complete -c timber -f -a '(__timber_complete)'",
    "",
  ].join("\n");
}
