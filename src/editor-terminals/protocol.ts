import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { processIdentity as readProcessIdentity } from "./process-identity";

const literal = z.string().refine(value => !value.includes("\0"));
const context = { cwd: literal.refine(isAbsolute), repositoryRoot: literal.refine(isAbsolute),
  branch: literal.nullable(), workflow: literal.optional(),
  /** The editor closes the terminal when the runner exits, so keep a shell open afterwards. */
  hold: z.literal(true).optional() };
export const taskSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...context, kind: z.literal("setup"), hooks: z.array(literal), workflowHooks: z.array(literal) }),
  z.strictObject({ ...context, kind: z.literal("agent"), command: literal.refine(s => s.trim().length > 0), args: z.array(literal) }),
]);
export type TerminalTask = z.infer<typeof taskSchema>;
export const identitySchema = z.strictObject({ pid: z.number().int().positive(), start: z.string().min(1) });
export type ProcessIdentity = z.infer<typeof identitySchema>;
export const startedSchema = z.strictObject({ kind: z.enum(["starting", "spawned"]), identity: identitySchema });
export const resultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("setup-complete") }),
  z.strictObject({ kind: z.literal("setup-failed"), step: z.number().int().positive(),
    phase: z.enum(["ordinary", "workflow"]), reason: z.string() }),
  z.strictObject({ kind: z.literal("startup-failed") }),
]);
export type TaskResult = z.infer<typeof resultSchema>;

/** Kernel start time prevents treating a reused PID as the runner. */
export async function processIdentity(pid = process.pid): Promise<ProcessIdentity | null> {
  return readProcessIdentity(pid);
}

export async function assertPrivate(path: string, directory = false): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
    throw new Error("Editor runner requires private, user-owned request data.");
  }
}

export async function publish(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `${name}.tmp`);
  await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  await rename(temporary, join(directory, name));
}

export async function readStatus<T>(directory: string, name: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const path = join(directory, name);
    await assertPrivate(path);
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw new Error("Invalid editor runner status; inspect the existing editor terminal before retrying.");
  }
}
