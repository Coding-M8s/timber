import { isReleaseTag, isStableTag } from "./tag";
import { readUpdateCache, writeUpdateCache } from "./cache";

export const defaultReleasesUrl = "https://github.com/Coding-M8s/timber/releases";

/** https only, as the installer requires; null when unusable. */
export function releasesBase(env: NodeJS.ProcessEnv): string | null {
  const value = (env.TIMBER_RELEASES_URL || defaultReleasesUrl).replace(/\/+$/u, "");
  return value.startsWith("https://") ? value : null;
}

export type FetchLike = (url: string, init: { method: "GET"; redirect: "manual"; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

/**
 * Plain GET of <releases>/latest, following the redirect by hand to read the tag.
 * No query, no token, and only a generic User-Agent. Returns null on any failure.
 */
export async function resolveLatestTag(env: NodeJS.ProcessEnv, request: FetchLike = fetch as unknown as FetchLike): Promise<string | null> {
  const base = releasesBase(env);
  if (base === null) return null;
  try {
    const response = await request(`${base}/latest`, {
      method: "GET", redirect: "manual", headers: { "User-Agent": "timber" }, signal: AbortSignal.timeout(10_000),
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return null;
    const tag = new URL(location, `${base}/latest`).pathname.split("/").filter(Boolean).pop() ?? "";
    return isReleaseTag(tag) ? tag : null;
  } catch {
    return null;
  }
}

export interface CheckDeps {
  env: NodeJS.ProcessEnv;
  cachePath: string;
  now(): number;
  fetch?: FetchLike;
}

/**
 * One check. Always records the check time, so a failure is retried no sooner than
 * the next interval; the cached tag survives a failure. Returns the stable tag found.
 */
export async function refreshUpdateCache(deps: CheckDeps): Promise<string | null> {
  const previous = await readUpdateCache(deps.cachePath);
  const found = await resolveLatestTag(deps.env, deps.fetch);
  const tag = found !== null && isStableTag(found) ? found : null;
  const kept = tag ?? previous?.tag;
  await writeUpdateCache(deps.cachePath, { checkedAt: deps.now(), ...(kept === undefined ? {} : { tag: kept }) });
  return tag;
}
