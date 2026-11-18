import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { isStableTag } from "./tag";

export const checkInterval = 24 * 60 * 60 * 1000;

export interface UpdateCache {
  /** Latest stable tag known; absent when no check has succeeded. */
  tag?: string;
  /** Milliseconds since the epoch of the last attempt, successful or not. */
  checkedAt: number;
}

const cacheSchema = z.object({ tag: z.string().optional(), checkedAt: z.number().finite() });

/** Missing, unreadable and corrupt files all read as null; never throws. */
export async function readUpdateCache(path: string): Promise<UpdateCache | null> {
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) return null;
    const { tag, checkedAt } = parsed.data;
    return { checkedAt, ...(tag !== undefined && isStableTag(tag) ? { tag } : {}) };
  } catch {
    return null;
  }
}

export function isFresh(cache: UpdateCache, now: number): boolean {
  const age = now - cache.checkedAt;
  return age < checkInterval && age > -checkInterval;
}

/** Write a private temp file, then rename it into place. Returns false on any failure. */
export async function writeUpdateCache(path: string, cache: UpdateCache): Promise<boolean> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(cache) + "\n", { mode: 0o600 });
    await rename(temporary, path);
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}
