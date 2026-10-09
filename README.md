# Timber CLI

A small CLI for creating, opening, listing, and safely cleaning up Git worktrees.

`ls` lists the repository's worktrees. `new`, `open`, and `done` remain explicit placeholders that exit nonzero without changing Git or files. Worktree operations land in their assigned tickets.

## Development

Each developer needs Bun **1.4.2** (pinned in `.bun-version` and `package.json`)
and Git on their `PATH`. The version declarations do not install Bun. Linux
x86_64 is the verified development target; Node and Docker are not required.

### Install prerequisites

On Ubuntu/Debian, install Git and the utilities needed by Bun's installer:

```bash
sudo apt update
sudo apt install git curl unzip
```

On other Linux distributions, install those packages with your distribution's
package manager. Install the pinned Bun version using the
[official Bun installer](https://bun.com/docs/installation):

```bash
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.2"
export PATH="$HOME/.bun/bin:$PATH"
bun --version # expected: 1.4.2
git --version
```

For Bash, add `export PATH="$HOME/.bun/bin:$PATH"` to `~/.bashrc` so new terminals
can find Bun; use the equivalent startup file for your shell. Restart any running
development or agent terminal after changing its environment.

### Install dependencies and verify

From the repository root:

```bash
bun install --frozen-lockfile
bun run dev --help
bun run typecheck
bun test
bun run build
bun dist/index.js --help
```

`build` creates a Bun JavaScript bundle in `dist/index.js`; it is not a standalone
release binary. Standalone packaging belongs to TIM-17. `src/index.ts` also has a
Bun shebang and is the package's `timber` bin entry. No global installation is
needed for development. GitHub CI runs locked installation, typecheck, tests, build
and bundled help on Ubuntu x86_64. Other platforms are not verified.

## Commands

```bash
timber new my-feature
timber open my-feature
timber ls
timber done my-feature
```

### List worktrees

Run `timber ls` (or `bun run dev ls`) from any nested directory in the primary
or a linked worktree. Timber reads Git's inventory, including worktrees created
manually and outside the default Timber directory. It prints a tab-separated
table with `WORKTREE`, `BRANCH`, `STATUS`, and absolute `PATH` columns, primary
first and linked paths sorted deterministically.

The primary worktree is marked `primary`; detached HEAD shows `(detached HEAD)`.
Dirty status includes modified and untracked file counts. Staged and unstaged
changes to the same file count once; a rename counts as one modified file.
Ignored content is reported separately and does not by itself make Git status
dirty. Missing or inaccessible worktrees stay visible with `unknown` status;
`missing`, `locked`, and `prunable` markers describe their state. Control
characters in paths are escaped so each worktree occupies one row.

Listing works offline and requires no `.timber.toml`. It does not fetch, prune,
refresh the index, open an editor, launch an agent, or change files or refs.

## Repository configuration

Timber reads `.timber.toml` from the primary worktree root. Missing settings use documented defaults, and relative `worktree_dir` values resolve from that root. Agent settings can be configured and retained in 0.1, but launching remains deferred to 0.2. Commands use executable names and argument arrays; keep secrets in environment variables or a secret store. See the [CLI contract](docs/cli-contract.md) for accepted fields, defaults, path resolution, precedence, and validation errors.

Editor opening stays off when `[editor]` is absent. When a `new` or `open` workflow selects a worktree, Timber starts the configured editor after the required Git work; `--no-editor` skips it for that invocation. Set `command` to an executable available on Timber's `PATH`, or provide its absolute path. Each `args` entry is passed literally as a separate argument, and Timber appends the absolute worktree path at the end.

### Zed

```toml
base_branch = "main"
worktree_dir = "../timber-worktrees"

[editor]
command = "zed"
args = ["--new"]

[agent]
enabled = false
command = "claude"
args = []
```

### Visual Studio Code

Use this `[editor]` table instead when you want Visual Studio Code:

```toml
[editor]
command = "code"
args = ["--new-window"]
```

Timber preserves configured flags such as `--wait`, but returns as soon as the editor process starts. It does not wait for the editor window to close or report a nonzero exit that happens after startup. If startup fails, Timber keeps the worktree and prints a safe retry command such as `timber open -- '<worktree path>'`. Fix the editor command or `PATH`, then run that command to reopen the existing worktree; the retry does not create another one. An editor startup failure does not undo completed Git/setup work.

## Release scope

- **0.1 — Worktree CLI:** repository discovery, local/remote branch resolution, four commands, repository configuration, optional editor opening, conservative cleanup.
- **0.2 — Integrations:** trusted setup hooks, optional interactive Claude/Codex launching, Jira lookup. The CLI remains usable without Jira credentials or an AI subscription.
- **1.0 — Stable CLI:** real-repository dogfooding, errors, safety validation, documentation, verified Linux x86_64 packages.

TypeScript and Bun are the development direction, with Commander, Execa, Zod, and smol-toml. Exact dependency versions are pinned in `package.json` and `bun.lock`; compatibility tests exercise them under Bun. No GUI/IDE, Rust rewrite, database, daemon, or plugin framework is included.

## Planning and contribution

- [Implementation tickets](https://github.com/Coding-M8s/timber/issues)
- [Delivery board](https://github.com/orgs/Coding-M8s/projects/2/views/2) · [Timber CLI Project](https://github.com/orgs/Coding-M8s/projects/2)
- [Behavioral contract](docs/cli-contract.md)
- [Shared TypeScript contracts and service seams](docs/shared-contracts.md)
- [Full handoff and scheduling](docs/timber-github-handoff.md)
- [Setup mapping and remaining actions](docs/github-project-setup.json)
- [Development guidance](AGENTS.md)

TIM-11 provides the scaffold and shared contracts. TIM-1 provides Git discovery,
TIM-6 provides configuration, and TIM-14 implements the list command against
those service seams. Use independent ticket branches and PRs with one implementer
and one reviewer.
