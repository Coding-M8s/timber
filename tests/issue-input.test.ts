import { expect, test } from "bun:test";
import { resolveIssueInput } from "../src/issue-input";
import { parseConfigSource, resolveConfig } from "../src/config";
import type { RepositoryConfig } from "../src/types";

const config: RepositoryConfig = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };
const jira = { siteUrl: "https://example.atlassian.net" };

test("default tracker selects bare keys and explicit selectors override every default", () => {
  expect(resolveIssueInput("97", { ...config, defaultTracker: "github", jira })).toEqual({ kind: "github", number: 97, origin: "default" });
  for (const provider of ["linear", "jira"] as const) {
    expect(resolveIssueInput("ENG-123", { ...config, defaultTracker: provider, jira })).toEqual({ kind: provider, key: "ENG-123", origin: "default" });
  }
  for (const defaultTracker of ["github", "linear", "jira", "none"] as const) {
    const selected = { ...config, defaultTracker, jira };
    expect(resolveIssueInput("github:97", selected)).toEqual({ kind: "github", number: 97, origin: "explicit" });
    expect(resolveIssueInput("linear:ENG-123", selected)).toEqual({ kind: "linear", key: "ENG-123", origin: "explicit" });
    expect(resolveIssueInput("jira:ENG-123", selected)).toEqual({ kind: "jira", key: "ENG-123", origin: "explicit" });
    expect(resolveIssueInput("Fix login", selected)).toEqual({ kind: "literal" });
  }
  // Jira site settings alone no longer make a bare key a Jira issue.
  expect(resolveIssueInput("ENG-123", { ...config, jira })).toEqual({ kind: "literal" });
  expect(resolveIssueInput("ENG-123", config)).toEqual({ kind: "literal" });
  expect(resolveIssueInput("ENG-123", { ...config, defaultTracker: "none", jira })).toEqual({ kind: "literal" });
  expect(resolveIssueInput("ENG-123", { ...config, defaultTracker: "github", jira })).toEqual({ kind: "literal" });
});

test("only raw whole valid selectors trigger a provider", () => {
  for (const input of ["0", "01", "9007199254740992", " 97", "97 ", "eng-123"]) {
    expect(resolveIssueInput(input, { ...config, defaultTracker: "github" })).toEqual({ kind: "literal" });
  }
  for (const input of ["github:0", "github:01", "github:9007199254740992", "github:97 ", "jira:", "jira:ENG-123 extra"]) {
    expect(() => resolveIssueInput(input, config)).toThrow(/Invalid .* selector/u);
  }
});

test("Jira and Linear keys resolve in any case and are uppercased once", () => {
  for (const selected of [config, { ...config, defaultTracker: "github" as const, jira }, { ...config, defaultTracker: "none" as const }]) {
    expect(resolveIssueInput("jira:eng-42", selected)).toEqual({ kind: "jira", key: "ENG-42", origin: "explicit" });
    expect(resolveIssueInput("linear:Eng-42", selected)).toEqual({ kind: "linear", key: "ENG-42", origin: "explicit" });
    expect(resolveIssueInput("jira:a1b-7", selected)).toEqual({ kind: "jira", key: "A1B-7", origin: "explicit" });
  }
  for (const provider of ["linear", "jira"] as const) {
    for (const input of ["eng-42", "Eng-42", "eNG-42"]) {
      expect(resolveIssueInput(input, { ...config, defaultTracker: provider, jira })).toEqual({ kind: provider, key: "ENG-42", origin: "default" });
    }
  }
});

test("a lowercase bare key is a plain branch without a Jira or Linear default", () => {
  for (const selected of [config, { ...config, jira }, { ...config, defaultTracker: "github" as const, jira }, { ...config, defaultTracker: "none" as const, jira }]) {
    expect(resolveIssueInput("eng-42", selected)).toEqual({ kind: "literal" });
  }
});

test("still-invalid keys keep their errors and only ASCII letters are uppercased", () => {
  for (const selected of [config, { ...config, defaultTracker: "jira" as const, jira }]) {
    for (const key of ["42", "eng", "eng-", "-42", "1eng-42", "eng_42", "eng-42x", " eng-42"]) {
      expect(() => resolveIssueInput(`jira:${key}`, selected)).toThrow("Invalid Jira issue selector. Use jira:<KEY>, for example jira:ENG-123.");
      expect(() => resolveIssueInput(`linear:${key}`, selected)).toThrow("Invalid Linear issue selector. Use linear:<KEY>, for example linear:ENG-123.");
    }
    // These uppercase to ASCII keys, but they are not ASCII as typed.
    for (const key of ["\ufb01x-2", "\u017fng-2", "\u0131ng-2"]) {
      expect(() => resolveIssueInput(`jira:${key}`, selected)).toThrow("Invalid Jira issue selector");
      expect(() => resolveIssueInput(`linear:${key}`, selected)).toThrow("Invalid Linear issue selector");
    }
  }
  for (const provider of ["linear", "jira"] as const) {
    for (const input of ["\ufb01x-2", "\u017fng-2", "eng-42 ", "Jira:ENG-42", "JIRA:eng-42"]) {
      expect(resolveIssueInput(input, { ...config, defaultTracker: provider, jira })).toEqual({ kind: "literal" });
    }
  }
});

test("tracker preference inherits, overrides, round trips, and validates both scopes", () => {
  const scope = (source: string) => ({ path: "test.toml", source, values: parseConfigSource(source, "test.toml") });
  expect(resolveConfig({ global: scope(""), local: null }, "/repo")).not.toHaveProperty("defaultTracker");
  for (const provider of ["github", "linear", "jira", "none"] as const) {
    const global = scope(`default_tracker = "${provider}"`);
    expect(resolveConfig({ global, local: scope("") }, "/repo").defaultTracker).toBe(provider);
    expect(resolveConfig({ global, local: scope('default_tracker = "none"') }, "/repo").defaultTracker).toBe("none");
  }
  for (const invalid of ['"unknown-secret"', "false", "true", "123", '""']) {
    expect(() => scope(`default_tracker = ${invalid}`)).toThrow("default_tracker is invalid");
    expect(() => scope(`default_tracker = ${invalid}`)).not.toThrow("unknown-secret");
  }
});
