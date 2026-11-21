import { finishWordAt, shortenAtWord } from "../branch-shorten";

const jiraTicketKeyPrefix = /^[A-Z][A-Z0-9]*-[0-9]+/;
const defaultMaxBranchNameLength = 120;

export function isJiraTicketKey(input: string): boolean {
  return jiraTicketKeyPrefix.exec(input)?.[0] === input;
}

const anyCaseTicketKey = /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/;

/**
 * Read a typed Jira or Linear key in any case and return it uppercase, or null.
 * The grammar is checked on the ASCII input first, so characters such as U+FB01
 * that only uppercase into ASCII never become keys.
 */
export function normalizeTicketKey(input: string): string | null {
  return anyCaseTicketKey.test(input) ? input.toUpperCase() : null;
}

export interface GeneratedTicketBranch {
  name: string;
  /** The uncapped generated name, present only when a configured limit shortened it. */
  original?: string;
  /** The name with the word cut by the limit completed; longer than the limit. */
  finished?: string;
}

export function generateTicketBranch(key: string, title: string, maxBranchNameLength?: number): GeneratedTicketBranch {
  const limit = maxBranchNameLength ?? defaultMaxBranchNameLength;
  if (!isJiraTicketKey(key)) throw new Error("Invalid Jira ticket key.");
  if (title.trim().length === 0) throw new Error("Jira summary must not be blank.");
  if (key.length + 2 > limit) {
    throw new Error("Jira ticket key is too long to include a branch suffix.");
  }

  const slug = title.normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "issue";
  const suffixLength = limit - key.length - 1;
  if (slug.length <= suffixLength) return { name: `${key}-${slug}` };
  const suffix = maxBranchNameLength === undefined
    ? slug.slice(0, suffixLength).replace(/-+$/u, "")
    : shortenAtWord(Array.from(slug), suffixLength, new Set(["-"]));
  const result: GeneratedTicketBranch = { name: `${key}-${suffix}`, original: `${key}-${slug}` };
  if (maxBranchNameLength !== undefined) {
    const finished = finishWordAt(Array.from(slug), suffixLength, new Set(["-"]));
    if (finished !== undefined && `${key}-${finished}` !== result.name) result.finished = `${key}-${finished}`;
  }
  return result;
}

/**
 * The branch `timber new` would generate for an issue without asking, or null
 * when it could not: generation fails (for example a blank title), or a
 * configured max_generated_branch_name_length shortened the name, which `new`
 * offers to confirm. The default 120 character cut never prompts, so it is kept.
 */
export function predictTicketBranch(key: string, title: string, maxBranchNameLength?: number): string | null {
  let generated: GeneratedTicketBranch;
  try { generated = generateTicketBranch(key, title, maxBranchNameLength); } catch { return null; }
  if (maxBranchNameLength !== undefined && generated.original !== undefined) return null;
  return generated.name;
}

export function jiraBranchName(key: string, title: string, maxBranchNameLength?: number): string {
  return generateTicketBranch(key, title, maxBranchNameLength).name;
}
