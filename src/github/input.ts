export function parseGithubInput(input: string): { number: number } | null {
  if (!input.startsWith("github:")) return null;
  const value = input.slice(7);
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("Invalid GitHub issue selector. Use github:<positive-number>, for example github:123.");
  }
  return { number: Number(value) };
}
