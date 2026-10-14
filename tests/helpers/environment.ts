import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests and their child CLIs must never consume the developer's machine settings
// or write a real first-use marker. Dedicated scope/hint tests supply their own env.
const root = mkdtempSync(join(tmpdir(), "timber-test-machine-"));
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_STATE_HOME = join(root, "state");
mkdirSync(join(root, "state/timber"), { recursive: true });
writeFileSync(join(root, "state/timber/setup-hint-shown"), "1\n");
process.once("exit", () => { rmSync(root, { recursive: true, force: true }); });
