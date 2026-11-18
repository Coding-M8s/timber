/** Same grammar as install.sh: stable tags and numbered release candidates. */
const tagPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/u;

interface ParsedVersion { core: [number, number, number]; rc: number | null }

function parse(value: string): ParsedVersion | null {
  const match = tagPattern.exec(value);
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    rc: match[4] === undefined ? null : Number(match[4]),
  };
}

/** Installer tag grammar: a leading v is required. */
export function isReleaseTag(value: string): boolean {
  return value.startsWith("v") && tagPattern.test(value);
}

export function isStableTag(value: string): boolean {
  const parsed = value.startsWith("v") ? parse(value) : null;
  return parsed !== null && parsed.rc === null;
}

/** Negative, zero or positive; null when either side is not a release version. */
export function compareVersions(left: string, right: string): number | null {
  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null) return null;
  for (let index = 0; index < 3; index++) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference !== 0) return difference;
  }
  if (a.rc === b.rc) return 0;
  if (a.rc === null) return 1;
  if (b.rc === null) return -1;
  return a.rc - b.rc;
}

/** True only for a stable tag strictly newer than the running version. */
export function isNewerStable(tag: string, running: string): boolean {
  return isStableTag(tag) && (compareVersions(tag, running) ?? 0) > 0;
}
