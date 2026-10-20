import type { ConfigScope, ConfigScopes } from "../config";
import type { ChoiceOption } from "../selection";
import type { RepositoryContext } from "../types";

export interface SetupPrompt {
  /** Full-screen adapters render this context inline with the next question. */
  notice?(message: string, kind?: "error"): void;
  select(message: string, choices: readonly ChoiceOption[], defaultValue: string, options?: { search?: boolean; query?: string }): Promise<string | null>;
  text(message: string, defaultValue?: string): Promise<string | null>;
  /** Must never echo input or display a previous value; absent adapters cannot accept secrets. */
  secret?(message: string): Promise<string | null>;
  confirm(message: string, defaultValue: boolean, options?: { headingLines?: readonly number[]; labelLines?: readonly number[] }): Promise<boolean | null>;
  close(): void;
  signal?: AbortSignal;
}

export interface FileSnapshot {
  path: string;
  source: Buffer | null;
  mode: number;
}

export interface SetupTarget {
  scope: "repository" | "global";
  path: string;
  file: ConfigScope;
  scopes: ConfigScopes;
  repository: RepositoryContext | null;
  branches: readonly string[];
  tracked: boolean;
  exclude: FileSnapshot | null;
}

export class SetupCancelled extends Error {
  constructor() { super("Setup cancelled before saving."); }
}

export class SetupVisibilityError extends Error {}
