/** The ticket key a branch name starts with, such as GH-123 or ENG-42, if any. */
export function taskIdOf(branch: string | null | undefined): string | undefined {
  return branch?.match(/^([A-Z][A-Z0-9]*-\d+)(?=$|[-_./])/u)?.[1];
}
