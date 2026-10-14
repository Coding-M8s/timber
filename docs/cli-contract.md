# Timber CLI behavioral contract

1. Discover repositories from nested directories and linked worktrees; distinguish the current worktree root from the common Git directory.
2. Git operations use the detected repository, not a hardcoded current directory.
3. `new <branch...>` creates a new branch from the configured or explicit base. The CLI joins its positional words with literal spaces; if the joined input contains U+0020, trim surrounding U+0020, lowercase, and replace each internal run of U+0020 with one hyphen. If the branch exists, report it and suggest `open`.
4. `open <input>` resolves an existing worktree, exact local branch, then exact remote branch. An explicit remote such as `origin/feature/foo` selects that remote. When cached refs cannot identify one local target, `open` discovers live remote heads without changing refs, respecting the explicit/configured remote or checking all remotes. Discovery failure blocks materialization; existing local targets remain offline.
5. A ticket prefix such as `ABU-834` may match branch names on a delimiter boundary. Multiple matches must include every distinct candidate in one chooser when interactive; mark candidates that require manual selection, and do not mutate if one is selected. Without a chooser, show at most five sorted candidates and the total, with exact manual-selection guidance. Do not use arbitrary substring matching.
6. Refresh the selected remote before creating from a remote branch. An existing local worktree can open offline. A failed remote refresh must not be reported as success.
7. Base selection: `--base`, repository/global config, configured remote's default branch, then an unambiguous existing `main` or `master`. Never guess if resolution is ambiguous.
8. Worktree paths default to a sibling directory, `../<repository-name>-worktrees/<safe-branch-slug>`. Resolve config paths relative to the primary repository root. Reject collisions, path traversal, and attempts to target the primary repository.
9. `ls` lists the current repository's primary and linked worktrees, including ones created outside Timber, and identifies the primary worktree.
10. `done` resolves cleanup targets among registered worktrees; remote-only and unchecked branches do not make a single matching worktree ambiguous. Multiple worktrees use the five-option chooser (or a capped diagnostic without a terminal), and selection is revalidated by absolute path and branch before cleanup. Cancellation succeeds without mutation. `done` never removes the primary worktree. Modified or untracked files always block cleanup. Unpublished or unknown publication blocks cleanup unless commits are contained in the validated base or Git proves that merging the local branch into that base adds no file changes.
11. Delete a local branch only when every local commit is reachable from its verified live remote upstream, its commits are contained in the validated base, or a successful Git virtual merge produces exactly the validated base tree. The latter proves content integration after a squash/rebase merge without requiring the original commit IDs or a live feature upstream. Recheck the target and preservation evidence before removal and branch deletion. Publication-only cleanup must verify the live upstream after the final local safety reads and again after worktree removal; changed upstream identity or lost publication retains the local branch. A missing base does not block verified publication, but a validated local base branch cannot be deleted. Use only built-in merge behavior: reject custom merge-driver configuration and disable renormalization for this proof. Conflicts, unsupported Git operations, and uncertain integration evidence never authorize deletion through that proof. `--keep-branch` retains the local branch; clean published worktree cleanup does not require integration with or without this option. Do not infer safety from a closed PR. Detached worktrees still require commit ancestry into the validated base.
12. No destructive `--force` in 0.1. No remote branch deletion, automatic stash, or implicit process killing.
13. `done` discards ignored files and directories, including `.env`, with the worktree by default. `--keep-ignored` refuses cleanup when ignored content exists, leaving those files, the worktree, and branch in their original locations; it does not copy them elsewhere. Retain `--discard-ignored` as a compatibility option. Reject combining it with `--keep-ignored`. Neither option bypasses modified/untracked files or commit/integration safety checks. Document the default in CLI help and the README.
14. Editors default to off until configured. Support `--no-editor`. Agent settings are parsed and retained in 0.1; agent launching remains 0.2. In 0.2 agent launching is opt-in, follows the editor, and owns the invoking terminal; see the launch contract below.
15. CLI success means required Git/setup work completed. If editor/agent startup fails after creation, retain the workspace and explain how to retry. Editor launch success is process startup only: Timber returns promptly and does not report a later nonzero editor exit, even when editor args include `--wait`.
16. Human output goes to stdout; errors go to stderr; failed operations return a nonzero exit code. Keep noninteractive behavior deterministic; never hang waiting for input in CI.

