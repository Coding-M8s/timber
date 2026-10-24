/** Zsh uses its parsed completion words and quotes matches during insertion. */
export function zshCompletionScript(): string {
  return [
    "# Zsh completion for Timber. Load after compinit with: source <(timber completion zsh)",
    "_timber_complete() {",
    "  emulate -L zsh",
    "  local candidate index prefix",
    "  local -a completed candidates",
    "  for (( index = 2; index < CURRENT; index++ )); do",
    '    completed+=("${(Q)words[index]}")',
    "  done",
    '  prefix="${QIPREFIX}${PREFIX}${compstate[quote]}"',
    '  prefix="${(Q)prefix}"',
    "  while IFS= read -r -d '' candidate; do",
    '    candidates+=("$candidate")',
    '  done < <("${words[1]}" __complete-words -- "$prefix" "${completed[@]}" 2>/dev/null)',
    "  (( ${#candidates[@]} )) && compadd -a candidates",
    "}",
    "compdef _timber_complete timber",
    "",
  ].join("\n");
}
