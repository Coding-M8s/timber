import { stringify } from "smol-toml";
import { parseConfigSource } from "../config";
import type { ConfigFile } from "../config";

const examples = {
  editor: '[editor]\ncommand = "code"\nargs = ["--new-window"]\nenabled = false',
  agent: '[agent]\ncommand = "claude"\nargs = []\nenabled = false',
  hooks: '[hooks]\npost_create = ["bun install --frozen-lockfile"]',
  jira: '[jira]\nsite_url = "https://example.atlassian.net"\n# cloud_id = "00000000-0000-4000-8000-000000000000"',
};

export function renderConfig(file: ConfigFile): string {
  const header = "# Timber settings. Keep credentials in the private user store or environment, never this file.\n"
    + "# CLI options > repository settings > machine defaults > built-in defaults.\n"
    + "# Relative worktree_dir paths resolve from the primary repository checkout.\n"
    + '# Automatic/inherited examples: base_branch = "main", remote = "origin"\n'
    + '# worktree_dir = "../my-repository-worktrees"\n\n';
  const source = header + stringify(file) + Object.entries(examples).flatMap(([key, example]) =>
    key in file && file[key as keyof ConfigFile] !== false ? [] : [
      `\n# Optional ${key}: uncomment this example to configure it; remove ${key} = false first.\n`
      + example.split("\n").map(line => `# ${line}`).join("\n") + "\n",
    ]).join("");
  parseConfigSource(source, "generated Timber config");
  return source;
}
