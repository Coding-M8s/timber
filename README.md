# Timber CLI

A small CLI for creating, opening, listing, and safely cleaning up Git worktrees.

`new` creates a branch and linked worktree, `ls` lists the repository's worktrees,
and `open` reuses an existing worktree or creates one for a resolved existing
branch. `done` safely removes a linked worktree and deletes its local branch
only when Git proves its commits are published to the live upstream or
integrated into the validated base.

## Install the standalone CLI

Release assets run without Bun or Node. Git must be installed and available on
`PATH`; configured editors, agents, and hook tools must be installed separately.
Only Linux x86_64 is packaged. The verified standalone environment is Ubuntu
24.04 with glibc 2.39 and Git 2.43.0; other distributions, architectures, macOS,
Windows, and musl/Alpine are not verified.

Tagged downloads become available after the release owner publishes a verified
release. Until then, use the source checkout below. This repository is private:
authenticate [GitHub CLI](https://cli.github.com/) with repository read access,
or download the three assets from the authenticated GitHub Releases page.
GitHub CLI is a download tool, not a Timber runtime dependency.

Choose a published tag in place of `vX.Y.Z`. Run the download, verification, and
installation chain together; installation runs only when all checks pass:

```bash
TIMBER_TAG=vX.Y.Z
DOWNLOAD_DIR="$(mktemp -d "timber-download.XXXXXX")"
gh release download "$TIMBER_TAG" --repo Coding-M8s/timber \
  --dir "$DOWNLOAD_DIR" \
  --pattern "timber-$TIMBER_TAG-linux-x64" \
  --pattern build-info.json --pattern SHA256SUMS \
  && (cd "$DOWNLOAD_DIR" && sha256sum -c SHA256SUMS) \
  && install -Dm755 "$DOWNLOAD_DIR/timber-$TIMBER_TAG-linux-x64" "$HOME/.local/bin/timber" \
  && "$HOME/.local/bin/timber" --version
export PATH="$HOME/.local/bin:$PATH"
```

Add that PATH export to your shell's startup file if needed. Keep the downloaded
`build-info.json` and checksum result when reporting a release problem. Checksums
detect altered downloads; they are not an independent signature. Update by
repeating the same steps with another verified tag. Installation does not create
repository defaults. Before using Timber, run `timber setup` inside your repository,
or `timber setup --global` to configure defaults for this machine. The first CLI
invocation prints this guidance when the installation path has no installer message.

See [release verification and acceptance](docs/releases.md) for source builds,
isolated checks, and the maintainer release process.

## Development

Each developer needs Bun **1.4.2** (pinned in `.bun-version` and `package.json`)
and Git on their `PATH`. Python 3 is needed for the Linux PTY integration tests. The version declarations do not install Bun. Linux
x86_64 is the verified development target; Node is not required. Docker is
needed only for isolated standalone verification, not the ordinary source suite.

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
release binary. `bun run build:release` additionally creates
`dist/release/timber-v0.1.0-dev.0-linux-x64`, `build-info.json`, and `SHA256SUMS`.
The binary name follows the version in `package.json`; `timber --version` reports
that same version. `src/index.ts` also has a
Bun shebang and is the package's `timber` bin entry. No global installation is
needed for development. GitHub CI runs locked installation, typecheck, tests, build
and bundled help on Ubuntu x86_64, then compiles and verifies the standalone
executable in a container without Bun or Node. Other platforms are not verified.

## Commands

```bash
timber setup
timber setup --global
timber new my-feature
timber new Investigate slow API usage page
timber new "Investigate slow API usage page" --no-editor
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

Run `timber new <branch...>` (or `bun run dev new <branch...>`) from the primary
checkout, a nested directory, or a linked worktree. Timber creates a new local
branch from `--base <ref>` when supplied, then `base_branch` in the primary
checkout's `.timber.toml`, then the selected remote's default branch, then a
single existing local `main` or `master`. Missing or ambiguous bases fail
without guessing. Git validates the branch name before creation.

Pass a sentence as one quoted argument or as unquoted words; both forms produce
the same input to `new`. When that input contains literal spaces, Timber trims
surrounding spaces, lowercases it, and changes each run of spaces to one hyphen.
For example, `Investigate slow API usage page` becomes
`investigate-slow-api-usage-page`. A name without spaces, such as
`feature/API-fix` or `TIM-19`, keeps its exact spelling and existing Jira
behavior. Blank names and control characters fail before worktree creation;
other characters are passed to Git for validation. Put options before or after
the words. `--` ends option parsing; Git still validates the resulting branch
name.

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
ID; it never opens `.env` files itself. Standalone releases disable automatic
loading of `.env` and `bunfig.toml`; export credentials into the invoking process.
Bun's source runner may populate the process environment from `.env` before
Timber starts. Use `bun --no-env-file src/index.ts new ABU-834`
to disable that Bun behavior. Site URL configuration contains no credentials.
Without `cloud_id`, Timber calls the configured site for an unscoped token. With
`cloud_id`, it uses Atlassian's fixed Jira Cloud gateway for a scoped token.
Requests do not follow redirects or retry. Each exact lookup has a 10-second
deadline; a suggestions search shares one 10-second deadline across every page and
response body.

Only a complete uppercase key such as `ABU-834` is looked up, and only when
`[jira]` is configured. `timber new ABU-834` looks up the issue and creates a
branch from its canonical key and summary. For example, `Fix café / login!`
becomes `ABU-834-fix-cafe-login`. Timber normalizes the summary into an ASCII
slug and caps the whole branch name at 120 characters. A non-Latin or
punctuation-only summary uses `issue` as its suffix.

Timber checks the Jira status category before creating a branch. It accepts only
known category keys `new` and `indeterminate`; missing, null, or unrecognized
categories fail closed. Timber reads the category key rather than the visible
status name, which may be localized or customized, and it does not infer
completion from resolution fields.

When an exact ticket is unavailable (404) or complete, Timber searches that
project for unfinished issues whose full key starts with the requested key. For
example, `ABU-4` can suggest `ABU-40` and `ABU-41`. Timber uses a fixed read-only
JQL query, filters candidates again by full key prefix, and offers only issues
whose category is `new` or `indeterminate`. Authentication, permission, network,
rate-limit, malformed-response, and unknown-status failures do not start a search.
The search must finish all pages successfully before Timber presents a count or
choice. Jira's [enhanced JQL search API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
supports the paginated endpoint used here.

In an interactive terminal, choose a candidate explicitly, even when there is
only one; canceling prints `Cancelled.`, exits successfully, and leaves Git untouched.
This also applies to the `open` chooser. The initial menu shows five choices,
and displaying more asks for confirmation first. Without an interactive chooser,
Timber prints at most five candidate keys and titles plus the total count, then
shows how to run a candidate key explicitly or retry in a terminal. After a
choice, Timber fetches that exact issue again and checks its current status and
summary before creating anything. If it has become missing or complete, the
command stops without searching again. Literal branch inputs continue through
the ordinary branch creation flow.

The summary becomes part of a Git branch name, which may later be published.
Choose a literal branch such as `feature/ABU-834` when a title would expose
sensitive information. Inputs such as `ABU-834-fix`, lowercase `abu-834`, and
`feature/ABU-834` are always treated as literal branch names.

If a title changes, a later `new ABU-834` can produce a different branch. Use
`timber open ABU-834` to resume existing work. `open` does not need Jira
credentials. If several branches match, Timber reports the candidates and asks
for an exact branch or worktree path. An interactive chooser starts with five
entries and offers the full candidate list only after confirmation; entries that
need manual path selection are labeled and never trigger mutations. Without a
chooser, Timber shows at most five candidates and the total count with exact
selection guidance. Jira URL input and OAuth sign-in are not supported.

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
prefix matches multiple branches or worktrees, Timber uses the five-option
chooser; without a terminal it shows five candidates and the total with exact
selection guidance. An unknown input
returns an error; `open` never invents a branch.

An explicit remote such as `origin/my-feature` selects that remote even when a
local branch has the same name. Unqualified remote branches use `remote` from
`.timber.toml`, or the only configured Git remote when there is exactly one.
Otherwise Timber checks all remotes and asks when matches are ambiguous.
When cached refs cannot identify one local branch or worktree, `open` checks live
remote heads automatically, including branches not fetched locally yet. Discovery
is read-only; only the selected remote branch is fetched. Remote discovery failure
stops before creating a worktree. Existing local targets remain usable offline. When Timber
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
branch. Branches without registered worktrees are excluded from ambiguous ticket
matches, so a remote-only branch does not block cleanup of the sole matching
worktree. Multiple worktrees use the same five-option chooser and confirmed
expansion; `q` cancels successfully. Without a terminal, Timber shows five matches
and the total, requiring an exact branch or path. A direct branch selection without
a worktree is refused. Selected worktrees are revalidated before cleanup.
The primary worktree is always protected.

By default, Timber removes the linked worktree **including ignored files and
folders such as `.env`, `node_modules`, and build output**, then deletes its local
branch only when Git proves every local commit is published to the live upstream,
contained in the validated base, or integrated with that base by a successful
virtual merge. This supports cleaning up an unmerged review checkout; no separate
review flag is required, and the remote branch and PR stay untouched.
Modified and untracked files always block cleanup. The base uses the primary
checkout's `.timber.toml` and the normal base selection policy. Timber checks
fresh Git state immediately before removal.

Normal merges are proven by commit ancestry. For squash/rebase merges, Timber
also accepts a successful virtual Git merge that would add no file changes to
the validated base. This works after the feature's remote branch has been
deleted, or while offline, when the necessary commits are available locally.
If the base is stale, fetch it explicitly before retrying. A closed PR alone is
not proof. Custom merge drivers, conflicting changes, unsupported Git versions,
or an unavailable proof cannot authorize deletion through the integration path. Virtual merges may
write unreachable Git objects; they do not change files, the index, or refs.

For published review work, Timber verifies every local commit is reachable from
the live upstream, rechecks that evidence before removing the worktree, then
checks again before deleting the local branch. A deleted or unreachable upstream,
or a rewrite that no longer preserves all local commits, blocks this path.
Unverifiable publication also blocks cleanup. If publication becomes unproven after
worktree removal, Timber retains the local branch and reports the partial result.
A missing creation base does not block cleanup when publication is proven.

`--keep-branch` retains the local branch. Cached remote-tracking refs alone do not
prove publication. A detached worktree
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

## Bash tab completion

Activate command, flag, and worktree completion in the current Bash session:

```bash
source <(timber completion bash)
```

`open` suggests worktrees and local/cached remote branches; `done` suggests
linked worktrees, including detached paths. Completion stays offline and reads
fresh Git metadata on every Tab. Dirty targets remain visible, and normal
cleanup checks still apply when you execute `done`. Timber does not edit shell
startup files. See [activation, installation, and verified environment](docs/completion.md).

## Repository configuration

Timber reads `.timber.toml` from the primary worktree root and machine defaults from `${XDG_CONFIG_HOME:-$HOME/.config}/timber/config.toml` on Linux. Missing settings use documented defaults, and relative `worktree_dir` values resolve from that root. Agent configuration from 0.1 also supports opt-in foreground launching in 0.2; see the agent section below. Commands use executable names and argument arrays; keep secrets in environment variables or a secret store. See the [CLI contract](docs/cli-contract.md) for accepted fields, defaults, path resolution, precedence, and validation errors.

Editor opening stays off when neither scope enables `[editor]`, or the repository sets `editor = false`. When `open` selects or creates a worktree, Timber starts the configured editor after the required Git and setup work; `--no-editor` skips it for that invocation. Set `command` to an executable available on Timber's `PATH`, or provide its absolute path. Each `args` entry is passed literally as a separate argument, and Timber appends the absolute worktree path at the end.

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

Timber preserves configured flags such as `--wait`, but returns as soon as the editor process starts. It does not wait for the editor window to close or report a nonzero exit that happens after startup. If startup fails, Timber keeps the worktree and prints a safe retry command such as `timber open -- '<worktree path>'`. `new` reports the failure and exits nonzero. `open` reports it on stderr but exits successfully after the required Git and setup work is complete. Both commands suppress agent startup after editor failure. Fix the editor command or `PATH`, then run the retry to reopen the existing worktree; it does not create another one.

### Setup hooks (0.2)

Add trusted shell commands to repository settings or machine defaults:

```toml
[hooks]
post_create = [
  "bun install --frozen-lockfile",
  './scripts/setup.sh',
]
```

`new` runs these steps after creating the branch/worktree. `open` runs them when
it creates a worktree for an existing local or remote branch. Reopening an
existing worktree skips setup unless you explicitly pass `--setup`. Missing effective
hooks, an empty replacement table/list, or local `hooks = false` perform no setup. Only `post_create` is
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
Agent launching starts only after setup succeeds.

### Optional interactive agents (0.2)

Configure the installed tool through `timber setup`, repository TOML, or machine defaults:

```toml
[agent]
enabled = false
command = "claude"
args = []
```

For guided first-time setup, run `timber setup` or `timber setup --global`. To edit repository settings manually, locate the primary checkout:

```bash
git worktree list
```

The first listed worktree is the primary checkout. Create or edit
`.timber.toml` there, even when running Timber from a linked worktree.
Merge the agent table into any existing configuration; do not replace other
settings. Guided setup creates this file after explicit confirmation.

Install your preferred agent separately and make its executable available on
`PATH`. For a development smoke test, run this from the checkout containing
the agent-launch implementation, in a normal terminal with CI off:

```bash
bun run dev new agent-smoke-test --base main --agent --no-editor
```

Use an existing exact base branch in your repository instead of `main` when
needed. `--base` accepts branch names, not `HEAD` or commit IDs. The command
creates the workspace, prints its path, then starts the agent there. After
exiting the agent, reopen that same workspace with:

```bash
bun run dev open agent-smoke-test --agent --no-editor
```

Repository defaults are separate from installing Timber. `timber setup` asks
which editor/agent to use and whether agent launching should be enabled, while
preserving existing values you keep. `timber setup --global` configures defaults
for all repositories.

For Codex, use `command = "codex"` instead. Executable names on `PATH` and
absolute executable paths are supported. Each argument is passed literally;
Timber sets the selected worktree as cwd and does not append its path to args.
Keep credentials outside repository configuration.

`new` and `open` accept `--agent` to enable the configured command for that
invocation and `--no-agent` to suppress it. Omission defers to `enabled`, which
defaults to false. Using both flags is an error. Explicit enable requires an
`[agent]` table; Timber does not assume a default tool. Editor and agent choices
are independent:

```bash
timber new my-feature --agent
timber open my-feature --agent --no-editor
timber open my-feature --no-agent
```

Timber completes required Git work and starts the editor before running the
agent. An editor startup failure prevents agent launch. The agent inherits the
invoking terminal's stdin/stdout/stderr and runs in the foreground; Timber waits
for it to finish. Agent exit status becomes Timber's exit status, including
nonzero statuses and signal exits such as 130 for SIGINT and 143 for SIGTERM.
Terminal Ctrl-C reaches the foreground agent directly, without a duplicate
interrupt from Timber. An agent that handles it and continues keeps its eventual
exit status. For process-directed shutdown with a terminal, send SIGINT to the
foreground process group or SIGTERM to Timber. No background agent or session
manager is started.

Both stdin and stdout must be terminals, and CI must be off. An absent or empty
`CI`, `CI=0`, and `CI=false` (case insensitive) mean CI is off; other values
mean CI is on. In CI or with redirected stdin/stdout, config-driven launch
skips automatically. Explicit `--agent` fails before worktree creation instead
of waiting for interactive input.

Startup failures report the retained workspace and exit 1. Fix configuration
or `PATH`, then retry with
`timber open --agent --no-editor -- '<absolute-worktree-path>'`; this reuses the
workspace. Nonzero exits and interrupts also retain the branch, worktree,
and its files. Agent output goes directly to the terminal; Timber does not
capture or log command arguments.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Release download says unavailable/404 | Confirm the exact published tag and authenticate GitHub CLI with read access to this private repository. |
| Checksum mismatch | Stop installation. Download all assets again into a new directory; report a repeated mismatch to the release owner. |
| `timber` not found or permission denied | Check `command -v timber`, your PATH, and executable permissions. The install command above sets mode 755. |
| Wrong executable format, missing loader, or incompatible libc | Use the verified Linux x86_64/glibc environment; other platforms are not supported by this asset. |
| Git/editor/agent executable missing | Install the required tool or correct its executable/PATH. Configure literal argument arrays; skip optional launches with `--no-editor`/`--no-agent`. |
| Setup or launch failed after creation | Workspace remains. Fix the prerequisite, then use the printed `open` retry; `--setup` reruns every hook. |
| Jira authorization/network failure | Check exported credentials, token type/site/cloud ID, permissions, and connectivity. Never paste tokens into config or bug reports. |
| Remote unavailable | Existing local worktrees can open offline; remote materialization needs a successful refresh. |
| Cleanup refused | Read the named files/commits and preservation evidence. Commit or move your work deliberately; `--keep-branch` does not bypass safety. `--keep-ignored` preserves ignored content in place. |

`done` discards ignored files by default, including `.env` and `node_modules`.
Use `--keep-ignored` to refuse that removal. Partial cleanup can leave the worktree
removed and branch retained; inspect the reported state before retrying.

## Release scope

- **0.1 — Worktree CLI:** repository discovery, local/remote branch resolution, four commands, repository configuration, optional editor opening, conservative cleanup.
- **0.2 — Integrations:** trusted setup hooks, optional interactive Claude/Codex launching, Jira lookup. The CLI remains usable without Jira credentials or an AI subscription.
- **1.0 — Stable CLI:** real-repository dogfooding, errors, safety validation, documentation, verified Linux x86_64 packages.

TypeScript and Bun are the development direction, with Commander, Execa, Zod, and smol-toml. Exact dependency versions are pinned in `package.json` and `bun.lock`; compatibility tests exercise them under Bun. No GUI/IDE, Rust rewrite, database, daemon, or plugin framework is included.

## Planning and contribution

- [Implementation tickets](https://github.com/Coding-M8s/timber/issues)
- [Real workflow dogfooding checklist](docs/dogfooding.md)
- [Release build, installation verification, and acceptance](docs/releases.md)
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

## Guided setup and machine defaults

Before using Timber, run `timber setup` inside your repository, or
`timber setup --global` to configure defaults for this machine. From a source
checkout, use `bun run dev setup` or `bun run dev setup --global`. The first CLI
invocation also prints this hint, including for the standalone executable.

Setup asks about VS Code/Zed/custom editors, Claude/Codex/custom coding assistants,
Jira ticket naming, and optional advanced settings for scripts, Git, and workspace
folders. Use Up/Down arrows and Enter, or press a numbered shortcut to choose
immediately. Shortcuts cover the first nine options; use arrows for additional
entries in long branch lists; the menu scrolls to keep your selection visible.
Blank Enter skips new settings or keeps existing ones; advanced settings are skipped
by default. Each question starts after a blank line. Agent launch
defaults to off and is independent of editor opening. Configure Jira with its
site origin and optional cloud UUID; supply `JIRA_EMAIL` and `JIRA_API_TOKEN`
through the environment, never TOML. Setup requires an interactive terminal with
CI off. The final review shows the absolute destination and summary, with choices
to save, edit any individual section, or cancel. Editing retains the other answers
and returns to review; nothing is written until you choose Save. Replacing
existing settings requires that explicit save choice.

Precedence is CLI options > repository TOML > global TOML > built-in defaults.
Absent keys inherit; a local optional table replaces the whole global table,
including arguments and hook lists. Relative worktree directories in either
scope resolve from the current repository's primary checkout. To disable
inherited features locally, use these root-level values instead of their tables:

```toml
editor = false
agent = false
hooks = false
jira = false
```

`[agent]` with a command and `enabled = false` disables automatic launch but
keeps `--agent` available. `agent = false` removes the inherited command. Both
files must be valid, including values overridden by the other scope. Missing
settings use built-in defaults. The first-use setup hint appears once; normal
commands do not repeat it. Explicit `--agent` without an agent configured explains
how to run setup before creating or opening a workspace.

Local setup writes the primary checkout's `.timber.toml`, including from linked
worktrees, and excludes it through Git-local `info/exclude`. It preserves shared
`.gitignore` and the index. If project ignore rules override that exclusion,
choose global settings or cancel. If config is already tracked, explicitly choose
whether to edit it or use global defaults; ignore rules cannot hide tracked
changes. A hidden/excluded dotfile is not encrypted and can still be force-added.
Edit the printed config path directly later; keep secrets out of both scopes.
Setup never launches tools, executes hooks, creates worktrees, or changes refs.

Saves publish validated TOML atomically and detect concurrent changes. New files
use no-clobber creation; existing replacements cannot guarantee protection against
an unrelated editor changing the file between the final check and rename.
Cancellation before publication preserves settings and restores owned exclusion
changes when safe; after publication setup reports saved state. A hard crash can
leave an extra ignore entry. External ignore-rule edits can change visibility
after setup's check. First-use markers live under
`${XDG_STATE_HOME:-$HOME/.local/state}/timber/`, outside repositories.

To replace a development `bun link` with this branch's standalone executable,
follow the [local installation and smoke-test guide](docs/local-install.md).
