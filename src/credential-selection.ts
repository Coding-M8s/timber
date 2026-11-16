import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { discoverRepository } from "./git/repository";

/** Non-secret names that distinguish saved credentials, such as a workspace or account. */
export const credentialLabelSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/u);
export const defaultCredentialLabel = "default";
export const credentialLabelHint = "Use 1-32 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.";
export const repositoryKeySchema = z.string().refine(value => isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value));

export function validCredentialLabel(label: string): boolean { return credentialLabelSchema.safeParse(label).success; }

/**
 * A repository is its shared Git directory, so the primary checkout and every linked
 * worktree select the same credentials. Separate clones and moved checkouts differ.
 */
export async function repositoryCredentialKey(commonGitDir: string): Promise<string> {
  try { return await realpath(commonGitDir); }
  catch { return resolve(commonGitDir); }
}

export type CredentialSelection =
  | { kind: "selected"; label: string }
  | { kind: "missing" }
  | { kind: "unselected" };

/** One saved entry is the global default; several require an explicit repository association. */
export function selectCredential(labels: readonly string[], association: string | null): CredentialSelection {
  if (association !== null && labels.includes(association)) return { kind: "selected", label: association };
  if (labels.length === 0) return { kind: "missing" };
  if (labels.length === 1) return { kind: "selected", label: labels[0]! };
  return { kind: "unselected" };
}

/** The shared Git directory of the repository at `cwd`, discovered once on first use; undefined outside a repository. */
export function repositoryOf(cwd: string): () => Promise<string | undefined> {
  let found: Promise<string | undefined> | undefined;
  return () => found ??= discoverRepository(cwd).then(repository => repository.commonGitDir, () => undefined);
}
