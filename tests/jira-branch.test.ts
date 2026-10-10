import { expect, test } from "bun:test";
import { isJiraTicketKey, jiraBranchName } from "../src/jira/branch";

test("recognizes only complete uppercase Jira ticket keys", () => {
  expect(isJiraTicketKey("ABU-834")).toBe(true);

  for (const input of ["ABU-834-fix", "abu-834", "ABU/834", " ABU-834", "ABU-", "", "ABU-834\n", "ABU-834\r", "ABU-834\r\n"]) {
    expect(isJiraTicketKey(input)).toBe(false);
  }
});

test("normalizes an issue summary into an ASCII branch suffix", () => {
  expect(jiraBranchName("ABU-834", "Fix café / login!")).toBe("ABU-834-fix-cafe-login");
});

test("uses issue when a nonblank summary has no ASCII slug characters", () => {
  expect(jiraBranchName("ABU-834", "修復 🔧")).toBe("ABU-834-issue");
  expect(jiraBranchName("ABU-834", "!!!")).toBe("ABU-834-issue");
});

test("converts controls and punctuation to single separators", () => {
  expect(jiraBranchName("ABU-834", "Fix\tlogin\n flow\u0000now")).toBe("ABU-834-fix-login-flow-now");
});

test("caps the complete branch name at 120 characters", () => {
  const name = jiraBranchName("ABU-834", "a".repeat(500));

  expect(name).toBe(`ABU-834-${"a".repeat(112)}`);
  expect(name.length).toBe(120);
});

test("truncates only the slug and removes a separator at the truncation boundary", () => {
  const name = jiraBranchName("ABU-834", `${"a".repeat(111)} ${"b".repeat(20)}`);

  expect(name).toBe(`ABU-834-${"a".repeat(111)}`);
});

test("rejects invalid keys and blank summaries", () => {
  expect(() => jiraBranchName("ABU-834\nsecret-marker", "Fix login")).toThrow("Invalid Jira ticket key.");
  expect(() => jiraBranchName("abu-834", "Fix login")).toThrow(/invalid.*ticket key/i);
  expect(() => jiraBranchName("ABU-834", " \t\n ")).toThrow(/summary.*blank/i);
});

test("rejects keys that leave no room for a suffix", () => {
  expect(() => jiraBranchName(`ABU-${"1".repeat(115)}`, "Fix login")).toThrow(/ticket key.*long/i);
});

test("returns the same branch name for repeated calls", () => {
  const expected = "ABU-834-fix-cafe-login";

  expect(jiraBranchName("ABU-834", "Fix café / login!")).toBe(expected);
  expect(jiraBranchName("ABU-834", "Fix café / login!")).toBe(expected);
});
