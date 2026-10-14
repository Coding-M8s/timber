import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { installationMarkerPath } from "./config-paths";
import type { CommandIO } from "./services";

export const installationHint = "Before using Timber, run `timber setup` inside your repository, or `timber setup --global` to configure defaults for this machine.";

export async function showInstallationHint(io: CommandIO, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = installationMarkerPath(env);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, "1\n", { flag: "wx", mode: 0o600 });
  } catch {
    // Existing or unwritable state must not turn a one-time hint into repeated noise.
    return;
  }
  io.stderr(`${installationHint}\n`);
}
