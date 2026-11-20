import { randomBytes } from "node:crypto";
import { lstat, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { safeDisplay, shellQuoteForDisplay } from "./display";
import type { CommandIO } from "./services";
import type { RepositoryContext, Worktree } from "./types";

/**
 * Handing a created worktree to the Timber app. The app's terminals set
 * TIMBER_APP_HANDOFF to a private folder it watches. In an interactive one,
 * `new` and `open` that create a worktree write one record there in place of
 * running the agent in the invoking terminal, and the app opens the worktree's
 * session: the agent, or a shell. Setup and the editor still run here first.
 */
export const APP_HANDOFF_VARIABLE = "TIMBER_APP_HANDOFF";

/** The one record a handoff writes. Field names follow the --result-file record. */
export interface AppHandoffRecord {
  schemaVersion: 1;
  command: "new" | "open";
  repository: { primaryWorktreeRoot: string };
  worktree: { path: string; branch: string | null };
  /** Whether Timber would have started its configured agent. The app chooses which agent starts. */
  agent: boolean;
}

export interface AppHandoff {
  /** Write the record once. Throws when it cannot be written. */
  handOff(record: AppHandoffRecord): Promise<void>;
}

export interface AppHandoffEnvironment {
  value: string | undefined;
  interactive: boolean;
  /** The current user's id, or undefined where the platform has none. */
  uid: number | undefined;
}

/**
 * The handoff for this process, or null to behave as outside the app. Checked
 * before any command work, so an unusable folder is decided before Git changes.
 * Only an interactive terminal hands off: a tool running Timber without one
 * inside an app session keeps today's behavior and never moves the window.
 */
export async function resolveAppHandoff(environment: AppHandoffEnvironment, io: Pick<CommandIO, "stderr">): Promise<AppHandoff | null> {
  const directory = environment.value;
  if (directory === undefined || directory === "" || !environment.interactive) return null;
  const problem = await folderProblem(directory, environment.uid);
  if (problem !== null) {
    io.stderr(`warning: ${APP_HANDOFF_VARIABLE} ${problem}; running as outside the Timber app.\n`);
    return null;
  }
  return { handOff: record => writeRecord(directory, record) };
}

async function folderProblem(directory: string, uid: number | undefined): Promise<string | null> {
  if (!isAbsolute(directory)) return "is not an absolute path";
  const info = await lstat(directory).catch(() => null);
  if (info === null) return "names a folder that does not exist";
  if (info.isSymbolicLink() || !info.isDirectory()) return "is not a folder";
  if (uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0)) return "is not a private folder of this user";
  return null;
}

async function writeRecord(directory: string, record: AppHandoffRecord): Promise<void> {
  const name = `${Date.now()}-${process.pid}-${randomBytes(6).toString("hex")}`;
  // The app reads only *.json, so it never sees a record half written.
  const temporary = join(directory, `.${name}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`);
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await file.close();
  try {
    await rename(temporary, join(directory, `${name}.json`));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Hand a worktree to the app and say so. A failure keeps the worktree and
 * never starts the agent here instead: it reports the command that opens it.
 * Answers the exit status.
 */
export async function handOffToApp(
  handoff: AppHandoff, command: AppHandoffRecord["command"], repository: RepositoryContext, worktree: Worktree,
  agent: boolean, io: CommandIO,
): Promise<number> {
  try {
    await handoff.handOff({ schemaVersion: 1, command, repository: { primaryWorktreeRoot: repository.primaryWorktreeRoot },
      worktree: { path: worktree.path, branch: worktree.branch }, agent });
  } catch (error) {
    const reason = error instanceof Error && "code" in error ? ` (${String(error.code)})` : "";
    const retry = agent ? ` Start the agent with: timber open --agent --no-editor -- ${shellQuoteForDisplay(worktree.path)}` : "";
    io.stderr(`error: Could not hand the worktree to the Timber app${reason}. Workspace retained at ${safeDisplay(worktree.path)}.${retry}\n`);
    return 1;
  }
  io.stdout(`Opening ${safeDisplay(worktree.path)} in the Timber app${agent ? " with its agent" : ""}.\n`);
  return 0;
}
