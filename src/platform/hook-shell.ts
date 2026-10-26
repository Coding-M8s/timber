import { dirname, resolve } from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execa } from "execa";
import { findExecutable } from "./executable";

/** Keep configured POSIX source literal; PowerShell is only the invoking shell. */
export async function hookShell(): Promise<string> {
  if (process.platform !== "win32") return "/bin/sh";
  const git = await findExecutable("git");
  if (!git) throw new Error("Install Git for Windows, including its POSIX shell, before running hooks.");
  const candidates = [resolve(dirname(git), "../bin/sh.exe"), resolve(dirname(git), "../usr/bin/sh.exe")];
  try {
    const result = await execa(git, ["--exec-path"], { stdin: "ignore", timeout: 5_000 });
    candidates.push(resolve(result.stdout, "../../../usr/bin/sh.exe"));
  } catch { /* Report the same bounded, source-free error if no shell is found. */ }
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch { /* Next Git installation layout. */ }
  }
  throw new Error("Cannot locate Git for Windows sh.exe. Install a complete Git for Windows distribution; hook source requires a POSIX shell.");
}
