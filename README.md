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
timber open my-feature --setup
timber ls
timber done my-feature
timber done my-feature --keep-branch
timber done "/absolute/path/to/my-feature-worktree" --keep-ignored
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
creates the worktree and setup completes. Success prints the branch and absolute worktree path. If
editor startup fails, Timber reports the retained workspace and a
`timber open -- '<absolute-worktree-path>'` retry command, and exits nonzero.

### Create a worktree from Jira

Configure one Jira Cloud site in the primary repository's `.timber.toml`:

```toml
[jira]
site_url = "https://example.atlassian.net"
# Set this for an Atlassian scoped API token:
# cloud_id = "00000000-0000-0000-0000-000000000000"
```

Set `JIRA_EMAIL` and `JIRA_API_TOKEN` in the environment when creating a ticket
branch. Timber reads `process.env` only when `new` resolves a configured ticket
ID; it never opens `.env` files itself. Bun may populate the process environment
from `.env` before Timber starts. Use `bun --no-env-file src/index.ts new ABU-834`
to disable that Bun behavior. Site URL configuration contains no credentials.
Without `cloud_id`, Timber calls the configured site for an unscoped token. With
`cloud_id`, it uses Atlassian's fixed Jira Cloud gateway for a scoped token.
Requests do not follow redirects or retry, and the 10-second timeout includes
reading the issue summary.

Only a complete uppercase key such as `ABU-834` is looked up, and only when
`[jira]` is configured. `timber new ABU-834` looks up the issue and creates a
branch from its canonical key and summary. For example, `Fix café / login!`
becomes `ABU-834-fix-cafe-login`. Timber normalizes the summary into an ASCII
slug and caps the whole branch name at 120 characters. A non-Latin or
punctuation-only summary uses `issue` as its suffix.

The summary becomes part of a Git branch name, which may later be published.
Choose a literal branch such as `feature/ABU-834` when a title would expose
sensitive information. Inputs such as `ABU-834-fix`, lowercase `abu-834`, and
`feature/ABU-834` are always treated as literal branch names.

If a title changes, a later `new ABU-834` can produce a different branch. Use
`timber open ABU-834` to resume an existing matching worktree. `open` uses Git's
local refs and worktree list, so it works offline and does not need Jira
credentials. If several branches match, Timber reports the candidates and asks
for an exact branch or worktree path. Jira URL input and OAuth sign-in are not
supported.

When lookup fails, Timber stops before creating a branch or worktree. For a 401,
check the email, token expiry, and whether the token type matches the configured
API root. A 403 means the account or token lacks access; a 404 means the issue
is unavailable or not visible to that account. A 429 or 5xx response can be
retried later. Network and redirect failures need connectivity or site/token
configuration checks.

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

By default, Timber removes the linked worktree **including ignored files and
folders such as `.env`, `node_modules`, and build output**, then deletes its local
branch when Git proves its changes are integrated into the validated base.
Modified and untracked files always block cleanup. The base uses the primary
checkout's `.timber.toml` and the normal base selection policy. Timber checks
fresh Git state immediately before removal.

Normal merges are proven by commit ancestry. For squash/rebase merges, Timber
also accepts a successful virtual Git merge that would add no file changes to
the validated base. This works after the feature's remote branch has been
deleted, or while offline, when the necessary commits are available locally.
If the base is stale, fetch it explicitly before retrying. A closed PR alone is
not proof. Custom merge drivers, conflicting changes, unsupported Git versions,
or an unavailable proof cannot authorize branch deletion. Virtual merges may
write unreachable Git objects; they do not change files, the index, or refs.

`--keep-branch` retains the local branch. It also permits removal of a clean,
published but unmerged worktree; that path requires live upstream evidence.
Cached remote-tracking refs alone do not prove publication. A detached worktree
can be removed by absolute path only when its commit is contained in the base.

`--keep-ignored` refuses cleanup when ignored files exist. The worktree, branch,
and ignored files remain in their original locations; nothing is copied to a
backup folder. Move those files yourself or retry without the flag to discard
them. `--discard-ignored` remains supported for compatibility and expresses the
default; combining it with `--keep-ignored` is an error. Refusals name affected
paths or commits without printing file contents. Locks, stale metadata, and
identity checks remain enforced. There is no `--force`, automatic stash, remote
branch deletion, or process killing.

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

Editor opening stays off when `[editor]` is absent. When `open` selects or creates a worktree, Timber starts the configured editor after the required Git and setup work; `--no-editor` skips it for that invocation. Set `command` to an executable available on Timber's `PATH`, or provide its absolute path. Each `args` entry is passed literally as a separate argument, and Timber appends the absolute worktree path at the end.

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

### Setup hooks (0.2)

Add trusted shell commands to the primary checkout's `.timber.toml`:

```toml
[hooks]
post_create = [
  "bun install --frozen-lockfile",
  './scripts/setup.sh',
]
```

`new` runs these steps after creating the branch/worktree. `open` runs them when
it creates a worktree for an existing local or remote branch. Reopening an
existing worktree skips setup unless you explicitly pass `--setup`. Missing
hooks, an empty table, or an empty list perform no setup. Only `post_create` is
supported; invalid values and unknown keys are rejected before Git creation.
`--no-editor` skips the editor while still allowing setup.

On the initial Linux target, each step runs sequentially in a fresh
`/bin/sh -c` process with the selected worktree as its working directory.
The shell receives the configured source unchanged; Timber never inserts
branch names, paths, or ticket text into that source. Use POSIX shell syntax
or explicitly invoke another installed shell in a hook. Variables exported
by one step do not persist into the next. There is no implicit `set -e`:
each step succeeds or fails according to its shell exit status. Use `&&`
or a script that returns a nonzero status when required work fails.

Hooks inherit Timber's environment and receive these overrides:

| Variable | Value |
| --- | --- |
| `TIMBER_REPO` | Absolute primary repository root |
| `TIMBER_WORKTREE` | Absolute selected worktree path |
| `TIMBER_BRANCH` | Selected local branch name, or empty for detached HEAD |
| `TIMBER_TASK_ID` | Leading ticket ID such as `TIM-7` in `TIM-7-setup`, `TIM-7/setup`, or `TIM-7`; absent otherwise |

Ticket recognition uses uppercase project letters/digits followed by `-` and
digits, with an end or `-`, `_`, `.`, `/` boundary. An inherited task ID is
removed when the selected branch has none. Quote context variables in hooks,
for example `printf '%s\n' "$TIMBER_BRANCH"`. Standard input is closed so setup
does not wait for interactive answers; configure unattended installation.
Hook stdout and stderr stream to the corresponding invoking streams.

This configuration executes code with your permissions. Trust and review the
primary config and any scripts in the selected branch before running setup.
There is no approval prompt. Keep credentials out of config and shell source;
use environment variables or a secret store, and avoid printing secrets in
hook output. Timber's failure diagnostic identifies the numbered step and
exit status without printing its shell source.

The first failed step stops later hooks and editor startup. Timber exits
nonzero and retains the branch, worktree, and files left by setup, including
modified, untracked, and ignored content. It does not undo changes made by
the hook itself. Fix the hook or its prerequisites, then use the printed
retry command, such as `timber open --setup -- '<absolute-worktree-path>'`.
Retries run **all steps from the beginning**; make hooks safe to rerun.
Normal `open` can reopen the retained workspace without retrying setup.
Agent launching remains deferred to TIM-9 and must follow successful setup.

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
