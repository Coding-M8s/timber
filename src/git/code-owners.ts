import { execa } from "execa";
import { parseGithubReviewer, type ReviewerRequest } from "../github/review-requests";
import type { RepositoryContext } from "../types";
import { isFullCommitHash } from "./commit-base";

/** Why the code owners of a branch could not be read; the message is Timber's own wording. */
export class CodeOwnersFailure extends Error {}

/** Where GitHub looks for the file, in its order; only the first one found is used. */
const locations = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;
/** GitHub ignores a larger CODEOWNERS file. */
const maxCodeOwnersBytes = 3 * 1024 * 1024;
/** GitHub lists at most this many files of a pull request. */
const maxChangedFiles = 3000;
/** One limit for every Git read together. */
const timeoutMs = 10_000;

/** Matching steps left; a huge or hostile file stops the read instead of stalling the command. */
export interface MatchBudget { steps: number }
const maxMatchSteps = 100_000_000;

/** A segment matcher: "any" stands for zero or more whole path segments. */
type Segment = "any" | readonly Glyph[];
type Glyph = { kind: "star" } | { kind: "one" } | { kind: "literal"; value: string };

/** One usable CODEOWNERS line; no owners means the files it matches have none. */
export interface CodeOwnerRule { segments: readonly Segment[]; owners: readonly ReviewerRequest[] }

/**
 * Wildcard match that retries only its latest star, so a hostile pattern costs at most
 * the product of both lengths instead of backtracking like a regular expression.
 */
function wildcard<P, V>(pattern: readonly P[], input: readonly V[], budget: MatchBudget, star: (item: P) => boolean, matches: (item: P, value: V) => boolean): boolean {
  let p = 0, i = 0, lastStar = -1, resume = 0;
  while (i < input.length) {
    if (--budget.steps < 0) throw new CodeOwnersFailure("CODEOWNERS is too large to match against the branch's changed files; code owners were not worked out.");
    if (p < pattern.length && star(pattern[p]!)) { lastStar = p++; resume = i; }
    else if (p < pattern.length && matches(pattern[p]!, input[i]!)) { p++; i++; }
    else if (lastStar >= 0) { p = lastStar + 1; i = ++resume; }
    else return false;
  }
  while (p < pattern.length && star(pattern[p]!)) p++;
  return p === pattern.length;
}

const segmentMatches = (glyphs: readonly Glyph[], text: string, budget: MatchBudget) => wildcard(glyphs, [...text], budget,
  glyph => glyph.kind === "star", (glyph, value) => glyph.kind === "one" || (glyph.kind === "literal" && glyph.value === value));

const oneSegment: Segment = [{ kind: "one" }, { kind: "star" }];

function glyphs(segment: string): Glyph[] {
  const result: Glyph[] = [];
  const characters = [...segment];
  for (let index = 0; index < characters.length; index++) {
    const value = characters[index]!;
    if (value === "\\" && index + 1 < characters.length) result.push({ kind: "literal", value: characters[++index]! });
    else if (value === "*") result.push({ kind: "star" });
    else if (value === "?") result.push({ kind: "one" });
    else result.push({ kind: "literal", value });
  }
  return result;
}

/** The path segments a pattern stands for; null for syntax GitHub does not support in CODEOWNERS. */
function compile(pattern: string): readonly Segment[] | null {
  // Negation, character ranges and an escaped leading # work in gitignore files but not here.
  if (/^!|^\\#|\*\*\*|(?:^|[^\\])[[\]]/u.test(pattern) || pattern === "/") return null;
  let parts = pattern.split("/");
  if (parts[0] === "") parts = parts.slice(1);
  // A single name without a leading slash matches at any depth.
  else if ((parts.length === 1 || (parts.length === 2 && parts[1] === "")) && parts[0] !== "**") parts = ["**", ...parts];
  if (parts.length > 1 && parts.at(-1) === "") parts = [...parts.slice(0, -1), "**"];
  const result: Segment[] = [];
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    // A trailing ** needs something inside the directory; elsewhere it may match nothing.
    if (part === "**") result.push(...(last && index > 0 ? [oneSegment, "any" as const] : ["any" as const]));
    // A lone * covers only direct children; any other ending also covers everything below it.
    else if (part === "*") result.push(oneSegment);
    else result.push(glyphs(part), ...(last ? ["any" as const] : []));
  });
  return result;
}

/** Split at unescaped whitespace and stop at a token that starts a comment. */
function tokens(line: string): string[] {
  const found = line.match(/(?:\\.|[^\s\\]|\\$)+/gu) ?? [];
  const comment = found.findIndex(token => token.startsWith("#"));
  return comment < 0 ? found : found.slice(0, comment);
}

/**
 * The usable lines of a CODEOWNERS file. As on GitHub, a line with invalid syntax is
 * skipped. An email owner keeps its line but is left out, since no login can be requested from it.
 */
