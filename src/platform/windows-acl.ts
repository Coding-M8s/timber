import { win32 } from "node:path";

/** Accounts besides the person that private storage may grant: SYSTEM and Administrators. */
const trustedServiceSids = ["S-1-5-18", "S-1-5-32-544"];

export interface WindowsAce { type: number; flags: number; sid: string | null }
export interface WindowsSecurity { owner: string | null; dacl: WindowsAce[] | null }

const accessAllowed = 0x00;
const accessAllowedCallback = 0x09;
/** Deny entries never grant access, whatever their layout. */
const accessDenied = new Set([0x01, 0x06, 0x0a, 0x0c]);
const daclPresent = 0x0004;
const selfRelative = 0x8000;

function malformed(): never { throw new Error("Malformed security descriptor"); }

function sidAt(bytes: Uint8Array, offset: number): string {
  if (offset < 0 || offset + 8 > bytes.length) malformed();
  const revision = bytes[offset]!;
  const count = bytes[offset + 1]!;
  if (revision !== 1 || count > 15 || offset + 8 + count * 4 > bytes.length) malformed();
  let authority = 0;
  for (let index = 2; index < 8; index++) authority = authority * 256 + bytes[offset + index]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [`S-1-${authority}`];
  for (let index = 0; index < count; index++) parts.push(String(view.getUint32(offset + 8 + index * 4, true)));
  return parts.join("-");
}

/** Read the owner and DACL of a self-relative security descriptor, refusing anything out of bounds. */
export function parseSecurityDescriptor(bytes: Uint8Array): WindowsSecurity {
  if (bytes.length < 20 || bytes[0] !== 1) malformed();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const control = view.getUint16(2, true);
  if ((control & selfRelative) === 0) malformed();
  const ownerOffset = view.getUint32(4, true);
  const daclOffset = view.getUint32(16, true);
  const owner = ownerOffset === 0 ? null : sidAt(bytes, ownerOffset);
  if ((control & daclPresent) === 0 || daclOffset === 0) return { owner, dacl: null };
  if (daclOffset + 8 > bytes.length) malformed();
  const aclSize = view.getUint16(daclOffset + 2, true);
  const count = view.getUint16(daclOffset + 4, true);
  const end = daclOffset + aclSize;
  if (aclSize < 8 || end > bytes.length) malformed();
  const dacl: WindowsAce[] = [];
  let offset = daclOffset + 8;
  for (let index = 0; index < count; index++) {
    if (offset + 4 > end) malformed();
    const type = bytes[offset]!;
    const flags = bytes[offset + 1]!;
    const size = view.getUint16(offset + 2, true);
    if (size < 4 || offset + size > end) malformed();
    const hasSid = type === accessAllowed || type === accessAllowedCallback;
    if (hasSid && size < 16) malformed();
    dacl.push({ type, flags, sid: hasSid ? sidAt(bytes.subarray(0, offset + size), offset + 8) : null });
    offset += size;
  }
  return { owner, dacl };
}

/**
 * The same rule as the PowerShell check: the person owns it and every allow entry, inherited
 * or not, names the person, SYSTEM or Administrators. Stricter where the script was silent:
 * a missing DACL and allow entries of other layouts are refused.
 */
export function privateAclProblem(security: WindowsSecurity, user: string): string | null {
  if (security.owner !== user) return "Unexpected owner";
  if (security.dacl === null) return "Nonprivate ACL";
  for (const ace of security.dacl) {
    if (accessDenied.has(ace.type)) continue;
    if (ace.sid === null) return "Unsupported ACL entry";
    if (ace.sid !== user && !trustedServiceSids.includes(ace.sid)) return "Nonprivate ACL";
  }
  return null;
}

/* Windows API access through bun:ffi, loaded only on Windows. */

const ownerSecurity = 0x1;
const daclSecurity = 0x4;
const reparsePoint = 0x400;
const invalidAttributes = 0xffffffff;
const tokenQuery = 0x8;
const tokenUser = 1;

interface Native {
  attributes(path: Buffer): number;
  security(path: Buffer, buffer: Uint8Array, needed: Uint32Array): boolean;
  user: string;
}

let native: Promise<Native> | undefined;

function wide(value: string): Buffer { return Buffer.from(`${value}\0`, "utf16le"); }

async function loadNative(): Promise<Native> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const advapi = dlopen("advapi32.dll", {
    GetFileSecurityW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    OpenProcessToken: { args: [FFIType.i64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    GetTokenInformation: { args: [FFIType.i64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  const kernel = dlopen("kernel32.dll", {
    GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
    GetCurrentProcess: { args: [], returns: FFIType.i64 },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  });
  const handle = new BigUint64Array(1);
  if (!advapi.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), tokenQuery, ptr(handle))) {
    throw new Error("Cannot read the current account");
  }
  const token = handle[0]!;
  const info = new Uint8Array(1024);
  const length = new Uint32Array(1);
  let read: number;
  try { read = advapi.symbols.GetTokenInformation(token, tokenUser, ptr(info), info.length, ptr(length)); }
  finally { kernel.symbols.CloseHandle(token); }
  if (!read) throw new Error("Cannot read the current account");
  // TOKEN_USER starts with a pointer to a SID stored later in the same buffer.
  const sidPointer = new DataView(info.buffer).getBigUint64(0, true);
  const sidOffset = Number(sidPointer - BigInt(ptr(info)));
  if (sidOffset < 0 || sidOffset >= Math.min(length[0]!, info.length)) throw new Error("Cannot read the current account");
  const user = sidAt(info.subarray(0, length[0]!), sidOffset);
  return {
    attributes: path => kernel.symbols.GetFileAttributesW(ptr(path)),
    security: (path, buffer, needed) => advapi.symbols.GetFileSecurityW(
      ptr(path), ownerSecurity | daclSecurity, ptr(buffer), buffer.length, ptr(needed)) !== 0,
    user,
  };
}

/** Check one path in this process; throws a short reason when it is not private. */
export async function assertWindowsPrivateAcl(path: string): Promise<void> {
  native ??= loadNative();
  let api: Native;
  try { api = await native; }
  catch (error) { native = undefined; throw error; }
  const name = wide(win32.toNamespacedPath(win32.resolve(path)));
  const attributes = api.attributes(name);
  if (attributes === invalidAttributes) throw new Error("Cannot read private storage");
  if ((attributes & reparsePoint) !== 0) throw new Error("Redirected private storage");
  const needed = new Uint32Array(1);
  let buffer = new Uint8Array(4096);
  if (!api.security(name, buffer, needed)) {
    if (needed[0]! <= buffer.length || needed[0]! > 1 << 20) throw new Error("Cannot read private storage ACL");
    buffer = new Uint8Array(needed[0]!);
    if (!api.security(name, buffer, needed)) throw new Error("Cannot read private storage ACL");
  }
  const problem = privateAclProblem(parseSecurityDescriptor(buffer), api.user);
  if (problem !== null) throw new Error(problem);
}
