import { pathKey, samePath } from "../platform/paths";
import { assertPrivateStorage, protectNewStorage } from "../platform/private-storage";
import { constants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { effortLevels } from "./effort";
import { assertWorktreeIdentity, listWorktrees } from "../git/worktrees";
import type { RepositoryContext, Worktree } from "../types";
import type {
  ArenaAttemptRecord,
  ArenaManifest,
  ArenaManifestV2,
  ArenaPlan,
  ArenaPickRecord,
} from "./types";
import {
  arenaNamePattern,
  validateArenaName,
  validateArenaModel,
} from "./participants";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const pathSchema = z.string().refine(isAbsolute);
const markerSchema = z.strictObject({
  version: z.literal(1),
  arenaId: z.uuid(),
  attemptId: z.uuid(),
  commonGitDir: pathSchema,
  path: pathSchema,
  branch: z.string(),
});
const attemptSchema = z.strictObject({
  id: z.uuid(),
  label: z.string().regex(/^[a-z][a-z0-9_-]*-[1-9][0-9]*$/u),
  preset: z.string().regex(arenaNamePattern),
  tool: z.enum(["codex", "claude", "cursor", "wrapper", "manual"]),
  configFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable(),
  branch: z.string(),
  path: pathSchema,
  worktreeGitDir: pathSchema.nullable(),
  stage: z.enum([
    "planned",
    "created",
    "setup-running",
    "ready",
    "launch-running",
    "exited",
    "failed",
  ]),
  failedStage: z.enum(["creation", "setup", "editor", "agent"]).optional(),
  exitCode: z.number().int().min(0).max(255).optional(),
  signal: z
    .string()
    .regex(/^SIG[A-Z0-9]+$/u)
    .nullable()
    .optional(),
});
const manifestV1Schema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  name: z.string().regex(arenaNamePattern),
  primaryWorktreeRoot: pathSchema,
  commonGitDir: pathSchema,
  base: z.strictObject({
    ref: z.string(),
    commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
    source: z.enum(["explicit", "config", "remote-default", "fallback"]),
  }),
  task: z.strictObject({
    file: z.literal("task.txt"),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  attempts: z.array(attemptSchema).min(2),
});

const modelSchema = z
  .string()
  .refine((model) => {
    try {
      validateArenaModel(model);
      return true;
    } catch {
      return false;
    }
  })
  .nullable();
const sourceSchema = z.strictObject({
  kind: z.enum(["local", "remote"]),
  selector: z.string(),
  provenance: z.enum([
    "explicit",
    "ticket",
    "config",
    "remote-default",
    "fallback",
  ]),
  ticketBranchMissing: z.boolean(),
  remote: z.string().min(1).optional(),
});
const manifestV2Schema = manifestV1Schema
  .extend({
    version: z.literal(2),
    source: sourceSchema,
    ticket: z
      .string()
      .regex(/^[A-Z][A-Z0-9]*-[0-9]+$/u)
      .optional(),
    attempts: z
      .array(
        attemptSchema.extend({
          harness: z.enum(["codex", "claude", "cursor", "wrapper", "manual"]),
          model: modelSchema,
          effort: z.enum(effortLevels).nullable().optional(),
          effortEnvironment: z.enum([...effortLevels, "auto", "unrecognized"]).optional(),
          configSource: z.enum(["builtin", "preset", "ordinary", "manual"]),
        }),
      )
      .min(2),
  })
  .refine(
    (record) =>
      record.source.selector === record.base.ref &&
      (record.source.kind === "local"
        ? record.source.remote === undefined &&
          record.source.selector.startsWith("refs/heads/")
        : record.source.remote !== undefined &&
          record.source.selector.startsWith(
            `refs/remotes/${record.source.remote}/`,
          )) &&
      record.attempts.every(
        (a) =>
          a.harness === a.tool &&
          (a.effortEnvironment === undefined || (a.tool === "claude" && a.effort == null)) &&
          (!(a.tool === "manual" || a.tool === "wrapper") ||
            a.model === null) &&
          (!(a.tool === "manual" || a.tool === "wrapper") || a.effort == null) &&
          (a.tool !== "manual" || a.configSource === "manual"),
      ),
  );
const manifestSchema = z.discriminatedUnion("version", [
  manifestV1Schema,
  manifestV2Schema,
]);

/** Existing metadata must be private real directories; never follow redirecting symlinks. */
async function privateDirectory(path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      await protectNewStorage(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("Cannot create private arena metadata directory.");
    }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || (process.platform !== "win32" && (info.mode & 0o077) !== 0))
    throw new Error(
      "Unsafe arena metadata directory; inspect Git directory permissions.",
    );
  await assertPrivateStorage(path, info, true);
}
async function directory(
  repository: RepositoryContext,
  name: string,
  create = false,
): Promise<string> {
  validateArenaName(name);
  const common = await realpath(repository.commonGitDir);
  const timber = join(common, "timber"),
    arenas = join(timber, "arenas"),
    dir = join(arenas, name);
  await privateDirectory(timber, create);
  await privateDirectory(arenas, create);
  return dir;
}
async function readPrivate(path: string, max = Infinity): Promise<Buffer> {
  const before = await lstat(path);
  await assertPrivateStorage(path, before, false);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max || stat.dev !== before.dev || stat.ino !== before.ino
      || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
      throw new Error("Unsafe or oversized arena metadata file.");
    const bytes = await file.readFile();
    if (bytes.length > max)
      throw new Error("Arena metadata grew beyond its size limit.");
    return bytes;
  } finally {
    await file.close();
  }
}
async function writePrivate(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await protectNewStorage(path);
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function atomicRecord(
  dir: string,
  manifest: ArenaManifest,
): Promise<void> {
  if (!manifestSchema.safeParse(manifest).success)
    throw new Error("Invalid arena manifest; state was not saved.");
  const temporary = join(dir, `.manifest-${randomUUID()}.tmp`);
  try {
    await writePrivate(temporary, Buffer.from(JSON.stringify(manifest) + "\n"));
    await rename(temporary, join(dir, "manifest.json"));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
function validateRecord(
  manifest: ArenaManifest,
  repository: RepositoryContext,
  name: string,
  common: string,
): void {
  if (
    manifest.name !== name ||
    !samePath(manifest.commonGitDir, common) ||
    !samePath(manifest.primaryWorktreeRoot, repository.primaryWorktreeRoot) ||
    new Set(manifest.attempts.map((a) => a.id)).size !==
      manifest.attempts.length ||
    new Set(manifest.attempts.map((a) => pathKey(a.path))).size !==
      manifest.attempts.length ||
    new Set(manifest.attempts.map((a) => a.label)).size !==
      manifest.attempts.length ||
    manifest.attempts.some((a) => a.branch !== `arena/${name}/${a.label}`)
  )
    throw new Error(
      "Stale or inconsistent arena manifest; inspect retained state.",
    );
}
async function readArenaRecord(
  repository: RepositoryContext,
  name: string,
  checkLock: boolean,
): Promise<{ manifest: ArenaManifest; taskPath: string }> {
  try {
    const dir = await directory(repository, name);
    await privateDirectory(dir, false);
    if (checkLock) try {
      await lstat(join(dir, "active.lock"));
      throw new Error(
        "Arena is active or has an interrupted invocation lock; inspect before explicit repair.",
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const parsed = manifestSchema.safeParse(
      JSON.parse(
        (await readPrivate(join(dir, "manifest.json"))).toString("utf8"),
      ),
    );
    if (!parsed.success)
      throw new Error("Malformed or unsupported arena manifest.");
    const manifest = parsed.data as ArenaManifest;
    validateRecord(
      manifest,
      repository,
      name,
      await realpath(repository.commonGitDir),
    );
    const taskPath = join(dir, "task.txt");
    if (hash(await readPrivate(taskPath, 1024 * 1024)) !== manifest.task.sha256)
      throw new Error(
        "Arena task snapshot is missing or changed; restore the original snapshot.",
      );
    return { manifest, taskPath };
  } catch (error) {
    if (error instanceof Error && /Arena|arena|manifest/u.test(error.message))
      throw error;
    throw new Error(
      "Cannot read arena record or task snapshot; inspect private Git metadata. Nothing was recreated.",
    );
  }
}

export async function readArena(repository: RepositoryContext, name: string) {
  return readArenaRecord(repository, name, true);
}

/** Arena names with a private record directory, sorted. Never creates storage. */
export async function listArenaNames(repository: RepositoryContext): Promise<string[]> {
  const common = await realpath(repository.commonGitDir);
  const timber = join(common, "timber"), arenas = join(timber, "arenas");
  for (const path of [timber, arenas]) {
    try { await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    await privateDirectory(path, false);
  }
  const entries = await readdir(arenas, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory() && arenaNamePattern.test(entry.name))
    .map(entry => entry.name).sort();
}

export interface ArenaObservation {
  manifest: ArenaManifest;
  taskPath: string;
  /** An invocation lock exists: an arena command is running or was interrupted. */
  active: boolean;
  /** When the private task snapshot was written, which happens once, at reservation. */
  createdAt: string | null;
}

/** Read a record without taking or requiring the lock; changes nothing. */
export async function observeArena(repository: RepositoryContext, name: string): Promise<ArenaObservation> {
  const { manifest, taskPath } = await readArenaRecord(repository, name, false);
  const dir = await directory(repository, name);
  let active = true;
  try { await lstat(join(dir, "active.lock")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") active = false; }
  const createdAt = await lstat(taskPath).then(info => info.mtime.toISOString(), () => null);
  return { manifest, taskPath, active, createdAt };
}

export type ArenaResumeSession = Pick<ArenaSession, "manifest" | "taskPath" | "save" | "verifyTask" | "close">;

/** Shared ownership only; creation's bind/base assumptions do not belong to resume. */
function ownedArenaSession(
  repository: RepositoryContext, name: string, dir: string, token: string, manifest: ArenaManifest,
): { session: ArenaResumeSession; assertOwned(): Promise<void> } {
  const lock = join(dir, "active.lock"), taskPath = join(dir, "task.txt");
  let closed = false;
  const assertOwned = async () => {
    await directory(repository, name);
    await privateDirectory(dir, false);
    if (closed || (await readPrivate(lock, 100)).toString() !== token)
      throw new Error("Arena invocation lock changed; retained state requires inspection.");
  };
  return { assertOwned, session: {
    manifest, taskPath,
    async save() {
      await assertOwned();
      validateRecord(manifest, repository, name, await realpath(repository.commonGitDir));
      await atomicRecord(dir, manifest);
    },
    async verifyTask() {
      await assertOwned();
      if (hash(await readPrivate(taskPath, 1024 * 1024)) !== manifest.task.sha256)
        throw new Error("Arena task snapshot changed; no external action was started.");
    },
    async close() {
      if (closed) return;
      await assertOwned();
      await unlink(lock);
      closed = true;
    },
  } };
}

function lockStorageFailure(error: unknown, inspect = false): Error {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const reason = code === "EACCES" || code === "EPERM" ? "permission denied"
    : code === "ENOSPC" || code === "EDQUOT" ? "storage is full"
    : code === "EIO" ? "I/O error" : "filesystem operation failed";
  return new Error(`Cannot initialize arena invocation lock: ${reason}. No setup or launch started.${inspect ? " Lock cleanup could not be verified; inspect private metadata before retrying." : " Fix storage permissions/capacity and retry."}`);
}

/** Failed initialization may remove only the exact file created by this open. */
async function acquireResumeLock(path: string, token: string): Promise<void> {
  let file;
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP")
      throw new Error("Arena is active or has an interrupted/unsafe invocation lock; inspect before explicit repair.");
    throw lockStorageFailure(error);
  }
  let identity: { dev: number; ino: number } | undefined;
  try {
    identity = await file.stat();
    await protectNewStorage(path);
    await file.writeFile(Buffer.from(token));
    await file.sync();
    await file.close();
  } catch (error) {
    let retained = true;
    try {
      const current = await lstat(path);
      if (identity && current.isFile() && current.dev === identity.dev && current.ino === identity.ino) {
        await unlink(path);
        retained = false;
      }
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") retained = false;
    }
    await file.close().catch(() => {});
    throw lockStorageFailure(error, retained);
  }
}

/** Acquire a new lock for an existing record, then revalidate the chooser snapshot. */
export async function openArenaForResume(
  repository: RepositoryContext, name: string, expected: ArenaManifest,
): Promise<ArenaResumeSession> {
  const dir = await directory(repository, name);
  await privateDirectory(dir, false);
  const lock = join(dir, "active.lock"), token = randomUUID();
  await acquireResumeLock(lock, token);
  try {
    const { manifest } = await readArenaRecord(repository, name, false);
    if (!isDeepStrictEqual(manifest, expected))
      throw new Error("Arena record changed since selection; rerun resume to review current state.");
    return ownedArenaSession(repository, name, dir, token, manifest).session;
  } catch (error) {
    // Never remove a lock replaced by another invocation or explicit external repair.
    if ((await readPrivate(lock, 100).catch(() => null))?.toString() === token)
      await unlink(lock);
    throw error;
  }
}

const pickSchema = z.strictObject({
  version: z.literal(1), arenaId: z.uuid(), winnerId: z.uuid(),
  archives: z.array(z.strictObject({
    attemptId: z.uuid(), ref: z.string().regex(/^refs\/timber\/arena\//u), commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  })),
});

function validatePick(value: unknown, manifest: ArenaManifest): ArenaPickRecord {
  const result = pickSchema.safeParse(value);
  if (!result.success) throw new Error("Malformed arena pick record; inspect private metadata.");
  const pick = result.data;
  const member = (id: string) => manifest.attempts.some(a => a.id === id);
  if (pick.arenaId !== manifest.id || !member(pick.winnerId) || pick.archives.some(a => !member(a.attemptId)))
    throw new Error("Stale or inconsistent arena pick record; inspect private metadata.");
  return pick;
}

/** Sidecar leaves historical V1/V2 manifests and lifecycle outcomes unchanged. */
export async function readArenaPick(repository: RepositoryContext, name: string, manifest: ArenaManifest): Promise<ArenaPickRecord | null> {
  const dir = await directory(repository, name);
  await privateDirectory(dir, false);
  const path = join(dir, "pick.json");
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try { return validatePick(JSON.parse((await readPrivate(path)).toString("utf8")), manifest); }
  catch { throw new Error("Unsafe, malformed, or stale arena pick record; inspect private metadata."); }
}

export interface ArenaPickSession {
  pick: ArenaPickRecord | null;
  savePick(): Promise<void>;
  verify(): Promise<void>;
  close(): Promise<void>;
}

export async function openArenaForPick(
  repository: RepositoryContext, name: string, expected: ArenaManifest, expectedPick: ArenaPickRecord | null,
): Promise<ArenaPickSession> {
  const lock = await openArenaForResume(repository, name, expected);
  let savedPick = structuredClone(expectedPick);
  const dir = await directory(repository, name);
  const verify = async () => {
    await lock.verifyTask();
    const current = await readArenaRecord(repository, name, false);
    if (!isDeepStrictEqual(current.manifest, expected) ||
        !isDeepStrictEqual(await readArenaPick(repository, name, expected), savedPick))
      throw new Error("Arena records changed since review; inspect before retrying pick.");
  };
  try { await verify(); }
  catch (error) { await lock.close(); throw error; }
  const session: ArenaPickSession = {
    pick: structuredClone(expectedPick), verify, close: () => lock.close(),
    async savePick() {
      await verify();
      const pick = validatePick(session.pick, expected);
      const temporary = join(dir, `.pick-${randomUUID()}.tmp`);
      try {
        await writePrivate(temporary, Buffer.from(JSON.stringify(pick) + "\n"));
        await verify();
        await rename(temporary, join(dir, "pick.json"));
        savedPick = structuredClone(pick);
      } finally { await unlink(temporary).catch(() => {}); }
    },
  };
  return session;
}

export interface ArenaSession {
  manifest: ArenaManifest;
  taskPath: string;
  save(): Promise<void>;
  bind(attemptId: string, worktree: Worktree): Promise<void>;
  verifyTask(): Promise<void>;
  close(): Promise<void>;
}
export async function reserveArena(
  repository: RepositoryContext,
  plan: ArenaPlan,
  task: Uint8Array,
): Promise<ArenaSession> {
  const dir = await directory(repository, plan.name, true);
  try {
    await mkdir(dir, { mode: 0o700 });
    await protectNewStorage(dir);
  } catch {
    throw new Error(
      "Arena already exists or cannot be reserved; inspect retained state or choose another name.",
    );
  }
  const lock = join(dir, "active.lock"),
    token = randomUUID();
  const inferredRemote = [...repository.remotes]
    .sort((a, b) => b.name.length - a.name.length)
    .find((remote) => plan.base.ref.startsWith(`refs/remotes/${remote.name}/`));
  const manifest: ArenaManifestV2 = {
    version: 2,
    source: plan.source ?? {
      kind: inferredRemote ? "remote" : "local",
      selector: plan.base.ref,
      provenance: plan.base.source,
      ticketBranchMissing: false,
      ...(inferredRemote ? { remote: inferredRemote.name } : {}),
    },
    ...(plan.ticket === undefined ? {} : { ticket: plan.ticket }),
    id: randomUUID(),
    name: plan.name,
    primaryWorktreeRoot: repository.primaryWorktreeRoot,
    commonGitDir: await realpath(repository.commonGitDir),
    base: plan.base,
    task: { file: "task.txt", sha256: hash(task) },
    attempts: plan.attempts.map((a) => ({
      id: a.id,
      label: a.label,
      preset: a.preset,
      tool: a.tool,
      harness: a.tool,
      model: a.model ?? null,
      ...(a.effort == null ? {} : { effort: a.effort }),
      ...(a.effortEnvironment === undefined ? {} : { effortEnvironment: a.effortEnvironment }),
      configSource:
        a.configSource ??
        (a.tool === "manual"
          ? "manual"
          : a.preset === "configured"
            ? "ordinary"
            : "preset"),
      configFingerprint: a.configFingerprint,
      branch: a.branch,
      path: a.path,
      worktreeGitDir: null,
      stage: "planned",
    })),
  };
  const taskPath = join(dir, "task.txt");
  try {
    await writePrivate(lock, Buffer.from(token));
    await writePrivate(taskPath, task);
    await atomicRecord(dir, manifest);
  } catch {
    throw new Error(
      "Arena reservation was incomplete; private records were retained. Inspect Git metadata before choosing another name. No worktrees were created.",
    );
  }
  const { session: owned, assertOwned } = ownedArenaSession(repository, plan.name, dir, token, manifest);
  const session: ArenaSession = {
    ...owned,
    async bind(attemptId, worktree) {
      await assertOwned();
      const attempt = manifest.attempts.find((a) => a.id === attemptId);
      if (
        !attempt ||
        !samePath(attempt.path, worktree.path) ||
        attempt.branch !== worktree.branch ||
        worktree.head !== manifest.base.commit ||
        worktree.isPrimary
      )
        throw new Error(
          "Created arena attempt does not match its planned identity or base commit.",
        );
      await assertWorktreeIdentity(repository, worktree);
      const result = await execa("git", ["rev-parse", "--absolute-git-dir"], {
        cwd: worktree.path,
        reject: false,
      });
      if (result.exitCode !== 0)
        throw new Error("Cannot identify arena worktree Git metadata.");
      const admin = await realpath(result.stdout),
        timber = join(admin, "timber");
      await privateDirectory(timber, true);
      const marker = {
        version: 1,
        arenaId: manifest.id,
        attemptId: attempt.id,
        commonGitDir: manifest.commonGitDir,
        path: attempt.path,
        branch: attempt.branch,
      };
      await writePrivate(
        join(timber, "arena.json"),
        Buffer.from(JSON.stringify(marker) + "\n"),
      );
      attempt.worktreeGitDir = admin;
      attempt.stage = "created";
      await session.save();
    },
  };
  return session;
}

export async function validateArenaAttempt(
  repository: RepositoryContext,
  manifest: ArenaManifest,
  attempt: ArenaAttemptRecord,
): Promise<Worktree> {
  try {
    if (
      !samePath(manifest.commonGitDir, await realpath(repository.commonGitDir)) ||
      !manifest.attempts.some(
        (a) =>
          a.id === attempt.id &&
          samePath(a.path, attempt.path) &&
          a.branch === attempt.branch,
      )
    )
      throw new Error("membership");
    const worktree = (await listWorktrees(repository)).find(
      (w) =>
        samePath(w.path, attempt.path) && w.branch === attempt.branch && !w.isPrimary,
    );
    if (!worktree || attempt.worktreeGitDir === null)
      throw new Error("missing");
    await assertWorktreeIdentity(repository, worktree);
    const result = await execa("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: worktree.path,
      reject: false,
    });
    if (
      result.exitCode !== 0 ||
      !samePath(await realpath(result.stdout), attempt.worktreeGitDir)
    )
      throw new Error("replaced");
    const markerDir = join(attempt.worktreeGitDir, "timber");
    await privateDirectory(markerDir, false);
    const marker = markerSchema.parse(
      JSON.parse(
        (await readPrivate(join(markerDir, "arena.json"), 4096)).toString(
          "utf8",
        ),
      ),
    );
    if (
      marker.arenaId !== manifest.id ||
      marker.attemptId !== attempt.id ||
      !samePath(marker.commonGitDir, manifest.commonGitDir) ||
      !samePath(marker.path, attempt.path) ||
      marker.branch !== attempt.branch
    )
      throw new Error("marker");
    return worktree;
  } catch {
    throw new Error(
      "Arena attempt identity is missing, stale, or replaced; inspect Git worktrees and private markers. Nothing was recreated.",
    );
  }
}