## `new` branch input

Quoted and unquoted sentence arguments are joined into the same raw input by the
CLI. Only inputs containing literal U+0020 spaces are normalized: remove leading
and trailing U+0020 spaces, lowercase, and replace each run of internal U+0020
spaces with one hyphen. Inputs without U+0020 remain byte-for-byte unchanged, so
exact Jira ticket detection continues to use the raw whole input. Reject blank
names and control characters before worktree creation; safely render the original
input in control-character diagnostics. Preserve other characters for installed
Git to validate. Do not slugify punctuation, truncate names, or append suffixes.

## Repository configuration

Read `.timber.toml` from the primary worktree root and Linux machine defaults from `${XDG_CONFIG_HOME:-$HOME/.config}/timber/config.toml`. Empty or relative XDG paths use the HOME fallback. Do not search nested or linked-worktree configuration. Validate both existing files independently; unknown keys, unreadable files, and invalid values are errors even when overridden in the other scope. Missing files use defaults.

The supported 0.1 keys are `base_branch`, `remote`, `worktree_dir`, `[editor]`, and `[agent]`. `base_branch` and `remote` default to absent. `worktree_dir` defaults to absent and, when relative, resolves against the primary root. `[editor]` requires a non-empty executable `command`; `args` is a string array defaulting to `[]`. `[agent]` also requires `command` and accepts `args` defaulting to `[]` plus boolean `enabled` defaulting to `false`. Agent settings are parsed and retained in 0.1; agent launching remains 0.2.

Precedence is explicit CLI options > repository TOML > global TOML > built-in defaults. Absent keys inherit. Present optional tables replace the whole lower-scope table: executable/argument combinations stay together, and argument arrays and hook lists never concatenate. Relative `worktree_dir` in either scope resolves against the current repository's primary root. Root-level `editor = false`, `agent = false`, `hooks = false`, or `jira = false` explicitly disables that inherited integration; `true` is invalid. An agent table with a command and `enabled = false` still supports explicit `--agent`, whereas `agent = false` removes the inherited command. Diagnostics identify the config file and invalid field without printing config values. Do not store credentials or other secrets in this file; use environment variables or a secret store. Hooks and Jira are optional 0.2 extensions described below.

```toml
base_branch = "main"
remote = "origin"
worktree_dir = "../timber-worktrees"

[editor]
command = "zed"
args = ["--new"]

[agent]
enabled = false
command = "claude"
args = []
```

An alternative for Visual Studio Code is:

```toml
[editor]
command = "code"
args = ["--new-window"]
```

The editor executable must be available on `PATH` or configured by absolute path. Editor and agent commands are executable names plus argument arrays, never shell command strings. Pass editor arguments literally and append the absolute selected worktree path as the final argument. On startup failure after worktree creation, retain the worktree and provide a retry command of the form `timber open -- '<absolute-worktree-path>'`; retry opens the existing worktree after the user fixes the editor configuration or `PATH`. The retry string is display text and must not be executed internally. Trusted shell hooks, when implemented, receive context through environment variables; do not substitute branch names or ticket text into shell source.

## Jira ticket lookup (0.2, TIM-10)

Jira lookup is enabled when the resolved repository/global configuration has a
`[jira]` table; local `jira = false` disables a global Jira integration. The strict table accepts `site_url` and optional `cloud_id` only:

```toml
[jira]
site_url = "https://example.atlassian.net"
# Optional for scoped API tokens:
cloud_id = "00000000-0000-0000-0000-000000000000"
```

`site_url` must be an HTTPS Atlassian Cloud tenant origin on `*.atlassian.net`,
with no user information, nondefault port, query, fragment, or path other than `/`;
the trailing slash is normalized away. `cloud_id`, when present, must be a UUID.
Credentials are read lazily from `JIRA_EMAIL` and `JIRA_API_TOKEN` only when a
recognized ticket is resolved. Never put credentials in repository config, logs,
tickets, or commits. Timber does not load `.env` files; it reads these values only
from its process environment. Standalone release builds disable automatic `.env`
and `bunfig.toml` loading. Bun's source runner automatically loads `.env` files
before Timber starts unless disabled. To run a source checkout without Bun loading
them, use `bun --no-env-file src/index.ts ...`. An absent effective `[jira]` (including local `jira = false`) disables lookup
even if the environment contains credentials.

