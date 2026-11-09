type Match = { path: string; order: number };

/** Build once per protection check; return the earliest ignored-list collision. */
export function createIgnoredPathIndex(paths: readonly string[], ignoreCase = process.platform === "win32") {
  const exact = new Map<string, Match>();
  const descendants = new Map<string, Match>();
  const key = (path: string) => ignoreCase ? path.toLowerCase() : path;
  for (const [order, path] of paths.entries()) {
    const normalized = key(path.replace(/\/$/u, ""));
    const match = { path, order };
    if (!exact.has(normalized)) exact.set(normalized, match);
    if (!descendants.has(normalized)) descendants.set(normalized, match);
    for (let slash = normalized.indexOf("/"); slash !== -1; slash = normalized.indexOf("/", slash + 1)) {
      const prefix = normalized.slice(0, slash);
      if (!descendants.has(prefix)) descendants.set(prefix, match);
    }
  }
  return (tracked: string): string | undefined => {
    const normalized = key(tracked);
    // Includes equality and ignored descendants of the tracked path.
    let first = descendants.get(normalized);
    for (let slash = normalized.indexOf("/"); slash !== -1; slash = normalized.indexOf("/", slash + 1)) {
      const ancestor = exact.get(normalized.slice(0, slash));
      if (ancestor !== undefined && (first === undefined || ancestor.order < first.order)) first = ancestor;
    }
    return first?.path;
  };
}
