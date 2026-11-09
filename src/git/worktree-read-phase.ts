import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathKey } from "../platform/paths";
import type { RepositoryContext, WorktreeInventory } from "../types";
import { worktreeGitDirectory } from "./worktrees";

export interface WorktreeMetadataLocation {
  directory: string;
  worktreePath: string;
  commonGitDir: string;
  worktreeGitDir: string;
}

/** Invocation-local identity/location reuse. Never carry a phase across hooks,
 * network waits or mutations. Status and preservation evidence are never cached. */
export class WorktreeReadPhase {
  private readonly identities = new Map<string, Promise<string>>();
  private readonly locations = new Map<string, Promise<WorktreeMetadataLocation>>();

  constructor(private readonly repository: RepositoryContext) {}

  private key(tree: WorktreeInventory): string {
    return `${Number(tree.isPrimary)}:${pathKey(tree.path)}`;
  }

  gitDirectory(tree: WorktreeInventory): Promise<string> {
    const key = this.key(tree);
    let identity = this.identities.get(key);
    if (!identity) {
      identity = worktreeGitDirectory(this.repository, tree);
      this.identities.set(key, identity);
    }
    return identity;
  }

  metadataLocation(tree: WorktreeInventory): Promise<WorktreeMetadataLocation> {
    const key = this.key(tree);
    let location = this.locations.get(key);
    if (!location) {
      location = this.gitDirectory(tree).then(async directory => {
        const worktreeGitDir = await realpath(directory);
        return { directory: join(worktreeGitDir, "timber"), worktreePath: resolve(tree.path),
          commonGitDir: await realpath(this.repository.commonGitDir), worktreeGitDir };
      });
      this.locations.set(key, location);
    }
    return location;
  }
}