Only a whole input matching `^[A-Z][A-Z0-9]*-[0-9]+$` is recognized as a ticket,
and only in a Jira-enabled repository. Do not trim or change case. Inputs such as
`feature/foo`, `ABU-834-fix`, and `abu-834` remain literal branch names; a
ticket-looking literal can be named explicitly as `feature/ABU-834`.

Lookup uses Basic authentication with the Atlassian account email and API token,
`Accept: application/json`, and one
`GET /rest/api/3/issue/<encoded-key>?fields=summary,status`.
Without `cloud_id`, the API root is the configured site. With `cloud_id`, use only
`https://api.atlassian.com/ex/jira/<cloud_id>`; never infer token type or retry on a
different host. Reject redirects so credentials cannot be forwarded. A 10-second
deadline covers the complete response body and validation. Do not retry
automatically. Validate Jira's returned canonical key and nonblank summary; ignore
unrelated response fields and build the browse URL from the configured site and
canonical key. Also request `status` and require
`fields.status.statusCategory.key` to be `new`, `indeterminate`, or `done`.
Reject `done` with a diagnostic naming the returned canonical key, before branch
or worktree creation. Missing, null, or unknown status categories fail closed.
Use only the category key; status display names may be localized or customized, and
resolution fields do not override it.

For a recognized ticket, `new` validates its base before lookup. If the exact issue
is available and active, it generates `<canonical-key>-<summary-slug>` before the
existing Git creation checks. Normalize the summary with NFKD, remove combining
marks, lowercase, replace each run outside ASCII letters and digits with `-`, trim
hyphens, and cap the entire generated name at 120 ASCII characters while preserving
the key. Use `issue` if the summary leaves no slug characters. Git remains
authoritative for branch validity, existing refs, and path collisions; do not append
numeric suffixes or bypass collisions. Report the generated branch and browse URL
only after creation succeeds. The title contributes to a public-looking Git branch,
so use a literal branch when a title is sensitive. If a title changes, `new` may name
a different branch; use `open ABU-834` to resume an existing ticket branch offline.

