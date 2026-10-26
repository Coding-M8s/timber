import { expect, test } from "bun:test";
import { pathKey, samePath, validateWindowsComponent } from "../src/platform/paths";
import { executableCandidates, nativeCommand } from "../src/platform/executable";
import { powershellQuote } from "../src/display";

test("Windows path identities recognize slash and case aliases without changing Unicode", () => {
  expect(pathKey("C:/Work/Équipe/Topic", "win32")).toBe(pathKey("c:\\work\\Équipe\\topic", "win32"));
  expect(samePath("C:/repo", "c:\\repo", "win32")).toBe(true);
  expect(samePath("/Repo", "/repo", "linux")).toBe(false);
});

test("Windows destination names refuse device aliases and lossy filename normalization", () => {
  for (const name of ["CON", "nul.txt", "COM1", "lpt9.log", "topic.", "topic ", "a:b", "a\\b"]) {
    expect(() => validateWindowsComponent(name)).toThrow();
  }
  expect(() => validateWindowsComponent("topic-équipe")).not.toThrow();
});

test("native executable lookup handles PATHEXT, spaces and backslashes", () => {
  expect(executableCandidates("code", { PATH: "C:\\Program Files\\Editor;C:\\Tools", PATHEXT: ".EXE;.CMD" }, "win32"))
    .toEqual(["C:\\Program Files\\Editor\\code", "C:\\Program Files\\Editor\\code.EXE", "C:\\Program Files\\Editor\\code.CMD",
      "C:\\Tools\\code", "C:\\Tools\\code.EXE", "C:\\Tools\\code.CMD"]);
  expect(() => nativeCommand("C:\\Tools\\agent.cmd", "win32")).toThrow("native executable");
  expect(nativeCommand("C:\\Tools\\agent.exe", "win32")).toBe("C:\\Tools\\agent.exe");
  for (const path of ["C:agent.exe", "\\agent.exe", ".\\agent.exe"]) {
    expect(() => nativeCommand(path, "win32")).toThrow("fully qualified");
  }
});

test("PowerShell retry quoting treats dollar, apostrophe and backtick as literal data", () => {
  expect(powershellQuote("C:\\Équipe's repo\\$HOME`x")).toBe("'C:\\Équipe''s repo\\$HOME`x'");
  expect(powershellQuote("a\nb")).toBe("([string][char]97 + [char]10 + [char]98)");
});
