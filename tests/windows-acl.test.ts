import { expect, test } from "bun:test";
import { parseSecurityDescriptor, privateAclProblem } from "../src/platform/windows-acl";

const user = "S-1-5-21-1000000001-2000000002-3000000003-1001";
const other = "S-1-5-21-1000000001-2000000002-3000000003-1002";
const everyone = "S-1-1-0";
const inherited = 0x10;
const inheritOnly = 0x08;

function sid(value: string): number[] {
  const [, , authority, ...subs] = value.split("-").map(Number);
  const bytes = [1, subs.length, 0, 0, 0, 0, 0, authority!];
  for (const sub of subs) bytes.push(sub & 0xff, (sub >>> 8) & 0xff, (sub >>> 16) & 0xff, (sub >>> 24) & 0xff);
  return bytes;
}

function u16(value: number): number[] { return [value & 0xff, value >>> 8]; }
function u32(value: number): number[] { return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24]; }

interface Entry { type?: number; flags?: number; sid?: string; raw?: number[] }

function ace(entry: Entry): number[] {
  const body = entry.raw ?? [...u32(0x1f01ff), ...sid(entry.sid!)];
  return [entry.type ?? 0, entry.flags ?? 0, ...u16(4 + body.length), ...body];
}

/** A self-relative descriptor: header, owner SID, then the DACL (or none). */
function descriptor(owner: string | null, entries: Entry[] | null): Uint8Array {
  const ownerBytes = owner === null ? [] : sid(owner);
  const aces = (entries ?? []).flatMap(ace);
  const acl = entries === null ? [] : [2, 0, ...u16(8 + aces.length), ...u16(entries.length), 0, 0, ...aces];
  const control = 0x8000 | (entries === null ? 0 : 0x0004);
  const ownerOffset = owner === null ? 0 : 20;
  const daclOffset = entries === null ? 0 : 20 + ownerBytes.length;
  return Uint8Array.from([1, 0, ...u16(control), ...u32(ownerOffset), ...u32(0), ...u32(0), ...u32(daclOffset), ...ownerBytes, ...acl]);
}

const check = (owner: string | null, entries: Entry[] | null) => privateAclProblem(parseSecurityDescriptor(descriptor(owner, entries)), user);
const privateEntries: Entry[] = [{ sid: user }, { sid: "S-1-5-18" }, { sid: "S-1-5-32-544" }];

test("parses owner and allow entries into SID strings", () => {
  expect(parseSecurityDescriptor(descriptor(user, [{ sid: everyone, flags: inherited }]))).toEqual({
    owner: user, dacl: [{ type: 0, flags: inherited, sid: everyone }],
  });
});

test("accepts storage owned by the person and limited to them, SYSTEM and Administrators", () => {
  expect(check(user, privateEntries)).toBeNull();
});

test("refuses an owner that is not the person", () => {
  expect(check(other, privateEntries)).toBe("Unexpected owner");
  expect(check(null, privateEntries)).toBe("Unexpected owner");
});

test("refuses explicit, inherited and inherit-only grants to anyone else", () => {
  expect(check(user, [...privateEntries, { sid: everyone }])).toBe("Nonprivate ACL");
  expect(check(user, [...privateEntries, { sid: other, flags: inherited }])).toBe("Nonprivate ACL");
  expect(check(user, [...privateEntries, { sid: everyone, flags: inheritOnly | 0x03 }])).toBe("Nonprivate ACL");
  expect(check(user, [...privateEntries, { type: 0x09, sid: everyone }])).toBe("Nonprivate ACL");
});

test("ignores deny entries and refuses a missing DACL or an allow entry of another layout", () => {
  expect(check(user, [{ type: 0x01, sid: everyone }, ...privateEntries])).toBeNull();
  expect(check(user, null)).toBe("Nonprivate ACL");
  expect(check(user, [...privateEntries, { type: 0x05, raw: [...u32(0x1f01ff), ...u32(0), ...sid(everyone)] }])).toBe("Unsupported ACL entry");
});

test("refuses descriptors that point outside their bytes", () => {
  const whole = descriptor(user, privateEntries);
  expect(() => parseSecurityDescriptor(whole.subarray(0, whole.length - 4))).toThrow("Malformed security descriptor");
  const badOwner = whole.slice(); badOwner[4] = 0xf0;
  expect(() => parseSecurityDescriptor(badOwner)).toThrow("Malformed security descriptor");
  const absolute = whole.slice(); absolute[3] = 0;
  expect(() => parseSecurityDescriptor(absolute)).toThrow("Malformed security descriptor");
});