export function parseCodeOwners(content: string): CodeOwnerRule[] {
  const rules: CodeOwnerRule[] = [];
  for (const line of content.replace(/^﻿/u, "").split(/\r?\n/u)) {
    const [pattern, ...names] = tokens(line);
    if (pattern === undefined) continue;
    const segments = compile(pattern);
    if (segments === null) continue;
    const owners: ReviewerRequest[] = [];
    let valid = true;
    for (const name of names) {
      const owner = name.startsWith("@") ? parseGithubReviewer(name.slice(1)) : null;
      if (owner !== null) owners.push(owner);
      else if (!/^[^@\s]+@[^@\s]+$/u.test(name)) valid = false;
    }
    if (valid) rules.push({ segments, owners });
  }
  return rules;
}

/** The owners of one path: the last matching line decides, even when it names nobody. */
export function ownersOf(path: string, rules: readonly CodeOwnerRule[], budget: MatchBudget = { steps: maxMatchSteps }): readonly ReviewerRequest[] {
  const parts = path.split("/");
  for (let index = rules.length - 1; index >= 0; index--) {
    const matched = wildcard(rules[index]!.segments, parts, budget, segment => segment === "any",
      (segment, part) => segment !== "any" && segmentMatches(segment, part, budget));
    if (matched) return rules[index]!.owners;
  }
  return [];
}

async function git(repository: RepositoryContext, args: readonly string[], signal: AbortSignal) {
  return execa("git", [...args], {
    cwd: repository.primaryWorktreeRoot, reject: false, stdin: "ignore", cancelSignal: signal, forceKillAfterDelay: 250, maxBuffer: 16 * 1024 * 1024, stripFinalNewline: false,
    // A partial clone must not fetch missing objects; the empty protocol list covers Git without GIT_NO_LAZY_FETCH.
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
  });
}

async function read(repository: RepositoryContext, args: readonly string[], failure: string, signal: AbortSignal): Promise<string> {
  const result = await git(repository, args, signal);
  if (signal.aborted) throw new CodeOwnersFailure("Reading code owners with Git did not finish in time; try again.");
  if (result.exitCode !== 0) throw new CodeOwnersFailure(failure);
  return result.stdout;
}

/**
 * The code owners of the files `head` changed since it left `base`, each once. The file is
 * the one in the base, which is the one GitHub uses for a pull request. Reads local Git
 * objects only: uncommitted changes do not count and nothing is fetched.
 */
export async function readCodeOwners(repository: RepositoryContext, base: string, head: string): Promise<ReviewerRequest[]> {
  if (!isFullCommitHash(base) && !/^refs\/(?:heads|remotes)\/./u.test(base)) throw new CodeOwnersFailure("The saved base is not a branch or a commit.");
  const signal = AbortSignal.timeout(timeoutMs);
  const gitRead = (args: readonly string[], failure: string) => read(repository, args, failure, signal);
  const commit = (await gitRead(["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`],
    "The saved base no longer exists in this repository; fetch it or set another base.")).trim();
  const listing = await gitRead(["ls-tree", "-z", "--full-tree", commit, "--", ...locations], "Cannot read the base's files with Git.");
  const files = new Map(listing.split("\0").filter(Boolean).flatMap(row => {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/su.exec(row);
    // A symlink or directory of that name is not a CODEOWNERS file.
    return match && match[2] === "blob" && match[1] !== "120000" ? [[match[4]!, match[3]!] as const] : [];
  }));
  const location = locations.find(candidate => files.has(candidate));
  if (location === undefined) return [];
  const object = files.get(location)!;
  const size = Number(await gitRead(["cat-file", "-s", object], "Cannot read CODEOWNERS with Git."));
  if (!(size <= maxCodeOwnersBytes)) throw new CodeOwnersFailure("CODEOWNERS is larger than 3 MB, so GitHub does not use it.");
  const rules = parseCodeOwners(await gitRead(["cat-file", "blob", object], "Cannot read CODEOWNERS with Git."));
  if (rules.length === 0) return [];
  const fork = (await gitRead(["merge-base", commit, head],
    "The worktree and its saved base share no commit in this repository.")).trim();
  // Without rename detection both the old and the new path count, so both owners are listed.
  const changed = (await gitRead(["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", fork, head],
    "Cannot read the branch's changed files with Git.")).split("\0").filter(Boolean);
  if (changed.length > maxChangedFiles) {
    throw new CodeOwnersFailure(`The branch changes more than ${maxChangedFiles.toLocaleString("en-US")} files since its base; code owners were not worked out.`);
  }
  const owners = new Map<string, ReviewerRequest>();
  const budget: MatchBudget = { steps: maxMatchSteps };
  for (const path of changed) {
    // Let the network part's timer and answers through between files.
    await new Promise(resolve => setImmediate(resolve));
    for (const owner of ownersOf(path, rules, budget)) {
      const key = `${owner.kind}\0${owner.name.toLowerCase()}`;
      if (!owners.has(key)) owners.set(key, owner);
    }
  }
  return [...owners.values()];
}
