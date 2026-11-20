// Shared by the Timber CLI and the Timber VS Code extension bundle.
// Keep this module dependency-free: Node built-ins only, no zod, no vscode.
import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const VSCODE_PROTOCOL = 1;
/** Oldest extension release this CLI accepts. The extension version is independent of the CLI version. */
export const MIN_EXTENSION_VERSION = "0.1.0";
export const EXTENSION_ID = "coding-m8s.timber-terminals";

export const requestIdPattern = /^[0-9a-f]{16}$/u;
export const windowIdPattern = /^[0-9a-f]{16}$/u;
const launchDirectoryPattern = /^\/tmp\/timber-launch-[a-zA-Z0-9]+$/u;

export function spoolDirectory(uid: number): string {
  return `/tmp/timber-vscode-${uid}`;
}

export interface HelloRequest { protocol: number; kind: "hello"; cwd: string; expires: number }
export interface TerminalSpoolRequest {
  protocol: number; kind: "terminal"; cwd: string; expires: number;
  window: string; title: string; shellPath: string; shellArgs: string[];
}
export type SpoolRequest = HelloRequest | TerminalSpoolRequest;
export interface SpoolAck { protocol: number; extensionVersion: string; vscodeVersion: string; window: string; processId?: number }
export type SpoolErrorCode = "protocol" | "invalid" | "create-failed";
export const spoolErrorCodes: readonly SpoolErrorCode[] = ["protocol", "invalid", "create-failed"];

export const spoolNames = (id: string) => ({
  request: `${id}.json`, claimed: `${id}.claimed`, cancelled: `${id}.cancelled`,
  ack: `${id}.ack.json`, error: `${id}.error.json`,
});

/** Private, user-owned, not a symlink. Missing paths are not private. */
export async function isPrivate(path: string, directory: boolean, uid: number): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())
      && stat.uid === uid && (stat.mode & 0o077) === 0;
  } catch { return false; }
}

/** Create the spool if needed, then fail closed unless it is private to this user. */
export async function ensureSpool(path: string, uid: number): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
  }
  if (!await isPrivate(path, true, uid)) {
    throw new Error(`The VS Code terminal spool ${path} is not a private directory owned by this user; remove it and retry.`);
  }
}

/** Write once, privately, then publish atomically. */
export async function publishSpoolFile(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `${name}.tmp`);
  await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  await rename(temporary, join(directory, name));
}

/** Only the exact runner invocations from request.ts are accepted; user values never appear in argv. */
export function validateRunnerArgv(shellPath: unknown, shellArgs: unknown): boolean {
  if (typeof shellPath !== "string" || !Array.isArray(shellArgs) || !shellPath.endsWith("/runtime")) return false;
  const directory = shellPath.slice(0, -"/runtime".length);
  if (!launchDirectoryPattern.test(directory)) return false;
  const expected = [["__editor-task", directory], ["--no-env-file", `${directory}/entry.ts`, "__editor-task", directory]];
  return expected.some(shape => shape.length === shellArgs.length && shape.every((value, index) => shellArgs[index] === value));
}

export type ParsedRequest =
  | { ok: true; request: SpoolRequest }
  | { ok: false; code: "protocol" | "invalid"; cwd: string | null };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");

/** Hand-rolled so the extension bundle stays dependency-free. Unknown keys are invalid. */
export function parseRequest(text: string): ParsedRequest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, code: "invalid", cwd: null }; }
  if (!isObject(value)) return { ok: false, code: "invalid", cwd: null };
  const cwd = isText(value.cwd) && value.cwd.startsWith("/") ? value.cwd : null;
  if (value.protocol !== VSCODE_PROTOCOL) return { ok: false, code: "protocol", cwd };
  const invalid = { ok: false, code: "invalid", cwd } as const;
  if (cwd === null || typeof value.expires !== "number" || !Number.isFinite(value.expires)) return invalid;
  if (value.kind === "hello") {
    if (Object.keys(value).some(key => !["protocol", "kind", "cwd", "expires"].includes(key))) return invalid;
    return { ok: true, request: { protocol: VSCODE_PROTOCOL, kind: "hello", cwd, expires: value.expires } };
  }
  if (value.kind !== "terminal") return invalid;
  const keys = ["protocol", "kind", "cwd", "expires", "window", "title", "shellPath", "shellArgs"];
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid;
  if (!isText(value.window) || !windowIdPattern.test(value.window) || !isText(value.title)
    || !validateRunnerArgv(value.shellPath, value.shellArgs)) return invalid;
  return { ok: true, request: { protocol: VSCODE_PROTOCOL, kind: "terminal", cwd, expires: value.expires,
    window: value.window, title: value.title, shellPath: value.shellPath as string, shellArgs: [...value.shellArgs as string[]] } };
}

export function parseAck(text: string): SpoolAck | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isObject(value) || typeof value.protocol !== "number" || !isText(value.extensionVersion)
    || !isText(value.vscodeVersion) || !isText(value.window) || !windowIdPattern.test(value.window)) return null;
  if (value.processId !== undefined && !(Number.isSafeInteger(value.processId) && (value.processId as number) > 0)) return null;
  return { protocol: value.protocol, extensionVersion: value.extensionVersion, vscodeVersion: value.vscodeVersion,
    window: value.window, ...(value.processId === undefined ? {} : { processId: value.processId as number }) };
}

/** Numeric major.minor.patch comparison; anything else (including prerelease tags) is null. */
export function compareVersions(left: string, right: string): number | null {
  const parse = (version: string) => /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)?.slice(1).map(Number);
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  return 0;
}
