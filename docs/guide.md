# Timber user guide

For the short version, start with the [quick start](../README.md).

Jump to [installation](#install-the-standalone-cli),
[commands](#commands), [configuration](#repository-configuration),
[setup](#guided-setup-and-machine-defaults),
[Arena](#arena-multiple-isolated-attempts), or [troubleshooting](#troubleshooting).

A small CLI for creating, opening, listing, and safely cleaning up Git worktrees.

`new` creates a branch and linked worktree, `ls` lists the repository's worktrees,
and `open` reuses an existing worktree or creates one for a resolved existing
branch. `done` removes a linked worktree and its local branch using publication,
integration, confirmed upstream deletion, or explicit interactive discard.
`done` uses the saved base shown by `ls`, when present. Use
`timber done my-feature --base parent-feature` to override it for one cleanup. The override applies only to this cleanup, keeps the safety
checks, and never changes TOML. Local and cached remote branch refs are supported;
Timber refreshes selected remote bases automatically and never infers a parent.

## Install the standalone CLI

Release assets run without Bun or Node. Git must be installed and available on
`PATH`; configured editors, agents, and hook tools must be installed separately.
Linux x86_64 is the verified standalone platform, tested on Ubuntu 24.04 with
glibc 2.39 and Git 2.43.0. Apple Silicon and Intel macOS downloads are available
in [beta](releases.md#macos-beta); a minimum macOS version is not established.
Other Linux distributions, architectures and musl/Alpine are not verified.
See the [Windows guide](windows.md) for provisional Windows x64 downloads.

### One-line install

On Linux x86_64 and macOS, this installs the latest published release:

```bash
curl -fsSL https://github.com/Coding-M8s/timber/releases/latest/download/install.sh | sh
```

The script downloads the release assets for your machine, verifies their
checksums, runs the new executable, and only then replaces
`~/.local/bin/timber`. A failed run leaves an existing install unchanged. It
refuses unsupported systems before downloading anything, and it never uses
`sudo` or edits shell startup files. If `~/.local/bin` is not on your `PATH`,
it prints the line to add. Run the same command again to update.

| Variable | Effect |
| --- | --- |
| `TIMBER_VERSION` | Install this release tag, such as `v0.1.0`, instead of the latest |
| `TIMBER_INSTALL_DIR` | Install into this absolute directory instead of `~/.local/bin` |

Set a variable on the `sh` side of the pipe:

```bash
curl -fsSL https://github.com/Coding-M8s/timber/releases/latest/download/install.sh | TIMBER_VERSION=v0.1.0 sh
```

To read the script before running it, download it first:

```bash
curl -fsSLO https://github.com/Coding-M8s/timber/releases/latest/download/install.sh
less install.sh
sh install.sh
```

The script and the executables come from the same GitHub releases. Checksums
detect altered or damaged downloads; they do not independently authenticate the
publisher. macOS support is beta; see the
[beta notes](releases.md#macos-beta). On Windows, follow the
[Windows guide](windows.md).

### Manual install

Published releases are listed on the
[releases page](https://github.com/Coding-M8s/timber/releases). Download the
executable, build-info, checksum, `LICENSE` and `THIRD_PARTY_NOTICES.txt` assets
for your platform. The checksum file covers all four other files, so keep them
in one directory. The commands below use `curl`; downloading the same assets in
a browser works too.

For Linux, choose a published tag in place of `vX.Y.Z`. Run the download, verification, and
installation chain together; installation runs only when all checks pass:

```bash
TIMBER_TAG=vX.Y.Z
RELEASE_URL="https://github.com/Coding-M8s/timber/releases/download/$TIMBER_TAG"
DOWNLOAD_DIR="$(mktemp -d "timber-download.XXXXXX")"
(cd "$DOWNLOAD_DIR" && curl -fsSL --remote-name-all \
    "$RELEASE_URL/timber-$TIMBER_TAG-linux-x64" \
    "$RELEASE_URL/build-info.json" "$RELEASE_URL/SHA256SUMS" \
    "$RELEASE_URL/LICENSE" "$RELEASE_URL/THIRD_PARTY_NOTICES.txt" \
  && sha256sum -c SHA256SUMS) \
  && install -Dm755 "$DOWNLOAD_DIR/timber-$TIMBER_TAG-linux-x64" "$HOME/.local/bin/timber" \
  && "$HOME/.local/bin/timber" --version
export PATH="$HOME/.local/bin:$PATH"
```

For macOS beta, choose `darwin-arm64` for Apple Silicon or `darwin-x64` for Intel
(check `uname -m`: `arm64` or `x86_64`). These binaries are unsigned and not notarized.
Use a published tag and run this download, verification and installation chain:

```bash
TIMBER_TAG=vX.Y.Z
TIMBER_TARGET=darwin-arm64
RELEASE_URL="https://github.com/Coding-M8s/timber/releases/download/$TIMBER_TAG"
DOWNLOAD_DIR="$(mktemp -d "timber-download.XXXXXX")"
(cd "$DOWNLOAD_DIR" && curl -fsSL --remote-name-all \
    "$RELEASE_URL/timber-$TIMBER_TAG-$TIMBER_TARGET" \
    "$RELEASE_URL/build-info-$TIMBER_TARGET.json" "$RELEASE_URL/SHA256SUMS-$TIMBER_TARGET" \
    "$RELEASE_URL/LICENSE" "$RELEASE_URL/THIRD_PARTY_NOTICES.txt" \
  && shasum -a 256 -c "SHA256SUMS-$TIMBER_TARGET") \
  && mkdir -p "$HOME/.local/bin" \
  && install -m755 "$DOWNLOAD_DIR/timber-$TIMBER_TAG-$TIMBER_TARGET" "$HOME/.local/bin/timber" \
  && "$HOME/.local/bin/timber" --version
export PATH="$HOME/.local/bin:$PATH"
```

If macOS blocks the executable, see the [beta notes and reporting steps](releases.md#macos-beta).
Add the PATH export to your shell's startup file if needed. Keep the downloaded
build-info file and checksum result when reporting a release problem. Checksums
detect altered downloads; they are not an independent signature. Update by
repeating the same steps with another verified tag. Installation does not create
repository defaults. Before using Timber, run `timber setup` inside your repository,
or `timber setup --global` to configure defaults for this machine. The first CLI
invocation prints this guidance when the installation path has no installer message.

See [release verification and acceptance](releases.md) for source builds,
isolated checks, and the maintainer release process.

## Development

Use Bun 1.4.4 (pinned in `.bun-version`) and Git. Python 3 is needed for PTY tests.
Docker is needed only for isolated standalone checks.

```bash
bun install --frozen-lockfile
bun run dev --help
bun run typecheck
bun run test
bun run build
```

See [running tests](testing.md) for workers, serial debugging, and test guidelines.

`build` creates `dist/index.js`, a Bun bundle. For standalone builds and release
checks, see [releases.md](releases.md).

## Commands

```bash
timber setup
timber setup --global
timber new my-feature
timber new my-feature --workflow review
timber new Investigate slow API usage page
timber new "Investigate slow API usage page" --no-editor
timber open my-feature
timber open my-feature -w review
timber open origin/my-feature
timber open TIM-42
timber open "/absolute/path/to/my-feature-worktree"
timber open my-feature --no-editor
timber open my-feature --setup
timber new my-feature --no-setup
timber ls
timber publish my-feature
timber pr my-feature --title "Add the feature"
timber done my-feature
timber done my-feature --base parent-feature
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

Before creating anything, `new` checks the final branch name against local
branches and the configured (or every) remote, which needs network access when the
repository has remotes. If the branch already exists on a remote, Timber asks
`Branch already exists on <remote>. Did you mean timber open?` with `Open existing
branch` and `Cancel` (the default). Without a terminal it refuses and prints a
command such as `timber open -- 'origin/feature/example'`. An unreachable remote
counts as unknown, not as absent, and also refuses. `--base` cannot be combined
with an existing branch. Details: [CLI contract](cli-contract.md#existing-branch-guard).

By default, Timber places the linked worktree at
`../<repository-name>-worktrees/<safe-branch-slug>` beside the primary checkout.
Set `worktree_dir` in `.timber.toml` to choose another root; relative paths
resolve from the primary checkout. No CLI path override exists. An existing
branch suggests `timber open`; an occupied destination fails without replacing
files or refs.

`--editor` starts a configured editor for this command; `--no-editor` skips it.
Without either flag, `[editor].enabled` controls launch and defaults to `false`.
Timber starts the editor after Git creates the worktree and setup completes.
Success prints the branch and absolute worktree path. If
editor startup fails, Timber reports the retained workspace and a
`timber open --editor -- '<absolute-worktree-path>'` retry command, and exits nonzero.

### Create a worktree from Jira

Configure one Jira Cloud site in the primary repository's `.timber.toml`:

```toml
[jira]
site_url = "https://example.atlassian.net"
# Set this for an Atlassian scoped API token:
# cloud_id = "00000000-0000-0000-0000-000000000000"
```

Run `timber setup` or `timber setup --global` to enter your Atlassian email and
API token. Token entry is hidden, including pasted input. Both scopes share a
personal credential store at
`${XDG_CONFIG_HOME:-$HOME/.config}/timber/credentials/jira.json` (XDG must be
absolute), outside Git repositories. The file is plaintext, **not encrypted**:
a user-owned 0700 directory and 0600 regular file protect access. Credentials are
matched to the normalized site and optional cloud UUID; a different site or
scoped/unscoped token mode needs its own pair. No credentials go in ordinary TOML.
Paste one token on one line and wait for each prompt; buffered extra lines from
an unbracketed paste are discarded so they cannot appear at a later visible prompt.

A complete nonblank `JIRA_EMAIL` and `JIRA_API_TOKEN` environment pair overrides
the matching saved pair. If either variable is supplied alone or blank, Timber
fails with guidance; it never mixes an environment value with a saved value.
Unset both variables to use saved credentials. Credentials are loaded only when
Jira is actually used, so `open`, `ls`, `done`, literal branch creation, and
`jira = false` work without them.

Standalone releases disable automatic loading of `.env` and `bunfig.toml`.
Saved credentials work directly in the installed executable. Bun's source runner
may populate the process environment from `.env` before Timber starts, making a
source checkout behave differently. Use
`bun --no-env-file src/index.ts new ENG-834` to disable that Bun behavior;
Timber adds no `.env` loader.
Without `cloud_id`, Timber calls the configured site for an unscoped token. With
`cloud_id`, it uses Atlassian's fixed Jira Cloud gateway for a scoped token.
Requests do not follow redirects or retry. Each lookup has a 10-second
deadline covering the response body.

Timber looks up a complete key such as `ENG-834` when it is written `jira:ENG-834`,
or written bare with `default_tracker = "jira"`. Case does not matter: `eng-834`
and `Eng-834` are read as `ENG-834`. With `default_tracker = "jira"`,
`timber new ENG-834` looks up the issue and creates a
branch from its canonical key and summary. For example, `Fix café / login!`
becomes `ENG-834-fix-cafe-login`. Timber normalizes the summary into an ASCII
slug and caps the whole branch name at `max_generated_branch_name_length`
(120 characters when unset). A non-Latin or
punctuation-only summary uses `issue` as its suffix.

Timber checks the Jira status category before creating a branch. It accepts only
known active category keys `new` and `indeterminate`; `done` requires `-c`. Missing, null, or unrecognized
categories fail closed. Timber reads the category key rather than the visible
status name, which may be localized or customized, and it does not infer
completion from resolution fields.

The summary becomes part of a Git branch name, which may later be published.
Choose a literal branch such as `feature/ENG-834` when a title would expose
sensitive information. Inputs such as `ENG-834-fix` and `feature/ENG-834` are
always treated as literal branch names.

If a title changes, a later `new ENG-834` can produce a different branch. Use
`timber open ENG-834` to resume existing work. `open` does not need Jira
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

Worktrees created from an issue remember it, and `timber ls --json` reports the
link. To link a branch made before this or by hand, run
`timber open my-feature --issue jira:ENG-12`. A worktree already linked to a different
issue is left unchanged unless you add `--replace-issue`. See
[issue links](cli-contract.md#worktree-issue-links-153).

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
branch when Git proves every local commit is published to the live upstream,
contained in the validated base, or integrated with that base by a successful
virtual merge or exact historical tree match. This supports cleaning up an
unmerged review checkout; no separate review flag is required, and the remote
branch and PR stay untouched.
A successful live query confirming the configured upstream branch no longer exists
allows automatic deletion even when local commits differ from the merged version
or modified/untracked files exist. Timber reports this reason before removal.
A missing upstream configuration, stale tracking cache, connection failure,
authentication failure or timeout does not establish upstream deletion.

Otherwise, modified/untracked files or unpreserved commits produce an explanation
and an interactive **Delete anyway?** prompt, defaulting to **No**. Accepting discards
the worktree's local commits and all modified and untracked files. Cancel or press
Enter to retain the worktree and branch. Noninteractive commands refuse when this
confirmation is needed; there is no force flag for scripts. A confirmed deleted
upstream permits automatic cleanup in noninteractive runs too.

Base selection uses explicit
`--base`, then the saved worktree base shown by `ls`, then repository/global
configuration and existing default discovery. Missing saved refs fail without
fallback; malformed/unreadable metadata requires repair, and stale identity
metadata requires an explicit override. Cleanup never saves an override. Timber
rechecks the saved selection and fresh Git state immediately before removal.

Normal merges are proven by commit ancestry. For squash/rebase merges, Timber
also accepts a successful virtual Git merge that would add no file changes to
the validated base. It also accepts an exact full-tree match between the local
branch tip and a commit in the validated base history. This permits cleanup
after later base edits or reverts: the complete snapshot remains recoverable
from base history even when it differs from the current base. Matching trees
only on unrelated branches do not qualify. Independently, a confirmed deleted
upstream permits the automatic discard described above. When the selected base is a remote branch such
as `origin/main`, `done` automatically fetches that branch and updates its cached
remote-tracking ref before checking integration. This applies to `--base`, the
saved base, the configured base and the default remote base. No separate `git fetch` is needed.
Fetch failure stops cleanup and preserves the worktree and local branch. Local
base branches remain unchanged and can be used offline when the necessary
commits are available locally. A closed PR alone is not proof. Custom merge
drivers, unsupported Git versions, or an unavailable proof cannot authorize
deletion through the integration path. A virtual merge
conflict requires the separate exact historical tree proof to permit cleanup.
Virtual merges may write unreachable Git objects; they do not change files, the
index, or refs.

For published review work, Timber verifies every local commit is reachable from
the live upstream, rechecks that evidence before removing the worktree, then
checks again before deleting the local branch. An unreachable upstream or a rewrite
that no longer preserves all local commits blocks the publication path. Initially
confirmed upstream absence uses the separate automatic discard path, revalidated
before removal and branch deletion. If that upstream reappears or becomes
unverifiable, cleanup stops; after removal it retains the local branch.
If publication becomes unproven after
worktree removal, Timber retains the local branch and reports the partial result.
A missing creation base does not block cleanup when publication is proven.

`--keep-branch` retains the local branch. Cached remote-tracking refs alone do not
prove publication. A detached worktree
can be removed by absolute path when its commit is contained in the base or the
user explicitly confirms discard.

`--keep-ignored` refuses cleanup when ignored files exist, including inside
initialized submodules. The worktree, branch,
and ignored files remain in their original locations; nothing is copied to a
backup folder. Move those files yourself or retry without the flag to discard
them. `--discard-ignored` remains supported for compatibility and expresses the
default; combining it with `--keep-ignored` is an error. Refusals name affected
paths or commits without printing file contents. Locks, stale metadata, and
identity checks remain enforced. There is no `--force`, automatic stash, remote
branch deletion, or process killing.

Success names the removed path and the deleted or retained local branch.
Optional `[hooks].pre_delete` commands run after the initial safety checks and
before removal, including with `--keep-branch`. A failure retains the worktree
and branch. Timber rechecks safety after hooks and refuses removal if they leave
protected files or change the selected refs. See [pre-deletion hooks](#pre-deletion-hooks).
If removal succeeds but branch deletion fails, Timber exits nonzero, reports
the observed partial result on stderr, and does not claim completion. Inspect
the reported Git state before retrying. Remote branches, the primary checkout,
and unrelated worktrees stay intact.

### List worktrees

Run `timber ls` (or `bun run dev ls`) from any nested directory in the primary
or a linked worktree. Timber reads Git's inventory, including worktrees created
manually and outside the default Timber directory. It prints a space-aligned
table with `WORKTREE`, `BRANCH`, `BASE`, `STATUS`, and absolute `PATH` columns, primary
first and linked paths sorted deterministically.

The primary worktree is marked `primary`; detached HEAD shows `(detached HEAD)`.
Dirty status includes modified and untracked file counts. Staged and unstaged
changes to the same file count once; a rename counts as one modified file.
Listing does not read ignored files such as `.env` or `node_modules`, so large
ignored folders do not slow it down; `done` and `rebase` still check them.
Missing or inaccessible worktrees stay visible with `unknown` status; `missing`,
`locked`, and `prunable` markers describe their state. Control
characters in paths are escaped so each worktree occupies one row.
`BASE` shows the [saved base](worktree-bases.md), `-` when none is saved, and `?`
when local base metadata cannot be trusted. A narrow terminal may wrap a complete row.

Listing checks a few worktrees at a time, works offline, and requires no
`.timber.toml`. It does not fetch, prune, refresh the index, open an editor,
launch an agent, or change files or refs.

### Publish a branch

`timber publish my-feature` pushes the branch of an existing worktree under its
own name and reports the commit that is now on the remote. A branch with an
upstream goes to that upstream's remote. A branch without one goes to the
configured `remote`, or to the only remote, and that becomes its upstream.
Modified and untracked files are not pushed and do not block publishing.

Timber never force-pushes. If the remote branch has commits yours does not
contain, including after you rebased or amended published commits, publish
refuses and changes nothing; integrate or force-push with Git yourself. It also
never asks for a password or passphrase: sign in with your Git credential
helper, SSH agent or the GitHub CLI first. Tags and pull requests are not part
of this command. Apps can read the outcome from a
[result file](ide-contract.md#publish-outcome).

### Open a pull request

`timber pr my-feature --title "Add the feature"` publishes the branch exactly as
`timber publish` does, then opens a pull request on GitHub with your GitHub CLI
login, or `GH_TOKEN`/`GITHUB_TOKEN` when set. On a bitbucket.org remote it opens
the pull request on Bitbucket Cloud with the login saved under **Connections** in
`timber setup` (an Atlassian email and an API token with the
`read:pullrequest:bitbucket` and `write:pullrequest:bitbucket` scopes), or
`BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN` when set. Add `--body <text>` for a
description and `--draft` for a draft. On GitHub, `--reviewer alice` or
`--reviewer my-org/my-team` (repeat it for more) requests reviewers once the pull
request is created or found already open; a reviewer GitHub refuses is a
warning, and the pull request stays open.

The pull request targets the worktree's saved base, such as `origin/main`
becoming `main`. A worktree with no saved base, or with a local branch as its
base, is refused before anything is pushed; pass `--base origin/main` (or a
branch name on the configured remote) instead. `--base` does not change the
saved base.

If the branch already has an open pull request into that base, Timber reports it
and creates nothing. The worktree's linked issue, or an issue named at the start
of the branch such as `GH-123-fix-login` or `ENG-42-fix-login`, is mentioned in
the body (`Refs #123` or `Refs ENG-42`) so the two are connected; Timber never
adds a closing keyword. Only github.com and bitbucket.org remotes are
supported, and Timber never prompts for a sign-in: run `gh auth login` or
`timber setup` first.
Apps can read the outcome from a [result file](ide-contract.md#pull-request-outcome).

## Remove Timber

```bash
timber uninstall                    # remove the executable; keep settings
timber uninstall --remove-settings  # also remove settings, credentials and state
```

The command lists what it will remove and keep, then asks for confirmation. In a
script, add `--yes`; without it a noninteractive run refuses and removes nothing.
It removes only the running standalone executable, never a Bun source or
`bun link` run (see [CONTRIBUTING.md](../CONTRIBUTING.md)). It refuses symlinks,
files owned by another user and paths inside a Git directory. Unknown files in
Timber's directories are listed and never deleted. Repositories, worktrees,
branches, `.timber.toml` and `<git common dir>/timber/` are never touched.
Remove any completion lines you added to `.bashrc`, `.zshrc` or fish config
yourself.

### Manual removal

Use this table if you already deleted the executable, or on Windows, where a
running `.exe` cannot delete itself. Defaults shown; `XDG_CONFIG_HOME` and
`XDG_STATE_HOME` and `XDG_CACHE_HOME` apply when set to absolute paths.

| Item | Linux and macOS | Windows |
| --- | --- | --- |
| Executable | `~/.local/bin/timber` | `%LOCALAPPDATA%\Programs\Timber\timber.exe`, and its PATH entry |
| Machine settings | `~/.config/timber/config.toml` | `%USERPROFILE%\.config\timber\config.toml` |
| Jira credentials | `~/.config/timber/credentials/jira.json` | `%USERPROFILE%\.config\timber\credentials\jira.json` |
| Linear credentials | `~/.config/timber/credentials/linear.json` | `%USERPROFILE%\.config\timber\credentials\linear.json` |
| Bitbucket login | `~/.config/timber/credentials/bitbucket.json` | `%USERPROFILE%\.config\timber\credentials\bitbucket.json` |
| Setup hint marker | `~/.local/state/timber/setup-hint-shown` | `%USERPROFILE%\.local\state\timber\setup-hint-shown` |
| Update check cache | `~/.cache/timber/update-check.json` | `%USERPROFILE%\.cache\timber\update-check.json` |
| Repository settings | `.timber.toml` in each primary worktree (optional) | same |
| Repository metadata | `<git common dir>/timber/` and `timber-setup.lock` (optional) | same |
| Worktrees and branches | `timber done`, or `git worktree remove` | same |
| Completion lines | user-added lines in shell startup files | PowerShell profile, if added |

## Bash tab completion

Activate command, flag, and worktree completion in the current Bash session:

```bash
source <(timber completion bash)
```

`open` suggests worktrees and local/cached remote branches; `done` suggests
linked worktrees, including detached paths. Completion stays offline and reads
fresh Git metadata on every Tab. Dirty targets remain visible, and normal
cleanup checks still apply when you execute `done`. Timber does not edit shell
startup files. See [activation, installation, and verified environment](completion.md).

## Repository configuration

Timber reads `.timber.toml` from the primary worktree root and machine defaults from `${XDG_CONFIG_HOME:-$HOME/.config}/timber/config.toml` on Linux. Missing settings use documented defaults, and relative `worktree_dir` values resolve from that root. Agent launching is opt-in; see the agent section below. Commands use executable names and argument arrays; keep secrets in environment variables or a secret store. See the [CLI contract](cli-contract.md) for accepted fields, defaults, path resolution, precedence, and validation errors.

Set `max_generated_branch_name_length` in global config or repository `.timber.toml`
to limit names generated from issue titles and sentences. Repository settings win:

```toml
max_generated_branch_name_length = 80
```

For example, with `max_generated_branch_name_length = 12`,
`timber new "Fix login retry behavior"` creates `fix-login`, and an issue with canonical ID `ENG-123`
and title "Fix café login" creates `ENG-123-fix`. The limit includes the complete
ID and separator. Timber refuses settings that cannot retain the full ID plus a
descriptive suffix, and refuses collisions instead of choosing another name.

Use a positive integer. Names count Unicode code points. Shortening cuts back to
the last complete word and removes trailing separators; only a single first word
longer than the limit is cut mid-word. In an interactive terminal, Timber shows the
generated and shortened names and lets you accept the shortened one, finish the
word the limit cut (offered only when the limit cut a word; the result is over the
limit), or type your own (within the limit, and starting with the issue ID for issue names). Without a
terminal it uses the shortened name. Git still validates the result.
Explicit branch names without spaces and existing branches keep their exact names;
Arena names are unaffected. With no setting, issue names keep their existing
120-character cap and sentences remain uncapped. See the
[CLI contract](cli-contract.md#repository-configuration) for full rules.

Editor opening stays off by default, even with a configured `[editor]` command. Set `enabled = true` in that table to open it automatically, or use `--editor` on `new` or `open` for one command. `--no-editor` suppresses launch. Both flags together are an error. An explicit `--editor` requires a configured command; a repository-level `editor = false` removes an inherited command. Timber starts the editor after required Git and setup work. Set `command` to an executable available on Timber's `PATH`, or provide its absolute path. Each `args` entry is passed literally as a separate argument, and Timber appends the absolute worktree path at the end.

### Named worktree workflows

Use `--workflow review`, `-w review`, or `--w review` with `new` or `open`.
Each spelling selects the same named workflow; using more than one in a command
is an error. Names use lowercase letters, digits, hyphens, and underscores,
starting with a letter. Define as many names as needed in repository or machine
TOML:

```toml
[workflows.review]
description = "Review someone else's branch"
post_create = ["bun install --frozen-lockfile"]

[workflows.review.editor]
command = "code"
args = ["--new-window"]

[workflows.review.agent]
command = "/absolute/path/to/review-wrapper"
args = ["--initial-review"]
```

The workflow editor and agent may be omitted to inherit ordinary defaults, or
set to `false` to disable them. A workflow editor table requests launch when
that workflow is selected; an inherited editor still follows `[editor].enabled`.
Explicit `--editor` can use the ordinary editor even when the workflow sets
`editor = false`. `post_create` defaults to an empty list. A
repository workflow replaces the same global workflow as a whole; lists and
command arguments do not merge. Set `review = false` inside a repository
`[workflows]` table to remove an inherited name, or root `workflows = false`
to remove all inherited names. Both config scopes are validated even when one
overrides the other. `timber setup` preserves existing workflow values and shows
the effective count; edit workflow definitions directly in TOML.

Outside enabled Orca integration, on creation Timber runs ordinary setup scripts,
then workflow setup scripts, opens the selected editor, then starts its optional
initial agent in the invoking terminal. `open` creating a worktree for an
existing branch counts as creation. The scripts receive `TIMBER_WORKFLOW` as an
environment variable; Timber never substitutes it into shell source. A custom
agent wrapper can supply its prompt and open a separate window if desired.
Timber passes executable arguments literally. With [Orca integration](editor-terminals.md), setup and agents use separate editor terminals instead.

A workflow is a one-off choice: it applies only to the command that names it, and
Timber does not remember it for the worktree. A later `open` without `-w` follows
your ordinary editor, agent and hook settings. Running `open -w review` on an
existing worktree uses that workflow's editor for this one command, without
rerunning setup or launching an implicit agent, including when ordinary agent
defaults are enabled. `open --setup -w review` deliberately reruns ordinary and
workflow scripts once (without `-w`, only ordinary scripts run); `open --agent -w
review` deliberately starts that workflow's agent again. `--editor` explicitly
starts the selected editor;
`--no-editor` and `--no-agent` suppress their
respective launches. Explicit `--agent` requires an interactive terminal with CI
off or an enabled, selected Orca editor integration. A normal reopen never retries
a failed setup or initial prompt.

Timber stores nothing about the workflow in the worktree, and `timber ls` does
not show it.
Creation-stage failures retain the worktree and refs. After fixing a failed
script, run `timber open --setup -- '<absolute-worktree-path>'`; for editor
startup, run `timber open --editor -- '<absolute-worktree-path>'`; for an initial
agent retry, run `timber open --agent --no-editor -- '<absolute-worktree-path>'`.
When the failed command named a workflow, add the same `-w <name>` before `--`,
as the printed retry command does.
Explicit script retries start from the first step; make scripts safe to rerun.
No exactly-once guarantee is made across crashes. Keep secrets out of TOML,
scripts, and diagnostics.

### Zed

```toml
base_branch = "main"
worktree_dir = "../timber-worktrees"

[editor]
command = "zed"
args = ["--new"]
enabled = false

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
enabled = false
```

Set `enabled = true` to launch automatically after `new` or `open`, or leave it false and pass `--editor` when needed. Timber preserves configured flags such as `--wait`, but returns as soon as the editor process starts. It does not wait for the editor window to close or report a nonzero exit that happens after startup. If startup fails, Timber keeps the worktree and prints a safe retry command such as `timber open --editor -- '<worktree path>'`. `new` reports the failure and exits nonzero. `open` reports it on stderr but exits successfully after the required Git and setup work is complete. Both commands suppress agent startup after editor failure. Fix the editor command or `PATH`, then run the retry to reopen the existing worktree; it does not create another one.

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
hooks, an empty replacement table/list, or local `hooks = false` perform no setup.
The table also accepts `pre_delete` for cleanup; invalid values and unknown keys
are rejected before Git creation.
`--no-editor` skips the editor while still allowing setup. `--no-setup` on
`new` or `open` creates the worktree without running any hook, for example when
a tool runs setup in its own terminal; Timber prints the `timber open --setup`
command to run it later.

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

### Pre-deletion hooks

Add trusted cleanup commands to the same hooks table:

```toml
[hooks]
post_create = ["bun install --frozen-lockfile"]
pre_delete = ['./scripts/stop-worktree-services.sh']
```

`done` first checks that cleanup is safe, then runs `pre_delete` sequentially in
the selected worktree, even with `--keep-branch`. It uses the setup hook shell,
environment variables and output streams, with closed stdin. No workflow is
selected and inherited `TIMBER_WORKFLOW` is cleared. Cancellation or an initial
safety refusal runs no commands. In `timber setup`, choose **Pre-done scripts**
or use the guided advanced settings to configure these commands. Editing or
disabling either script list preserves the other effective list. Each script step
offers None or Add/Edit scripts; empty lists default to None, and existing
commands are prefilled for editing.
Choose Done while editing to remove the remaining commands from that list.

A failed step stops cleanup before Timber removes the worktree or branch. Its
diagnostic names the step and gives a `timber done` retry retaining
`--keep-branch`/`--keep-ignored` when selected. Hook side effects remain; Timber
does not roll them back. Explicit retries run all steps from the beginning, so
make them safe to rerun. Commands are trusted code with your permissions.

After hooks succeed, Timber rechecks identity, files, refs and applicable cleanup
authorization. Discard approval is bound to file contents and staged changes, not
just path names, and includes initialized submodule indexes. Changed file state
during confirmation/hooks or changed target/base refs refuse
cleanup. Ignored runtime file changes do not invalidate default discard;
`--keep-ignored` still refuses when any ignored files exist. Otherwise ignored
content is discarded as usual. A repository hooks table replaces the entire global
table, and `hooks = false` disables both hook lists.

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
defaults to false; existing-worktree opens with an enabled editor require explicit `--agent`. Using both flags is an error. Explicit enable requires an
`[agent]` table; Timber does not assume a default tool. Editor and agent choices
are independent:

```bash
timber new my-feature --agent
timber open my-feature --agent --no-editor
timber open my-feature --no-agent
```

Outside enabled [Orca integration](editor-terminals.md), Timber completes required Git work and starts the editor before running the
agent. An editor startup failure prevents agent launch. The agent inherits the
invoking terminal's stdin/stdout/stderr and runs in the foreground; Timber waits
for it to finish. Agent exit status becomes Timber's exit status, including
nonzero statuses and signal exits such as 130 for SIGINT and 143 for SIGTERM.
Terminal Ctrl-C reaches the foreground agent directly, without a duplicate
interrupt from Timber. An agent that handles it and continues keeps its eventual
exit status. For process-directed shutdown with a terminal, send SIGINT to the
foreground process group or SIGTERM to Timber. No background agent or session
manager is started.

For foreground agents, both stdin and stdout must be terminals, and CI must be off. An absent or empty
`CI`, `CI=0`, and `CI=false` (case insensitive) mean CI is off; other values
mean CI is on. In CI or with redirected stdin/stdout, config-driven launch
skips automatically. Explicit `--agent` fails before worktree creation instead
of waiting for interactive input. With an enabled, selected Orca integration,
explicit and config-driven initial agents instead use Orca terminals and can
launch from a noninteractive caller, including with CI on. A generic editor,
disabled Orca integration or `--no-editor` retains the foreground restrictions.

Startup failures report the retained workspace and exit 1. Fix configuration
or `PATH`, then retry with
`timber open --agent --no-editor -- '<absolute-worktree-path>'`; this reuses the
workspace. Nonzero exits and interrupts also retain the branch, worktree,
and its files. Agent output goes directly to the terminal; Timber does not
capture or log command arguments.

## Update notice and `timber update`

The standalone executable tells you when a newer release exists, and one command
installs it:

```bash
timber update              # install the latest release
timber update --check      # report only; installs nothing
timber update --version v0.1.3   # install a specific published tag
```

**A network request is made by default.** About once a day, Timber starts a
detached background process that sends one plain HTTPS GET to
`https://github.com/Coding-M8s/timber/releases/latest` and reads the release tag
from the redirect. It sends no identifiers, no Timber version, no repository
details and no query, only a generic `User-Agent`. It never delays or waits on
your command. `TIMBER_RELEASES_URL` (https only) selects another releases base,
as for the installer.

The result is cached in `${XDG_CACHE_HOME:-$HOME/.cache}/timber/update-check.json`
(a relative `XDG_CACHE_HOME` is ignored). When the cached stable tag is newer than
the running version, the next command prints this to stderr after its own output
(stdout is unchanged):

```text
Update available: timber 0.1.2 -> 0.1.4
Run: timber update
```

Because the check runs in the background, the notice appears on the run after the
check. Only one check starts at a time, and none starts when the cache file cannot be
written. A failed check is silent, keeps the previous result and is retried no sooner
than 24 hours later. A missing or corrupt cache file is treated as not checked yet.
Release candidates (`-rc.N`) never trigger a notice.

Neither the check nor the notice happens when stderr is not a terminal, `CI` is
set, no subcommand is given (`timber --version`, `timber --help`), the command is
hidden (`__*`), `update`, shell completion, or produces
machine output (`--json`, `--result-file`), or Timber runs from source instead of
the standalone executable.

Turn it off with either of these:

```bash
export TIMBER_NO_UPDATE_CHECK=1
```

```toml
# ${XDG_CONFIG_HOME:-$HOME/.config}/timber/config.toml
update_check = false
```

`timber update` downloads `install.sh` from the selected release and runs it with
`TIMBER_INSTALL_DIR` set to the directory of the running executable, so the
installer's checksum verification and leave-unchanged-on-failure behavior apply.
When you are already on the latest version it says so and downloads nothing. It
refuses, changing nothing, when run from source, when the install directory is not
writable, when the executable is not named `timber`, when `curl` or `sh` is
missing, or on Windows (see [Windows](windows.md)). `timber update --check` always
does a fresh check and refreshes the cache; it cannot be combined with `--version`.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Release download says unavailable/404 | Confirm the exact published tag on the [releases page](https://github.com/Coding-M8s/timber/releases) and that the asset name matches your platform. |
| Checksum mismatch | Stop installation. Download all assets again into a new directory; report a repeated mismatch to the release owner. |
| `timber` not found or permission denied | Check `command -v timber`, your PATH, and executable permissions. The install command above sets mode 755. |
| Wrong executable format, missing loader, or incompatible libc | Use the verified Linux x86_64/glibc environment; other platforms are not supported by this asset. |
| Git/editor/agent executable missing | Install the required tool or correct its executable/PATH. Configure literal argument arrays; skip optional launches with `--no-editor`/`--no-agent`. |
| Setup or launch failed after creation | Workspace remains. Fix the prerequisite, then use the printed `open` retry; `--setup` reruns every hook. |
| Jira authorization/network failure | Run setup to check/replace the saved pair; check complete environment overrides, token type/site/cloud ID, permissions, and connectivity. Never paste tokens into config or bug reports. |
| Remote unavailable | Existing local worktrees can open offline; remote materialization needs a successful refresh. `timber new` also refuses when it cannot verify that the branch name is free on a remote; retry when the remote is reachable. |
| Cleanup refused | Read the named files/commits and preservation evidence. Commit or move your work deliberately; `--keep-branch` does not bypass safety. `--keep-ignored` preserves ignored content in place. |

`done` discards ignored files by default, including `.env` and `node_modules`.
Use `--keep-ignored` to refuse that removal. Partial cleanup can leave the worktree
removed and branch retained; inspect the reported state before retrying.

## Default issue tracker

In the guided walkthrough, question 3 chooses GitHub, Linear, Jira, or None and
opens only the selected provider's setup. The settings menu also has **Default
issue tracker** and **Connections**. Use connections to configure other
providers, and the Bitbucket pull request login, without changing the default.

```toml
# Machine default or repository .timber.toml:
default_tracker = "linear" # github, linear, jira, or none
```

Repository settings override `timber setup --global`. Choose **Inherit machine
default** to follow global changes, or **None** to disable automatic lookup just
for this repository. Switching defaults or selecting None retains credentials.
If neither scope has a preference, unprefixed names are literal branches.

| Default | Command | Behavior |
| --- | --- | --- |
| GitHub | `timber new 97` | Look up GitHub issue 97 |
| Linear | `timber new ENG-123` | Look up Linear issue ENG-123 |
| Jira | `timber new ENG-123` | Look up Jira ticket ENG-123 |
| None | `timber new ENG-123` | Create literal branch ENG-123 |
| Any | `timber new fix-login` | Create literal branch fix-login |

Explicit `github:97`, `linear:ENG-123`, and `jira:ENG-123` override the default,
including None. Jira and Linear keys may be typed in any case, prefixed or bare:
`jira:eng-123` and, with Jira as the default, `eng-123` both mean `ENG-123`.
Branch names, lookups and saved issue links always use the uppercase key. Jira needs effective site settings; `jira = false` disables it.
After creating an issue-named branch, Timber displays the canonical key, title,
and link before running setup scripts. This does not create new saved issue metadata.

If an unprefixed default lookup reports a missing issue, Timber prints a notice
and creates a literal branch with the original name. Providers can hide inaccessible
issues as missing. Explicit selectors never fall back. Authentication, explicit
access denial, network, rate-limit, malformed response and other lookup errors stop
before branch creation or setup scripts. Git creation errors also stop; Timber
never retries those as literal branches.

Use `-c` with any provider to allow a known closed/completed ticket without
reopening it. Unknown states and deleted/trashed issues still refuse. `--remote`
remains GitHub-only; issue-only flags cannot turn a literal input into a lookup.

## GitHub issues

Use `timber setup` or `timber setup --global` and select **GitHub** under
**Connections** to check your GitHub CLI login. If gh is missing, install it from [cli.github.com](https://cli.github.com/).
Setup can help run `gh auth login --hostname github.com` after confirmation.
GitHub CLI owns the login and credential storage; Timber does not copy the token
to a file. A successful login remains even if you later cancel Timber setup.
GitHub CLI may ask about its own Git authentication/protocol settings during login.
The check confirms your account, not access to every repository or issue.

```bash
timber new github:123
timber new github:123 --remote upstream --base main
timber new github:123 -c
timber open GH-123
```

The issue repository comes from `--remote`, your configured remote, or `origin`,
in that order. For a fork, choose `--remote upstream` to look up the original
project's issues. This option does not change the starting branch: use `--base`
independently. Without a clear remote, Timber asks you to specify one in the
command. Only github.com remote URLs and positive issue numbers are supported.

Issue #123 titled "Fix login" generates `GH-123-fix-login`. The title may become
public when you push the branch; use a literal branch name for sensitive work.
Closed issues stop with a message; `-c` explicitly permits creating their worktree
without reopening the issue. PRs are refused. Existing branch/path collisions
still fail. Different remotes share the local `GH-123` shortcut, so `open GH-123`
can ask you to choose among matching branches. Opening existing work stays offline.

Authentication follows [GitHub CLI precedence](https://cli.github.com/manual/gh_help_environment):
process `GH_TOKEN`, then `GITHUB_TOKEN`, then the active github.com CLI account.
Blank overrides fail rather than falling back. Unset both variables to use a saved
login. Environment tokens can also be used without a saved login; Timber does not
load `.env` files. When running from source, use `bun --no-env-file src/index.ts`
to disable Bun's automatic dotenv loading. Private issues need repository access
and Issues read permission; see [GitHub's endpoint requirements](https://docs.github.com/en/rest/issues/issues#get-an-issue).
This version requires authentication for public lookup too. There is no automatic
anonymous fallback, issue search, issue updates or GitHub Enterprise support.

Developer smoke checklist: configure/check login in setup, create a worktree from
a known open issue without environment overrides, verify branch and browse link,
refuse a closed issue then allow it with `-c`, and verify `--remote upstream` in a
fork. HTTP doubles alone do not establish live GitHub access.

## Linear issues

Run `timber setup` or `timber setup --global`, select **Linear** under **Connections**, and
enter a personal API key. Create one under Account > Security & Access following
[Linear's instructions](https://linear.app/docs/api-and-webhooks). Give it **Read**
permission and access to the teams whose issues you use; write permission is not
needed. Workspace policy may restrict who can create keys.

The key is hidden while typing or pasting. Optionally check the draft login, then
choose **Save and exit**. The check uses the draft key and saves nothing. It verifies
authentication, not access to every team or issue. After a failed check, select
Linear again to correct it or cancel setup. Keep, replace and remove operate on the
draft; cancelling leaves existing credentials intact.

```sh
timber new linear:ENG-123
timber new linear:ENG-123 --base main -w feature
# Later, reopen using the existing offline ticket match:
timber open ENG-123
```

The current title becomes a branch such as `ENG-123-fix-login`, capped at
`max_generated_branch_name_length` (120 characters when unset) using the Jira naming rules. Titles can become public through pushed
branches, paths and logs. Title changes may produce another branch name; collisions
fail without adding suffixes. Creation prints the branch, path and Linear issue link
and follows ordinary setup, workflow, editor and agent settings.

Explicit whole-input `linear:<KEY>` always invokes Linear; bare keys also
use Linear when it is the default tracker. The key may be typed in any case. Triage, backlog, unstarted and started
issues are accepted; completed, canceled and duplicate require `-c`. Unknown states
and deleted/trashed issues always refuse. `--remote` applies only to GitHub issues. No URL input, suggestions/search,
OAuth, account chooser, issue updates or automatic closing is supported. `open`,
`ls` and `done` stay offline for Linear.

Both setup scopes share one plaintext personal key outside Git at
`${XDG_CONFIG_HOME:-$HOME/.config}/timber/credentials/linear.json` using the existing
absolute-XDG/HOME fallback rules. Linux storage is owner-only (0600 file, 0700
credential directory). Keep it private; never paste its contents into reports or
store the key in `.timber.toml`. Removing it in setup affects Linear only.

An explicitly supplied process `LINEAR_API_KEY` overrides the saved key. A blank or
invalid override fails instead of falling back. Unset it to use the saved login.
Timber does not explicitly load `.env` files, but Bun's development source runner
can load them before Timber starts. For source runs that must avoid them, use
`bun --no-env-file src/index.ts ...`.

Lookup uses one read-only GraphQL request with a 10-second deadline, rejects
redirects and never retries. Base, authentication, permission, missing/terminal issue,
rate-limit, network and response failures stop before creating a workspace. Fix the
reported condition and retry explicitly.

Developer smoke check with a live account:

1. Configure a Read key through setup and check the draft login.
2. Save, unset any `LINEAR_API_KEY` override, and select a known nonterminal issue.
3. Run `timber new linear:<KEY>` and verify the generated branch, path and issue link.
4. Reopen using its key and verify ordinary workflow/hooks behavior as applicable.

HTTP doubles do not establish live access. Record this manual check as not run
when no live test credentials are available.

## Guided setup and machine defaults

Before using Timber, run `timber setup` inside your repository, or
`timber setup --global` to configure defaults for this machine. From a source
checkout, use `bun run dev setup` or `bun run dev setup --global`. The first CLI
invocation also prints this hint, including for the standalone executable.

Setup opens a settings menu with an optional guided walkthrough. Edit editors,
coding assistants, the default issue tracker, tracker connections, creation scripts, pre-done scripts, Git,
and workspace folders individually. Setup opens directly on the menu and returns
there immediately after each edit. Save and exit is the default. Relevant help,
errors, and pending credential changes appear inline; PgUp/PgDn scroll long
details without leaving the active question. With Orca terminals selected, or inherited from machine
defaults, it also asks whether the assistant waits for setup scripts. Use Up/Down arrows and Enter, or press a numbered shortcut to choose
immediately. Shortcuts cover the first nine options; use arrows for additional
entries in long branch lists; the menu scrolls to keep your selection visible.
None is the default for unconfigured tools and scripts. Existing settings stay
selected by default; guided advanced settings are optional. Each question starts
after a blank line. Editor and agent launch
default to off; setup asks whether each configured tool should launch automatically.
Configure Jira with its site origin, token mode, Atlassian email, and hidden API
token, with asterisks showing typing and paste feedback. [Create a token](https://id.atlassian.com/manage-profile/security/api-tokens)
using Atlassian's [token instructions](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/).
Scoped tokens require the cloud UUID and use the Atlassian gateway; unscoped
tokens use the tenant origin. Find the cloud UUID at
`https://<your-site>.atlassian.net/_edge/tenant_info`, as described in
[Atlassian's cloud-ID guidance](https://support.atlassian.com/jira/kb/retrieve-my-atlassian-sites-cloud-id/).

You can keep, replace, remove, or skip personal credentials for the selected site
and token mode. Disabling Jira in one repository retains shared credentials;
explicit removal deletes that identity's pair for all repositories using it.
Setup shows the private plaintext credential destination and pending actions
before Save, with no token in review. An optional read-only connection check uses
the draft pair, even if environment overrides are present. It calls Jira's
[current-user endpoint](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/):
success does not guarantee access to every project or issue. Scoped tokens may
need current-user read scopes for this optional check. A failed check reports a
safe authentication/permission/network diagnostic and lets you edit or cancel.
Setup requires an interactive terminal with CI off. The final review shows the absolute destination and summary, with choices
to save, edit any individual section, or cancel. Editing retains the other answers
and returns to review; nothing is written until you choose Save. Replacing
existing settings requires that explicit save choice. Cancelling publishes
neither configuration nor credentials. Failed configuration saves restore owned
credential updates; concurrent edits survive with recovery guidance. Publication
is atomic per file, not across files: an uncatchable crash can leave credentials
updated before config, plus a stale `.jira.lock`. Inspect private storage and
configuration, restore a private backup if needed, remove only a confirmed stale
lock, then rerun setup. Never paste store contents into a report. Unsafe file
ownership, permissions, links, malformed data, and store locations inside Git
repositories are refused; choose a private user configuration directory.

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

`[editor]` or `[agent]` with a command and `enabled = false` disables automatic launch but
keeps `--editor` or `--agent` available. Root-level `editor = false` or `agent = false` removes the inherited command. Both
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

To install a standalone executable built from your checkout, follow the
[local installation and smoke-test guide](local-install.md).

## Orca editor terminals

Choose Orca terminals in setup to run setup and the assistant in separate terminals
of the existing local Orca window. Agents start alongside setup unless
`wait_for_setup = true`. `--no-editor` uses the invoking terminal instead.
Zed and VS Code open windows through the generic launcher.
See [configuration, prerequisites, and recovery](editor-terminals.md).

## Arena: multiple isolated attempts

`timber arena new <name-or-ticket>` gives at least two attempts the same task and starting
commit. Select an **agent tool**, optional **model** and **effort**, and **number of runs**.
Arena displays source details, numbered runs, setup progress, and recovery commands
in separate blocks. Terminal output uses color; `NO_COLOR=1` disables it. Redirected
output is plain unless color is explicitly forced with `FORCE_COLOR=1`.
Agents run one at a time in your foreground terminal; exit one before the next
starts. Manual worktrees need no agent configuration or AI subscription.

### Arena lifecycle

An existing local or remote branch can supply the starting commit, even without
its own worktree. `arena new` creates fresh attempt branches/worktrees from that
commit. The source branch remains intact. Existing arena names or attempt
destinations are refused; continuing an existing attempt belongs to resume.

| Command | Responsibility | Availability |
| --- | --- | --- |
| `arena new` | Create isolated attempts, prepare them, and launch agents sequentially in the invoking terminal | Implemented in [TIM-20](https://github.com/Coding-M8s/timber/issues/40) |
| `arena resume` | Select and revisit an existing attempt, preserving its current work; explicitly retry setup when needed | Implemented in [TIM-21](https://github.com/Coding-M8s/timber/issues/41) |
| `arena pick` | Compare attempts, let the user choose a winner, then archive and remove the others | Incomplete beta under active testing, [TIM-22](https://github.com/Coding-M8s/timber/issues/42) |

Creation displays attempt paths, live foreground agent output, and completion or
failure status. Grouped comparison belongs to `pick`: committed and uncommitted
tracked changes against the common base, plus separate untracked-file indicators.
These tickets keep winner selection with the user and preserve unsafe losing work.
They do not introduce parallel/background agent management, a collected final-answer
report, automatic quality scoring, or automatic merging/publishing.

The ticket-key shortcut below selects source context for a new arena; it follows
the same fresh-attempt lifecycle. Task instructions remain explicit.

```bash
# Guided tool → model → effort → runs, plus task entry (/done finishes):
timber arena new search-fix

# Two independent runs of one model; omit --model for tool default:
timber arena new search-fix --prompt-file task.md \
  --tool codex --model your-model-id --runs 2

# Compare tool/model combinations. Each --tool starts another group:
timber arena new compare --prompt-file task.md \
  --tool codex --model your-codex-model --runs 1 \
  --tool claude --model your-claude-model --runs 1

# Compare Cursor CLI with Codex, using each tool's default model:
timber arena new cursor-compare --prompt-file task.md \
  --tool cursor --tool codex

# Start from existing ticket progress; source worktree is not required:
timber arena new TIM-123 --name api-slice --prompt-file remaining-api-work.md \
  --tool codex --runs 2

# Explicit remote-only starting point, including a branch not fetched yet:
timber arena new api-slice --base origin/feature/TIM-123 \
  --prompt-file remaining-api-work.md --tool codex --runs 2

# Prepare unattended without starting agents:
timber arena new prepared --prompt-file task.md \
  --tool codex --runs 2 --no-agent --no-editor

# Manual attempts:
timber arena new manual-review --prompt-file task.md \
  --tool manual --runs 2 --no-editor
```

`--tool` starts a group. Its `--model` and `--effort` are optional; `--runs`
defaults to one. Model must precede effort when both are supplied. Repeat `--tool`
or `--preset` for another group. At least two runs are required overall; no fixed
upper count cap. Counts and their total must be positive safe whole numbers.
`--base` remains optional and selects starting code, not an existing attempt.

Tool, model, and preset choices support fuzzy search, including flag values:

```bash
# Partial tool/model names resolve after Enter; ambiguity opens a searchable list:
timber arena new compare --prompt-file task.md \
  --tool cur --model sonnet --tool cod --model sol

# Task already supplied; guided selection asks tool → model → effort → runs:
timber arena new compare --prompt "write hello world"
```

Exact values win, then canonical prefixes, then fuzzy matches. A unique match
resolves automatically; multiple matches require explicit selection. Type to filter,
use arrows and Enter, or Escape/Ctrl-C to cancel. Scripts never prompt: ambiguity
reports exact matching values before creation. Unknown custom model IDs remain
literal for the native tool to validate. IDs entered through the wizard's custom
model option always remain literal, even when they resemble catalog entries.
Resolved flag choices and preset keys remain exact in records;
there are no extra preset aliases. Search does not rewrite prompt text or base refs.

Model choices come from Cursor's `cursor-agent models`, Codex's local model cache,
and Claude's documented native aliases, supplemented by saved presets. Discovery
runs at most once per tool per invocation; native commands have closed stdin and
bounded runtime/output. Failed discovery is reported; native default, presets,
and exact custom IDs remain usable. Cached choices and aliases do not guarantee
account availability; native tools still enforce policy. Model defaults are never
guessed or copied from another active agent session.

`--default-effort <level>` supplies an arena-wide fallback. Each tool group's
`--effort <level>` overrides it; `--effort default` keeps that group's native
setting. Saved preset effort wins over the fallback; a native preset without
effort inherits it. Manual runs and opaque wrappers do not inherit native effort.
Every resulting native tool/model combination is validated before creation:
unsupported or unknown support is an error, never silently skipped. Use an explicit
model with capability data, or opt that tool group out with `--effort default`.

```bash
# Low for first Codex group, medium for second, native effort for Cursor:
timber arena new compare --prompt "Check whether 0.1 + 0.2 equals 0.3; explain briefly." \
  --default-effort low \
  --tool codex --model gpt-6-luna \
  --tool codex --model gpt-6-luna --effort medium \
  --tool cursor --model composer-2.5 --effort default
```

Effort appears after model selection when capability data supplies supported levels,
plus “Use tool/model effort default.” With an arena default, the wizard also offers
inheritance and native opt-out, including when model support is unknown. With no
arena or per-group effort, Timber passes no native effort override. Explicit effort
requires a known explicit model and supported level; unsupported/unknown settings
fail before creation. Codex uses its reasoning-effort configuration override;
Claude's general CLI help does not establish model-specific support, so its aliases
keep native effort defaults and do not offer an effort picker or accept overrides.
Select effort within Claude when supported. Cursor uses advertised model variants.
An explicit Cursor model ID and conflicting `--effort` are rejected;
in the wizard, choosing effort selects the corresponding advertised variant.
Manual worktrees have no model/effort. Custom IDs without capability metadata retain
native effort defaults. Tool/account policy can further restrict levels.

Run summaries distinguish requested effort from native defaults and always label
effective runtime effort as unknown. For Claude native defaults, an inherited
`CLAUDE_CODE_EFFORT_LEVEL` is shown and recorded when present. Only recognized
levels or `auto` are retained; other values are labeled `unrecognized`, with their
contents omitted. Explicit validated Claude effort sets both native `--effort` and
the child's `CLAUDE_CODE_EFFORT_LEVEL` to the same value, because that environment
variable can override the flag. Parent environment and other tools are unchanged.
Native settings, account policy, and in-session changes can still affect execution;
Timber's requested value is not proof of actual runtime effort.

Built-ins launch `codex`, `claude`, or `cursor-agent` on PATH. Cursor deliberately
uses `cursor-agent`: `cursor` opens the editor, and `agent` can belong to another
tool. Use installed, authenticated tools. Agents run sequentially in the invoking
terminal; exit one tool to proceed to the next.

Attempt count controls batch size; agents still run one at a time. Each attempt
needs its own worktree and setup, and planning/records hold the full batch in memory.
Available resources and runtime limits govern practical batch size. Removing the
count cap does not provide distributed swarm execution or establish million-attempt
scalability.

Named executable/model presets remain optional shortcuts:

```toml
[arena.agents.review]
tool = "claude"
command = "claude"
model = "your-model-id" # Optional; omit to use tool default.
args = []

[arena.agents.cursor-review]
tool = "cursor"
command = "cursor-agent"
model = "your-cursor-model-id" # Optional; omit to use Cursor default.
args = []

[arena.agents.custom]
tool = "wrapper"
command = "/absolute/path/to/my-agent-wrapper"
args = []
```

```bash
timber arena new review --prompt-file task.md --preset review --runs 2
timber arena new custom --prompt-file task.md --preset custom --runs 2
```

A preset saves one complete tool/model/effort/argument configuration. `--runs`
applies to the preceding tool or preset; following model/effort overrides on a
preset are rejected. Optional native `effort` belongs beside `model` in TOML.
Do not duplicate fields in native arguments: Codex `-m`/`--model` and Claude
`--model`/`--effort` remain supported when unambiguous. Cursor presets accept only
native `--model` arguments; effort must match the explicit model variant. Wrapper
models/effort stay in literal wrapper arguments. No native print, resume, workspace
override, or Cursor-created nested worktree behavior is added.

Presets merge by name; repository definitions replace whole same-name machine
presets. Per-name `false` and root `arena = false` disable inheritance. Setup
preserves these tables. `manual` and `configured` are reserved names. Interactive
creation can reuse ordinary `[agent]` arguments after explicit handoff selection;
ordinary agent/workflow configuration retains its behavior. Draft `--harness`,
`--attempts`, `--task-file`, `--participant`, and `--preset name:count` spellings
are not accepted.

**Starting point:** `--base` is optional. An explicit local/remote branch wins.
Without it, a ticket key seeks existing ticket branches: unique local progress
works offline, including unpublished branches with no worktree. Ambiguous matches
require selection or an exact `--base`. With no local match, live remote heads are
checked; discovery failure blocks creation. Ticket matches respect key boundaries
and slash-delimited branch segments (`TIM-123-work`, `feature/TIM-123`,
`user/TIM-123-api`), excluding `TIM-1234` and arbitrary substrings.

When no ticket branch exists, use configured base, selected remote default, then
unambiguous local main/master. Normal name-only creation uses that same precedence.
Ticket input supplies context, not task instructions: describe the remaining part
in your task file or prompt. No Jira credentials are required for Git ticket
matching. Exact uppercase ticket input derives a lowercase arena name; `--name`
lets separate portions of one ticket use distinct arena identities.

Remote selection is read-only before final review. Review shows source ref/commit,
tools/models, counts and destinations. Cancellation before confirmation leaves
refs and records untouched. After confirmation (or explicit noninteractive input),
fetch only the selected remote branch and verify the reviewed commit. If the tip
changed or refresh failed, stop before creating attempts and report that cached
refs may have refreshed. Every attempt starts at the same pinned commit; no extra
source worktree is created. Modified, untracked and ignored source files stay in
place; they are never copied/stashed or automatically committed.

Attempt branches are fresh `arena/<name>/<group-label>-<ordinal>` branches, using
existing worktree folder rules. Local branch/path and known remote target collisions
fail before creation; choose another arena name. Local sources use cached remote
inventory and remain offline. Remote sources also use discovered live inventory;
unfetched/unreachable remote name collisions cannot be ruled out offline.

Task files resolve from invoking cwd and must be nonsymlink regular UTF-8 files,
nonblank, without NUL, at most 1 MiB. Timber snapshots task bytes privately under
common Git metadata, outside checkout files. Native tools receive an identical
instruction to read that snapshot, separated from literal arguments with `--`.
Wrappers receive `TIMBER_TASK_FILE`, `TIMBER_ARENA`, `TIMBER_ATTEMPT`, `TIMBER_REPO`,
`TIMBER_WORKTREE`, and `TIMBER_BRANCH`; they read the task and keep their tool in
foreground. Task body never enters native agent argv or Timber diagnostics. Inline `--prompt`
text is present in Timber argv and may appear in shell history; use a file for
private instructions. `--prompt` and `--prompt-file` are mutually exclusive. With
neither, interactive task entry explains `/done` on each line. Tools may retain
transcripts/output. Native model execution/file permissions are not smoke-tested;
real terminal stubs verify argument/task transport and foreground behavior.

All worktrees and ordinary setup hooks finish before per-attempt editor/agent
startup. Editors default off; `--editor`/`--no-editor` override normal policy.
Noninteractive creation requires explicit prompt/file and groups, plus `--no-agent`
for native/wrapper agents. Errors or nonzero child exit stop later stages and retain
completed workspaces/refs/files. Agent statuses propagate, including 130/143 for
signal exits. Reciprocal UUID markers reject replaced worktrees immediately before
setup/editor/agent actions. Private v2 manifests record source/ticket/harness/model
context and optional requested effort; existing v1/v2 records remain readable
without migration or guessed model/effort defaults.

Inspect `timber ls`, then use `arena resume` below for recorded attempt recovery.
Ordinary `timber open --no-agent --no-editor -- '<absolute-worktree-path>'` remains
available for workspace inspection, including when arena metadata needs repair.
Ordinary `open --agent` uses ordinary configuration, not the recorded arena agent.
Use `arena pick` below to compare attempts and retain a winner. Private records are local visibility
controls, not encryption. Linux x86_64 remains the verified target.
See [arena contract](cli-contract.md#arena-creation-post-10-tim-20).

### Continue an existing arena attempt

`timber arena resume <name>` selects one existing attempt interactively and launches
its assigned agent in the invoking terminal. It keeps the attempt's current commits,
modified files, untracked files, and ignored files; it never resets to the starting
commit or recreates a missing branch/worktree. Hooks and agents retain their normal
ability to change files. Cancellation leaves files, refs, and arena records unchanged.

```bash
# Choose an existing attempt, then launch its recorded participant:
timber arena resume search-fix

# Exact recorded label, bypassing the chooser:
timber arena resume search-fix --attempt codex-1 --no-editor

# Deliberately rerun all ordinary setup hooks, then launch:
timber arena resume search-fix --attempt codex-1 --setup --no-editor

# Unattended preparation/revisit, without an agent or editor:
timber arena resume search-fix --attempt codex-1 --setup --no-agent --no-editor
```

`--attempt` accepts an exact recorded label, not a fuzzy query, branch, or path.
It is required without an interactive chooser. Native/wrapper agents require
interactive stdin/stdout and CI off; pass `--no-agent` for unattended use. Manual
attempts need no agent configuration. `--editor`/`--no-editor` follow ordinary editor
settings; Arena agents stay foreground even when ordinary new/open use Orca terminals.

Normal resume skips successful setup. Created attempts awaiting setup and failed or
interrupted setup require explicit `--setup` before launching an agent. That flag
reruns **every current ordinary `post_create` hook from the beginning**, not only
failed steps; use trusted hooks that are safe to rerun. No workflow hooks are added.
`--setup --no-agent` prepares only. A revisit without setup or agent launch keeps the
previous lifecycle/outcome record, even when editor startup fails.

Resume reuses the original private task snapshot and verifies its digest and reciprocal
Git/UUID membership before each setup/editor/agent boundary. It reconstructs recorded
tool/model/effort arguments from built-in selections or the original named/ordinary
configuration, requiring the stored fingerprint. No model catalog/fuzzy lookup occurs.
If configuration changed or disappeared, restore its original definition; if the
executable is missing, restore it or fix PATH. `--no-agent` can revisit without that
participant configuration, but existing global/repository configuration must still be
valid. Missing/tampered task or stale/replaced worktree identity blocks resume rather
than adopting another workspace. Existing V1/V2 records are supported without migration;
missing historical model/effort stays unknown, and unverifiable commands are refused.
A matching command cannot freeze external profiles, provider defaults, PATH binaries,
or tool versions. Requested effort is not proof of effective runtime effort; recorded
inherited effort observations are not replayed as overrides.

Existing invocation locks, uncertain `launch-running`, and unclassified failed stages
require manual inspection before explicit metadata repair. Resume never clears locks,
guesses whether an old process stopped, or kills a process. Setup/launch failures retain
work and print the affected attempt and retry command; numeric child statuses propagate,
including 130/143 for signal exits. Exit zero proves no quality or integration outcome.

**Workspace continuation is guaranteed for a valid recorded identity. Agent conversation
restoration is tool-specific, not universally supported.** Timber does not append native
conversation-resume flags or infer session IDs. An explicitly configured wrapper may
provide its own restoration behavior. See the [resume contract](cli-contract.md#arena-resume-tim-21).

### Choose an arena winner

**Beta feature: incomplete and under active testing.** Interface and behavior may
change before stable release. Help and each invocation show the beta status.

```bash
# Compare attempts with diff commands; changes nothing:
timber arena pick search-fix --inspect

# Choose a winner, review what will be removed, confirm (Cancel is default):
timber arena pick search-fix

# Exact winner, also usable without a terminal:
timber arena pick search-fix --winner codex-1
```

Each attempt shows its agent, state, commits since the arena base, uncommitted
changes, and untracked files, for example:

```text
  codex-1  codex (gpt-5, high effort), exit 0: 2 commits (4 files +120 -8)
  claude-1  claude, exit 0: 1 commit (2 files +40 -3), uncommitted 1 file +2 -1, 1 untracked
```

The winner's branch and workspace are left exactly as they are; nothing is merged
or pushed. Continue in its printed path.

Every other attempt is archived, then removed. Its commits and uncommitted,
non-ignored files are saved under `refs/timber/arena/<name>/<label>`, so a wrong
call is recoverable:

```bash
git worktree add -b claude-1-again ../claude-1-again refs/timber/arena/search-fix/claude-1
```

Ignored files such as `.env`, `node_modules`, and build output are deleted with the
worktree. Use `--keep-ignored` to keep attempts that contain them instead, and
`--keep-branch` to keep local loser branches. Remote branches are never touched.

Running or interrupted attempts, replaced or unrelated worktrees, and attempts
whose files change while pick runs are kept with a reason. The command then exits
nonzero and prints the exact rerun command; a rerun skips attempts already removed.
You can rerun with a different `--winner` while that attempt still has a
worktree; the previous winner is archived like any other loser.

Removal frees disk space. RAM is freed when agent processes exit; Timber never
kills them. See the [pick contract](cli-contract.md#arena-pick-tim-22).
