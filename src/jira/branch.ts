const jiraTicketKeyPrefix = /^[A-Z][A-Z0-9]*-[0-9]+/;
const maxBranchNameLength = 120;

export function isJiraTicketKey(input: string): boolean {
  return jiraTicketKeyPrefix.exec(input)?.[0] === input;
}

export function jiraBranchName(key: string, title: string): string {
  if (!isJiraTicketKey(key)) throw new Error("Invalid Jira ticket key.");
  if (title.trim().length === 0) throw new Error("Jira summary must not be blank.");
  if (key.length + 2 > maxBranchNameLength) {
    throw new Error("Jira ticket key is too long to include a branch suffix.");
  }

  const slug = title.normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "issue";
  const suffixLength = maxBranchNameLength - key.length - 1;
  const suffix = slug.slice(0, suffixLength).replace(/-+$/u, "");

  return `${key}-${suffix}`;
}
