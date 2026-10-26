import { readFile } from "node:fs/promises";
import type { ProcessIdentity } from "./protocol";

export function supportsEditorTerminals(platform: NodeJS.Platform, arch: string): boolean {
  return platform === "linux" && arch === "x64"
    || platform === "darwin" && (arch === "arm64" || arch === "x64");
}

// proc_bsdinfo from Apple's sys/proc_info.h has the same 136-byte layout on
// Darwin arm64/x64. Preserve microseconds: ps lstart rounds to whole seconds.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h
export function parseDarwinProcessInfo(pid: number, data: Buffer): ProcessIdentity | null {
  if (data.length !== 136 || data.readUInt32LE(12) !== pid) return null;
  const state = data.readUInt32LE(4);
  const seconds = data.readBigUInt64LE(120);
  const microseconds = data.readBigUInt64LE(128);
  if (state < 1 || state > 4 || seconds === 0n || microseconds >= 1_000_000n) return null;
  return { pid, start: `darwin:${seconds}:${microseconds}` };
}

let darwinReader: Promise<(pid: number, data: Buffer) => number> | undefined;

async function readDarwinIdentity(pid: number): Promise<ProcessIdentity | null> {
  darwinReader ??= (async () => {
    // Load only on Darwin. The system library needs no compiler, helper process
    // or separately installed runtime. Its handle lives for this process.
    const { dlopen, ptr } = await import("bun:ffi");
    const library = dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
    });
    return (target: number, data: Buffer) => library.symbols.proc_pidinfo(target, 3, 0, ptr(data), data.length);
  })();
  const read = await darwinReader;
  const data = Buffer.alloc(136);
  if (read(pid, data) !== data.length) return null;
  return parseDarwinProcessInfo(pid, data);
}

/** Pin a process incarnation; missing, dead or unverifiable processes fail closed. */
export async function processIdentity(pid = process.pid): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null;
  try {
    if (process.platform === "darwin" && supportsEditorTerminals(process.platform, process.arch)) {
      return await readDarwinIdentity(pid);
    }
    if (process.platform !== "linux") return null;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[0] === "X" || !fields[19] ? null : { pid, start: fields[19] };
  } catch { return null; }
}
