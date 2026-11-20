import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { z } from "zod";
import { configIssueFields } from "../config";
import { safeDiagnostic } from "../display";

export const appConfigScopes = ["repository", "global"] as const;
export type AppConfigScope = typeof appConfigScopes[number];

// The object branch comes second so a wrong field is named, not the whole union.
const inputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Opaque token from read; null means the file did not exist. */
  revision: z.union([z.null(), z.string().regex(/^[a-f0-9]{64}$/u)]).optional(),
  values: z.record(z.string(), z.unknown()),
  credentials: z.strictObject({
    jira: z.union([z.null(), z.strictObject({ email: z.string(), token: z.string() })]).optional(),
    linear: z.union([z.null(), z.strictObject({ token: z.string() })]).optional(),
  }).optional(),
});

export type AppConfigInput = z.infer<typeof inputSchema>;

/** A rejected draft. Fields name what is wrong and never carry a value. */
export class AppConfigInvalid extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Invalid settings draft: ${fields.join("; ")}. Nothing was saved.`);
  }
}

const unreadable = () => new Error("Cannot read the input file. Supply a regular UTF-8 JSON file of at most 1 MiB, not a symlink.");

/** The private draft file is the only channel for credentials; its content never reaches a diagnostic. */
export async function readAppConfigInput(path: string): Promise<AppConfigInput> {
  let source: string;
  let info: Awaited<ReturnType<typeof lstat>>;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    info = await lstat(path);
    if (!info.isFile() || info.size > 1024 * 1024) throw unreadable();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev) throw unreadable();
    source = await handle.readFile("utf8");
  } catch { throw unreadable(); }
  finally { await handle?.close(); }
  let json: unknown;
  // A parser message can quote the source, so it is replaced, not forwarded.
  try { json = JSON.parse(source); } catch { throw new Error("The input file is not valid JSON. Nothing was saved."); }
  const parsed = inputSchema.safeParse(json);
  if (!parsed.success) throw new AppConfigInvalid(configIssueFields(parsed.error.issues));
  if (parsed.data.credentials !== undefined && process.platform !== "win32"
    && (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0)) {
    throw new Error("An input file that carries credentials must be your own file with mode 0600. Nothing was saved.");
  }
  return parsed.data;
}

/** Every credential value this process could echo: the draft's and the environment overrides. */
export function knownSecrets(env: NodeJS.ProcessEnv, input?: AppConfigInput): string[] {
  const jira = input?.credentials?.jira;
  return [jira?.token, jira?.email, input?.credentials?.linear?.token,
    env.JIRA_API_TOKEN, env.JIRA_EMAIL, env.LINEAR_API_KEY, env.GH_TOKEN, env.GITHUB_TOKEN,
    env.BITBUCKET_API_TOKEN, env.BITBUCKET_EMAIL]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    // Longest first, so one secret containing another is hidden whole.
    .sort((left, right) => right.length - left.length);
}

/** Last line of defence: no diagnostic leaves with a known credential in it. */
export function safeAppDiagnostic(error: unknown, secrets: readonly string[], fallback: string): string {
  let message = error instanceof Error && error.message ? error.message : fallback;
  for (const secret of secrets) message = message.replaceAll(secret, "[hidden]");
  return safeDiagnostic(message);
}
