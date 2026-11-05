import { expect, test } from "bun:test";
import { resolveIssueInput } from "../src/issue-input";
import { parseConfigSource, resolveConfig } from "../src/config";
import type { RepositoryConfig } from "../src/types";

const config: RepositoryConfig = { baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null };
const jira = { siteUrl: "https://example.atlassian.net" };

test("default tracker overrides legacy Jira and explicit selectors override every default", () => {
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
  expect(resolveIssueInput("ENG-123", { ...config, jira })).toEqual({ kind: "jira", key: "ENG-123", origin: "legacy" });
  expect(resolveIssueInput("ENG-123", config)).toEqual({ kind: "literal" });
  expect(resolveIssueInput("ENG-123", { ...config, defaultTracker: "none", jira })).toEqual({ kind: "literal" });
  expect(resolveIssueInput("ENG-123", { ...config, defaultTracker: "github", jira })).toEqual({ kind: "literal" });
});

test("only raw whole valid selectors trigger a provider", () => {
  for (const input of ["0", "01", "9007199254740992", " 97", "97 ", "eng-123"]) {
    expect(resolveIssueInput(input, { ...config, defaultTracker: "github" })).toEqual({ kind: "literal" });
  }
  for (const input of ["github:0", "github:01", "github:9007199254740992", "github:97 ", "linear:eng-123", "jira:", "jira:ENG-123 extra"]) {
    expect(() => resolveIssueInput(input, config)).toThrow(/Invalid .* selector/u);
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
