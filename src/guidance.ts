import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { installationMarkerPath } from "./config-paths";
import type { CommandContext, CommandIO } from "./services";
import type { LoadedCommandConfig, RepositoryConfig } from "./types";

export const installationHint = "Before using Timber, run `timber setup` inside your repository, or `timber setup --global` to configure defaults for this machine.";
export const missingSettingsReminder = "No Timber settings found. Run `timber setup` in this repository or `timber setup --global` to configure editor, agent, hooks, and Jira options.";

export async function showInstallationHint(io: CommandIO, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = installationMarkerPath(env);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, "1\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return;
    // Guidance remains best-effort even when machine state cannot be recorded.
  }
  io.stderr(`${installationHint}\n`);
}

export function commandConfig(loaded: LoadedCommandConfig, context: CommandContext): RepositoryConfig {
  context.settingsMissing = !loaded.localExists && !loaded.globalExists;
  return loaded.config;
}
