import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
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
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("Cannot create private arena metadata directory.");
    }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error(
      "Unsafe arena metadata directory; inspect Git directory permissions.",
    );
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
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max || (stat.mode & 0o077) !== 0)
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
    manifest.commonGitDir !== common ||
    manifest.primaryWorktreeRoot !== repository.primaryWorktreeRoot ||
    new Set(manifest.attempts.map((a) => a.id)).size !==
      manifest.attempts.length ||
    new Set(manifest.attempts.map((a) => a.path)).size !==
      manifest.attempts.length ||
    new Set(manifest.attempts.map((a) => a.label)).size !==
      manifest.attempts.length ||
    manifest.attempts.some((a) => a.branch !== `arena/${name}/${a.label}`)
  )
    throw new Error(
      "Stale or inconsistent arena manifest; inspect retained state.",
    );
}
export async function readArena(
  repository: RepositoryContext,
  name: string,
): Promise<{ manifest: ArenaManifest; taskPath: string }> {
  try {
    const dir = await directory(repository, name);
    await privateDirectory(dir, false);
    try {
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
  let closed = false;
  const assertOwned = async () => {
    await privateDirectory(dir, false);
    if (closed || (await readPrivate(lock, 100)).toString() !== token)
      throw new Error(
        "Arena invocation lock changed; retained state requires inspection.",
      );
  };
  const session: ArenaSession = {
    manifest,
    taskPath,
    async save() {
      await assertOwned();
      validateRecord(
        manifest,
        repository,
        plan.name,
        await realpath(repository.commonGitDir),
      );
      await atomicRecord(dir, manifest);
    },
    async verifyTask() {
      await assertOwned();
      if (
        hash(await readPrivate(taskPath, 1024 * 1024)) !== manifest.task.sha256
      )
        throw new Error("Arena task snapshot changed; no agent was launched.");
    },
    async bind(attemptId, worktree) {
      await assertOwned();
      const attempt = manifest.attempts.find((a) => a.id === attemptId);
      if (
        !attempt ||
        attempt.path !== worktree.path ||
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
    async close() {
      if (closed) return;
      await assertOwned();
      await unlink(lock);
      closed = true;
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
      manifest.commonGitDir !== (await realpath(repository.commonGitDir)) ||
      !manifest.attempts.some(
        (a) =>
          a.id === attempt.id &&
          a.path === attempt.path &&
          a.branch === attempt.branch,
      )
    )
      throw new Error("membership");
    const worktree = (await listWorktrees(repository)).find(
      (w) =>
        w.path === attempt.path && w.branch === attempt.branch && !w.isPrimary,
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
      (await realpath(result.stdout)) !== attempt.worktreeGitDir
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
      marker.commonGitDir !== manifest.commonGitDir ||
      marker.path !== attempt.path ||
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
