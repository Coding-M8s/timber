# Timber CLI

A small CLI for creating, opening, listing, and safely cleaning up Git worktrees.

`new` creates a branch and linked worktree, `ls` lists the repository's worktrees,
and `open` reuses an existing worktree or creates one for a resolved existing
branch. `done` safely removes a linked worktree and, when ancestry permits,
its local branch.

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
timber open origin/my-feature
timber open TIM-42
timber open "/absolute/path/to/my-feature-worktree"
timber open my-feature --no-editor
timber ls
timber done my-feature
timber done my-feature --keep-branch
timber done "/absolute/path/to/my-feature-worktree" --discard-ignored
```

### Create a worktree

Run `timber new <branch>` (or `bun run dev new <branch>`) from the primary
checkout, a nested directory, or a linked worktree. Timber creates a new local
branch from `--base <ref>` when supplied, then `base_branch` in the primary
checkout's `.timber.toml`, then the selected remote's default branch, then a
single existing local `main` or `master`. Missing or ambiguous bases fail
without guessing. Git validates the branch name before creation.

By default, Timber places the linked worktree at
`../<repository-name>-worktrees/<safe-branch-slug>` beside the primary checkout.
Set `worktree_dir` in `.timber.toml` to choose another root; relative paths
resolve from the primary checkout. No CLI path override exists. An existing
branch suggests `timber open`; an occupied destination fails without replacing
files or refs.

`--no-editor` skips the configured editor. Otherwise Timber starts it after Git
creates the worktree. Success prints the branch and absolute worktree path. If
editor startup fails, Timber reports the retained workspace and a
`timber open -- '<absolute-worktree-path>'` retry command, and exits nonzero.

### Open a branch or worktree

`timber open <input>` opens a registered worktree when the input identifies one.
Otherwise it resolves an exact local branch, then an exact remote branch, and
then a unique ticket prefix at a delimiter boundary such as `TIM-42-...` or
`TIM-42_...`. An absolute path must identify a registered worktree. If a ticket
prefix matches multiple branches or worktrees, Timber prints every exact
selector and asks you to run `open` again with one of them. An unknown input
returns an error; `open` never invents a branch.

An explicit remote such as `origin/my-feature` selects that remote even when a
local branch has the same name. Unqualified remote branches use `remote` from
`.timber.toml`, or the only configured Git remote when there is exactly one.
Otherwise Timber reports ambiguity. Branch discovery reads Git's cached refs;
an unseen remote branch must be fetched before it can be selected. When Timber
creates a worktree from a remote branch, it refreshes only that selected remote
branch first. Refresh failures remain errors and leave the selected branch
uncreated. An already registered worktree opens offline, including a dirty or
locked worktree; Timber preserves its contents and Git state.

When an existing local or remote branch has no worktree, `open` creates one at
the configured `worktree_dir` or at the default sibling path
`../<repository-name>-worktrees/<safe-branch-slug>`. Relative
`worktree_dir` values resolve from the primary repository root, even when
`open` runs from a nested directory or linked worktree.

### Finish a worktree

Run `timber done <branch-or-worktree>` (or `bun run dev done <branch-or-worktree>`)
with an exact branch name, an absolute registered worktree path, or a unique
ticket prefix such as `TIM-42`. Target resolution follows `open`, including
explicit remote selectors that identify a local worktree tracking that remote
branch. Ambiguous input lists every candidate and requires an exact branch name or
absolute worktree path; the command never prompts. A branch without a worktree is refused.
The primary worktree is always protected.

By default, the linked worktree must have no modified or untracked files, no
ignored content, and its commit must be contained in the validated base before
Timber removes it and deletes its local branch. The base uses the primary
checkout's `.timber.toml` and the normal base selection policy. Timber checks
fresh Git state immediately before removal. Refusals describe the affected
files, commits, or missing publication/ancestry evidence; they never print file
contents.

`--keep-branch` retains the local branch and also permits removal of a clean,
published but unmerged worktree. Publication requires live upstream evidence;
cached remote-tracking refs or a closed PR alone do not prove safety. Unpublished
or unknown publication blocks removal unless the commit is already contained
in the validated base. Squash/rebase merges do not prove ancestry: retain a
safely published branch with `--keep-branch`, or leave the worktree in place.
A detached worktree can be removed by absolute path only when its commit is
contained in the validated base.

Ignored files, including `.env` and ignored directories, are preserved unless
you explicitly pass `--discard-ignored`. That option allows their removal with
the selected worktree; it never bypasses modified/untracked or commit safety
checks. Neither option overrides locks, stale metadata, or identity checks.
There is no `--force`, automatic stash, remote branch deletion, or process
killing.

Success names the removed path and the deleted or retained local branch.
If removal succeeds but branch deletion fails, Timber exits nonzero, reports
the observed partial result on stderr, and does not claim completion. Inspect
the reported Git state before retrying. Remote branches, the primary checkout,
and unrelated worktrees stay intact.

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

Editor opening stays off when `[editor]` is absent. When `open` selects or creates a worktree, Timber starts the configured editor after the required Git work; `--no-editor` skips it for that invocation. Set `command` to an executable available on Timber's `PATH`, or provide its absolute path. Each `args` entry is passed literally as a separate argument, and Timber appends the absolute worktree path at the end.

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

Timber preserves configured flags such as `--wait`, but returns as soon as the editor process starts. It does not wait for the editor window to close or report a nonzero exit that happens after startup. If startup fails, Timber keeps the worktree, reports the problem on stderr, and prints a safe retry command such as `timber open -- '<worktree path>'`. Since Git work completed, the command still succeeds. Fix the editor command or `PATH`, then run that command to reopen the existing worktree; the retry does not create another one.

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
