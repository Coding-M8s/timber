import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

function xdgRoot(value: string | undefined, home: string, fallback: string): string {
  return value && isAbsolute(value) ? value : join(home, fallback);
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(xdgRoot(env.XDG_CONFIG_HOME, env.HOME || (process.platform === "win32" ? env.USERPROFILE : undefined) || homedir(), ".config"), "timber/config.toml");
}

export function installationMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(xdgRoot(env.XDG_STATE_HOME, env.HOME || (process.platform === "win32" ? env.USERPROFILE : undefined) || homedir(), ".local/state"), "timber/setup-hint-shown");
}