Only an exact issue 404 or a `done` status-category result enables suggestions. The
read-only [enhanced JQL search endpoint](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
uses the requested key's project and the fixed query
`project = "<project-key>" AND statusCategory != Done ORDER BY key ASC`, requests
`summary,status` with up to 100 results per page, and follows `nextPageToken` until
`isLast` is true. Every page shares one 10-second deadline. Reject redirects, do not
retry, and treat missing or repeated continuation tokens as an incomplete search.
Filter results locally to valid keys whose full key starts with the requested key;
exclude the exact key and any issue without a known active category (`new` or
`indeterminate`). Deduplicate and sort by key before showing the exact eligible
count. Do not accept user-supplied JQL. If any page fails or is malformed, stop
without displaying a partial list and preserve the original missing/complete reason
with a safe suggestions-failed diagnostic.

When suggestions exist, include the original safe missing/complete diagnostic in
the chooser prompt and ask for an explicit choice, even for one result. The chooser
is available only when stdin and stdout are TTYs and `CI` is unset or equals
`false` case-insensitively; it starts with five options and shows all matches only
after an explicit warning and confirmation. Cancelling the Jira, `open`, or `done`
chooser prints `Cancelled.` to stdout, exits successfully, and makes no Git, hook, or editor
changes. Without a chooser, report at most the first five sorted key/title labels,
the exact count, and guidance to run a candidate key explicitly or rerun in an
interactive terminal. Validate the chooser's returned stable value against the
offered results, then fetch the chosen exact issue again and use its current
canonical key and summary. If it became missing or complete, fail without another
suggestion search. Authentication, missing credentials, permission, rate-limit,
server, timeout, network, redirect, malformed-response, and unknown-status failures
do not trigger suggestions. All diagnostics omit credentials, response bodies, raw
transport exceptions, and config values. `open`, `ls`, and `done` do not call Jira
and do not require credentials. Jira URL inputs and OAuth login are outside this
integration.

## Setup hooks (0.2, TIM-7)

The strict `[hooks]` table accepts only `post_create`, a string array defaulting
to `[]`. Each command must contain non-whitespace source and no NUL bytes;
preserve its source literally. Absent hooks mean setup is off. Read hooks only
from the primary root's config, never the linked worktree's config.

`new` and `open` run setup after creating a worktree and before launching its
editor or agent. Normal `open` reuses an existing worktree without setup. `open --setup`
explicitly runs every step from the beginning for the selected worktree,
including primary and detached worktrees; creation plus `--setup` runs once.
`--no-editor` does not disable setup.

On Linux, invoke `/bin/sh` with argument array `["-c", configuredSource]` for
each step, sequentially, with worktree cwd, closed stdin, and stdout/stderr
streamed to their respective invoking streams. Each step has its own shell;
there is no implicit `set -e`. Hooks are trusted code with the user's permissions
and inherited environment. Document this trust boundary and safe reruns.

Override `TIMBER_REPO` with the absolute primary root, `TIMBER_WORKTREE` with
the selected absolute path, and `TIMBER_BRANCH` with the selected local branch
name (empty for detached HEAD). Set `TIMBER_TASK_ID` to the branch's leading
`[A-Z][A-Z0-9]*-<digits>` ticket ID only when followed by end or `-`, `_`, `.`, `/`;
otherwise remove any inherited value. Context values are environment data,
never substitutions into shell source.

Failure returns nonzero, identifies the one-based step and exit code/signal
or shell startup failure, stops subsequent hooks and launch, and retains all
workspace state. Do not echo shell source in the diagnostic or roll back hook
changes. Report a safely quoted retry of the form
`timber open --setup -- '<absolute-worktree-path>'`; use a printable Bash retry
for paths containing terminal controls. Timber never executes the retry text.

## Interactive agent launching (0.2)

`new` and `open` accept `--agent` and `--no-agent`. Omission defers to
`agent.enabled`; explicit enable overrides false and explicit disable overrides
true. Both flags together are an error. Explicit enable without an agent table
is an actionable preflight error, before any Git creation.

The agent starts only after successful required Git/setup work and successful
or skipped editor startup. Keep the launcher separate from the editor: pass
command/args literally with no shell, set cwd to the selected worktree, inherit
stdin/stdout/stderr, and await the foreground child. Never detach or unref it.
Do not append the worktree path to agent args.

Require stdin and stdout terminals and CI off. CI is off when absent, empty,
"0", or "false" (case insensitive). Other nonempty values enable CI. When
noninteractive, config-driven launch skips and explicit --agent fails before
Git creation. No agent prompt can block unattended commands.

Normal agent exits propagate their numeric status. SIGINT/SIGTERM exits produce
130/143. Terminal Ctrl-C reaches the foreground child directly and is not
forwarded a second time. Parent SIGTERM and non-TTY parent SIGINT are forwarded
to the owned child; Timber waits for its actual exit status. A caught interrupt
does not override a later normal exit. With a terminal, send SIGINT to the
foreground process group or SIGTERM to Timber for process-directed shutdown. Remove signal listeners on completion. Do not manage unrelated
processes or create a session manager.

Startup failure returns 1, writes an actionable stderr diagnostic once, and
retains all completed workspace state. Retry after fixing configuration/PATH:
`timber open --agent --no-editor -- '<absolute-worktree-path>'`.
Safely quote/escape this display text; never execute it internally. Nonzero
agent exit and interruption also identify retained workspace state. Child
output is inherited directly; do not log command arguments or raw startup
errors that might contain secrets.

Existing editor failure behavior remains: new returns nonzero, while open
reports failure and returns success after completed Git work. Both suppress
agent startup.

## Guided configuration (TIM-18)

`timber setup` guides configuration in the primary checkout from its root, a nested
directory, or a linked checkout. `timber setup --global` configures defaults for
all repositories and works outside Git. Both require interactive stdin/stdout and
CI off; noninteractive use fails with guidance and no writes. Main questions cover editor, agent, and Jira ticket naming; scripts and Git/folder
defaults live in an optional advanced section, skipped by default. Blank Enter
leaves new settings absent or retains existing values. Each question is separated
by a blank line. Terminal selectors support Up/Down arrows and Enter; single-key
number shortcuts 1–9 select immediately. Additional options in long menus use
arrows, with no ambiguous multi-digit shortcuts; menus show a viewport sized to
the terminal height and keep the highlighted choice visible. q/Escape/Ctrl-C/EOF cancel and
terminal input mode is restored. Agents default to disabled. Executable
checks do not launch anything; new custom executable selections must be program
names on PATH or absolute paths, never relative paths that change meaning across
workspaces. Setup never changes refs, creates worktrees, runs
hooks, or edits shell startup files. Jira credentials remain environment variables.

Show the destination, scope, and summary with an explicit save/replacement choice,
individual editor/agent/Jira/hooks/base-branch/remote/workspace-folder edit choices,
and cancellation (the default). Editing preserves the other draft answers, uses
current draft values for keep/reset choices, and returns to the updated review.
Advanced sections remain editable even if skipped initially. Invalid scalar edits
retry their input without discarding the draft. No writes occur until Save.
Invalid existing TOML is preserved. Generated readable TOML
round-trips through the actual parser. Local setup adds `/.timber.toml` to the
Git-discovered common `info/exclude`, preserving existing entries, and verifies
effective ignoring before publishing an untracked config. Conflicting project
ignore rules lead to global setup or cancellation, never shared `.gitignore` edits.
Tracked config needs explicit edit/global/cancel selection; setup never untracks
or stages it. Exclusion is local visibility control, not encryption or protection
from a forced add. Keep secrets outside both config files.

Use validated temporary files, atomic publication and no-clobber creation for new
config. Detect concurrent changes and coordinate Timber writers with locks.
Existing-file replacement has a remaining check-to-rename race with unrelated
editors; ignoring is verified at a point in time. Cancellation before config
publication restores owned exclusion changes when safe; concurrent edits survive
with an incomplete-rollback diagnostic. Publication is the commit point; later
interrupts finish cleanup and report saved state. An uncatchable crash can leave
an extra exclusion entry; the two paths are not one atomic transaction.

The first CLI invocation prints installation guidance once, recording a marker
under `${XDG_STATE_HOME:-$HOME/.local/state}/timber/` outside repositories. If that
marker already exists or cannot be written, skip the hint; state errors never
change command results or produce repeated noise. Ordinary commands do not
repeat the setup hint when settings are absent. Explicit `--agent` without a
configured agent fails before mutation and points to local/global setup.
Malformed configuration still reports its actionable error. `ls` validates both
scopes while remaining offline and read-only. Guidance never starts setup or
blocks CI implicitly.

## Bash completion (TIM-23)

`timber completion bash` emits an activation script without editing shell startup
files. The generator and hidden completion transport bypass installation guidance,
first-use state writes, and interactive selection. Unsupported shells produce an
actionable error; Zsh/Fish are future adapters.

Public command and flag suggestions derive from the same Commander definitions
as dispatch and help. Repository suggestions read fresh Git worktree inventory
and cached refs without loading configuration, scanning file status, contacting
remotes, changing files/refs, running hooks, or launching editors/agents.
`done` offers only linked worktrees by branch/absolute path, including detached
paths. `open` also offers primary paths, local branches, and explicit
`remote/branch` cached selectors. A branch registered in several worktrees is
offered only by path, since its name is ambiguous at execution. Symbolic remote HEAD entries are omitted.
`new --base` can complete local/cached branch refs.

Prefix matching is literal and results are deduplicated and sorted. Missing Git,
inaccessible metadata, and non-repositories quietly yield no target candidates;
command/flag completion still works. The Git reads behind one Tab press share a
one-second deadline and skip optional locks; a stalled Git yields none as well. Dirty/stale/locked entries remain discoverable
and never imply safe cleanup. Normal execution retains all preservation checks.
Shell-independent candidate lookup returns raw selectors. Bash transports them
with NUL separators and quotes insertion literally, including spaces and shell
metacharacters, without evaluating candidate text. See [Bash completion](completion.md)
for activation and the actually verified Bash/Linux environment.
