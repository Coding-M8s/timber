# Timber CLI behavioral contract

1. Discover repositories from nested directories and linked worktrees; distinguish the current worktree root from the common Git directory.
2. Git operations use the detected repository, not a hardcoded current directory.
3. `new <branch...>` creates a new branch from the configured or explicit base. The CLI joins its positional words with literal spaces; if the joined input contains U+0020, trim surrounding U+0020, lowercase, and replace each internal run of U+0020 with one hyphen. If the branch exists, report it and suggest `open`.
4. `open <input>` resolves an existing worktree, exact local branch, then exact remote branch. An explicit remote such as `origin/feature/foo` selects that remote. When cached refs cannot identify one local target, `open` discovers live remote heads without changing refs, respecting the explicit/configured remote or checking all remotes. Discovery failure blocks materialization; existing local targets remain offline.
5. A ticket prefix such as `ABU-834` may match branch names on a delimiter boundary. Multiple matches must include every distinct candidate in one chooser when interactive; mark candidates that require manual selection, and do not mutate if one is selected. Without a chooser, show at most five sorted candidates and the total, with exact manual-selection guidance. Do not use arbitrary substring matching.
6. Refresh the selected remote before creating from a remote branch. An existing local worktree can open offline. A failed remote refresh must not be reported as success.
7. Base selection: `--base`, repository/global config, configured remote's default branch, then an unambiguous existing `main` or `master`. Never guess if resolution is ambiguous. `done --base <ref>` selects an invocation-local integration target using the existing branch/ref resolver; it never writes TOML or changes a local branch tip. An explicit missing, invalid, ambiguous, or target-local-branch base fails before hooks or removal, even with verified publication or `--keep-branch`. Revalidate the same selected ref/commit before removal and branch deletion. Omission preserves configured/default-base and live-publication behavior. No automatic parent-branch inference. Before cleanup, automatically refresh a selected remote base (explicit, configured or default); explicitly selected local bases remain local. Fetch only its exact remote branch without tags, pruning, submodule recursion or destination ref, verify FETCH_HEAD against its live advertisement, then conditionally update only the selected direct remote-tracking ref without following symbolic refs. Discovery/fetch failure, a moved advertised tip or concurrent cached-ref change stops before hooks/removal with no cached fallback. Re-read worktree identity, status and the selected base after refresh; changing base selection also stops. Fetch metadata and the selected remote-tracking ref may change even if subsequent safety checks refuse cleanup. Read-only inspection does not fetch.
8. Worktree paths default to a sibling directory, `../<repository-name>-worktrees/<safe-branch-slug>`. Resolve config paths relative to the primary repository root. Reject collisions, path traversal, and attempts to target the primary repository.
9. `ls` lists the current repository's primary and linked worktrees, including ones created outside Timber, and identifies the primary worktree.
10. `done` resolves cleanup targets among registered worktrees; remote-only and unchecked branches do not make a single matching worktree ambiguous. Multiple worktrees use the five-option chooser (or a capped diagnostic without a terminal), and selection is revalidated by absolute path and branch before cleanup. Cancellation succeeds without mutation. `done` never removes the primary worktree. Modified or untracked files always block cleanup. Unpublished or unknown publication blocks cleanup unless commits are contained in the validated base or Git proves that merging the local branch into that base adds no file changes or its complete tree matches a commit reachable from the validated base.
11. Delete a local branch only when every local commit is reachable from its verified live remote upstream, its commits are contained in the validated base, or Git proves content integration: a successful virtual merge produces exactly the validated base tree, or the complete local tip tree matches a commit reachable from the pinned validated base. Historical tree equality preserves the complete snapshot even after later base edits or reverts, without requiring the original commit IDs or a live feature upstream. Recheck the target and preservation evidence before removal and branch deletion. Publication-only cleanup must verify the live upstream after the final local safety reads and again after worktree removal; changed upstream identity or lost publication retains the local branch. A missing base does not block verified publication, but a validated local base branch cannot be deleted. Use only built-in merge behavior: reject custom merge-driver configuration and disable renormalization for this proof. Virtual merge conflicts alone never authorize deletion; historical integration requires exact full-tree equality from a successful, hash-validated history read rooted only at the pinned base commit. Unsupported Git operations and uncertain integration evidence never authorize deletion through these proofs. `--keep-branch` retains the local branch; clean published worktree cleanup does not require integration with or without this option. Do not infer safety from a closed PR. Detached worktrees still require commit ancestry into the validated base.
12. No destructive `--force` in 0.1. No remote branch deletion, automatic stash, or implicit process killing.
13. `done` discards ignored files and directories, including `.env`, with the worktree by default. `--keep-ignored` refuses cleanup when ignored content exists, leaving those files, the worktree, and branch in their original locations; it does not copy them elsewhere. Retain `--discard-ignored` as a compatibility option. Reject combining it with `--keep-ignored`. Neither option bypasses modified/untracked files or commit/integration safety checks. Document the default in CLI help and the README.
14. Editors default to off, including when a command is configured without `enabled = true`. `new` and `open` accept `--editor` and `--no-editor`; explicit enable or disable overrides `[editor].enabled`. Agent settings are parsed and retained in 0.1; agent launching remains 0.2. In 0.2 agent launching is opt-in and uses either the invoking terminal or explicitly selected editor terminals; see the launch contracts below.
15. CLI success means required Git/setup work completed. If editor/agent startup fails after creation, retain the workspace and explain how to retry. Editor launch success is process startup only: Timber returns promptly and does not report a later nonzero editor exit, even when editor args include `--wait`.
16. Human output goes to stdout; errors go to stderr; failed operations return a nonzero exit code. Keep noninteractive behavior deterministic; never hang waiting for input in CI.

## Rebase an existing worktree (TIM-28)

`timber rebase <branch-or-worktree> [--base <ref>]` requires
an existing Git-registered worktree, selected by exact branch, absolute path, or
existing delimiter-boundary ticket matching. Filter ambiguous matches to registered
worktrees, use the existing chooser/capped diagnostic, and cancel without mutation.
Never create a worktree or branch. Reject detached, missing, stale, locked, or
unverifiable targets, and branches checked out in multiple worktrees. Primary
worktrees are eligible when explicitly selected.

Use explicit base, saved worktree base, effective configured base, selected remote
default, then an unambiguous remote main/master. A remote-qualified base selects
that remote; otherwise require configured or sole remote. Plain names always mean remote
branches here, even when a same-named local branch exists. Explicit
`refs/heads/<branch>` selects a local base. Saved canonical identities retain local
versus remote meaning regardless of later config changes. A local base uses its
current commit without fetching, pulling or moving it, and its direct ref and tip
are revalidated before mutation. Warn before proceeding that the local branch must
be up to date and Timber will not fetch or pull it. Local bases work without remotes.

For remote bases, discover live remote heads to validate defaults/fallbacks. Fetch
only the selected branch without
pruning or modifying branch refs: fetch into FETCH_HEAD with an empty refmap,
without a destination ref. This also avoids symbolic cached refs redirecting writes
into local branches. Pin/verify FETCH_HEAD against the advertised commit; a moved
base requires a retry. Never fall back to cached refs after discovery/fetch failure.
Fetch metadata may change even if later preflight fails; cached refs stay untouched.

Revalidate the selected absolute path, reciprocal Git identity, Git administrative
directory, checked-out branch and original tip before and after network operations
and immediately before rebase. Refuse staged/unstaged/untracked/unmerged files and
existing rebase/am/merge/cherry-pick/revert/sequencer state. Preserve ignored content;
refuse path collisions with the incoming base or commits that may be replayed,
including directory/file prefix collisions. Safety reads cannot lock out unrelated
concurrent writers; users must not edit the target during the operation.

An already integrated base is a no-op and leaves ignored content untouched.
Run Git in the target cwd with literal argument arrays, closed stdin and disabled
editors, autostash, automatic unrelated-ref updates, interactive rebase and autosquash.
Await one owned noninteractive Git process group; cancellation signals that group,
including Git hook descendants. Never run Timber setup hooks, editors or agents;
ordinary Git hooks remain Git's responsibility. Do not stash, clean, reset, skip, abort, push or force-push automatically.
Report worktree, branch, selected base, pinned commit and original tip; identify
remote fetches versus local selection.
Rebase can rewrite published commit IDs; publishing remains a separate user action.

Completed/up-to-date returns zero. Conflicts return nonzero, keep Git's paused state,
and list every unmerged path from NUL-delimited Git output with safe filename
rendering, including binary and add/delete conflicts. Distinguish conflicts from
fetch, startup, hook rejection, interruption and other failures. Report preserved
state and safely quoted `git -C '<path>' rebase --continue` / `--abort` guidance;
resolve and stage before continuing, which may expose later conflicts. Rerunning
Timber refuses an existing operation. Cleanup refuses in-progress Git operations,
even when conflicts are staged and the index has no unmerged paths. Native Git
continuation/abort suffice; no Timber continuation flags or AI resolution.

## Saved worktree bases (#79)

`new` saves its resolved canonical base ref in private, versioned Git-admin metadata
before setup or launches. Store the moving branch identity, not its creation commit.
Metadata is bound to the canonical repository/worktree paths, validated like workflow
associations, and published atomically with private permissions. Save failure retains
the created worktree and reports recovery guidance. `open` does not infer or overwrite
bases for existing or materialized branches. Arena creation is unchanged.

`ls` adds a BASE column before WORKFLOW: remote bases display `remote/branch`, local
bases display `refs/heads/branch`, absent records display `-`, and invalid records
show `?` plus a warning without hiding the Git row. Listing remains offline and does
not validate whether a saved branch still exists. Never infer parent branches from
history or from a feature branch's publication upstream.

`rebase` uses explicit selection before saved metadata, then existing config/default
selection. Missing saved targets stop with `--base` replacement guidance, without a
fallback. Invalid metadata stops before mutation; stale identity records may be
replaced by an explicit selection, while malformed or unreadable records require
repair first. Save the selected canonical ref after success, an up-to-date result,
or a verified paused rebase with unmerged conflicts. Other failures retain the
previous association. Metadata publication failure after rebase reports the actual
Git outcome and recovery guidance; it never resets or aborts Git. Conflicts retain
native Git continuation/abort behavior. A later native abort does not restore the
previous saved association. Cleanup base selection remains unchanged.

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

The supported 0.1 keys are `base_branch`, `remote`, `worktree_dir`, `[editor]`, and `[agent]`. `base_branch` and `remote` default to absent. `worktree_dir` defaults to absent and, when relative, resolves against the primary root. `[editor]` requires a non-empty executable `command`; `args` is a string array defaulting to `[]`, and boolean `enabled` defaults to `false`. `[agent]` also requires `command` and accepts `args` defaulting to `[]` plus boolean `enabled` defaulting to `false`. Agent settings are parsed and retained in 0.1; agent launching remains 0.2. Editor tables additionally accept `integration = "orca"`; agent tables accept boolean `wait_for_setup` (default false), as specified in TIM-27 below.

Precedence is explicit CLI options > repository TOML > global TOML > built-in defaults. Absent keys inherit. Present optional tables replace the whole lower-scope table: executable/argument combinations stay together, and argument arrays and hook lists never concatenate. Relative `worktree_dir` in either scope resolves against the current repository's primary root. Root-level `editor = false`, `agent = false`, `hooks = false`, or `jira = false` explicitly disables that inherited integration; `true` is invalid. Editor and agent tables with a command and `enabled = false` still support explicit `--editor` and `--agent`, respectively; root-level `false` removes the inherited command. Diagnostics identify the config file and invalid field without printing config values. Do not store credentials or other secrets in this file; use environment variables or a secret store. Hooks and Jira are optional 0.2 extensions described below.

```toml
base_branch = "main"
remote = "origin"
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

An alternative for Visual Studio Code is:

```toml
[editor]
command = "code"
args = ["--new-window"]
enabled = false
```

The editor executable must be available on `PATH` or configured by absolute path. Editor and agent commands are executable names plus argument arrays, never shell command strings. Pass editor arguments literally and append the absolute selected worktree path as the final argument. `--editor` requires a configured command and fails before worktree creation if one is absent; `--editor` with `--no-editor` is an error before mutation. On startup failure after worktree creation, retain the worktree and provide a retry command of the form `timber open --editor -- '<absolute-worktree-path>'`; retry opens the existing worktree after the user fixes the editor configuration or `PATH`. The retry string is display text and must not be executed internally. Trusted shell hooks, when implemented, receive context through environment variables; do not substitute branch names or ticket text into shell source.

## Named worktree workflows (TIM-25)

`new` and `open` accept `--workflow <name>`, `-w <name>`, and `--w <name>` with identical behavior. Supplying two spellings or repeating one is an error before mutation. Names must match `^[a-z][a-z0-9_-]*$` and are case-sensitive. Invalid or unknown names fail before Git creation, hooks, editor, or agent launch. One workflow can be assigned to each worktree. No workflow is selected implicitly.

Define names in either config scope:

```toml
[workflows.review]
description = "Review a teammate's branch"
post_create = ["bun install --frozen-lockfile"]

[workflows.review.editor]
command = "code"
args = ["--new-window"]

[workflows.review.agent]
command = "/absolute/path/to/review-wrapper"
args = ["--initial"]
```

Each workflow table accepts only `description` (a nonblank string), `post_create` (an array of nonblank shell sources without NUL), `editor` (a complete executable/argument table or `false`), and `agent` (a complete executable/argument table or `false`). Launcher `args` default to `[]`; workflow launchers have no `enabled` key. Omitted editor/agent fields inherit ordinary `[editor]`/`[agent]` settings and their `enabled` defaults, while `false` suppresses the inherited launcher. Workflow editor tables request launch when the workflow is selected; workflow agent tables request an initial launch on creation when an interactive invoking terminal or enabled, selected Orca integration can host the agent. Explicit `--editor` or `--agent` on a workflow with the respective launcher set to `false` selects the ordinary configured launcher, if any. `--no-editor` and `--no-agent` always suppress those launches.

Both config scopes are validated independently. Workflow definitions merge by name: a repository definition replaces the complete same-name global definition, including scripts and launcher arguments. A repository `[workflows]` table can set `review = false` to remove that inherited name; root `workflows = false` disables all inherited names. Hook lists and argument arrays never concatenate across scopes. Guided `timber setup` preserves workflow values through save and displays the effective count; edit workflow definitions directly in TOML.

Outside enabled Orca integration, on local worktree creation, including `open` materializing an existing local or remote branch, Timber saves the selected name, runs ordinary `post_create` hooks, runs workflow `post_create` hooks, opens the effective editor, then starts the initial agent. The name is saved before scripts run. Setup receives `TIMBER_WORKFLOW` as environment data; an unassigned worktree has no inherited `TIMBER_WORKFLOW`. Shell source is never interpolated. A user's executable or wrapper may supply its preferred prompt or open a separate window; Timber itself keeps the agent in the invoking foreground terminal and passes arguments literally.

An existing worktree can be assigned or reassigned with `open --workflow <name>`; this saves the name and applies the selected editor launch policy without creation scripts or an implicit agent. Ordinary later `open` uses the saved name and the current workflow editor configuration, but never replays creation scripts or any implicit agent, even when global `[agent].enabled = true`. Repeating `open --workflow <same-name>` behaves the same. `open --setup` deliberately reruns ordinary then workflow scripts from the start once; it does not imply an agent launch. `open --agent` deliberately launches the current workflow agent or inherited ordinary agent, including its initial prompt arguments; `--no-agent` suppresses it. Agent launch requires either an interactive stdin/stdout terminal with CI off or an enabled, selected Orca editor integration. Without either host, explicit agent launch fails before mutation and config-driven agent launch skips.

The association is local JSON inside the selected worktree's private Git administrative directory, never a committed worktree file or a branch/release tag. It stores a version, name, and Git/worktree identity paths only. Reads verify Git's reciprocal identity and record identity. Missing records mean unassigned; stale or malformed records never select another workflow. A missing workflow definition leaves the saved name visible in `ls` and makes ordinary `open` fail with guidance to restore it or explicitly assign a valid one. `ls` shows `?` and a safe warning for unreadable/stale metadata while keeping every Git row. Git removal of a linked worktree removes its private administrative metadata; retaining a branch does not retain the workflow association.

Failures after creation retain the worktree, refs, and script files. In foreground mode, script failures stop editor and agent launch; editor startup failure stops agent launch. An ordinary reopen does not retry creation actions. Repair and deliberately rerun scripts with `timber open --setup -- '<absolute-worktree-path>'`; retry the editor with `timber open --editor -- '<absolute-worktree-path>'`; retry the agent with `timber open --agent --no-editor -- '<absolute-worktree-path>'`. A failed association write reports an explicit `open --workflow <name>` repair command. Scripts must tolerate explicit reruns. Timber does not promise exactly-once side effects across crashes. Keep secrets out of config, metadata, and diagnostics.

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
Credentials are resolved lazily only when a recognized ticket is resolved.
If either `JIRA_EMAIL` or `JIRA_API_TOKEN` is supplied, both must form a complete,
nonblank pair overriding saved credentials. Partial/blank overrides fail without
mixing sources. Otherwise use only the saved personal pair matching the normalized
site origin and optional cloud UUID (case-insensitive UUID); scoped and unscoped
modes are distinct. Missing credentials point to `timber setup` or
`timber setup --global`. Never put credentials in ordinary config, logs, tickets,
or commits. Timber does not load `.env` files; explicit overrides come only
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

The strict `[hooks]` table accepts `post_create` and `pre_delete`, string arrays
defaulting to `[]`. Each command must contain non-whitespace source and no NUL bytes;
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

### Pre-deletion hooks (issue #63)

`done` runs ordinary `[hooks].pre_delete` steps after target selection and the
initial cleanup safety checks, before removing the linked worktree. This includes
`--keep-branch`. Cancellation, primary/invalid targets, and safety refusals run no
hooks. There are no workflow-specific deletion hooks or editor terminal handoffs.
Absent/empty steps leave cleanup unchanged. Whole-table config replacement and
`hooks = false` apply to both lists; read repository hooks from the primary root.

Use the same sequential Linux shell execution, closed stdin, streamed output,
and repository/worktree/branch/ticket environment as setup. Clear any inherited
`TIMBER_WORKFLOW`; deletion does not select a workflow. A failed step stops later
steps and returns nonzero before Timber removes a worktree or deletes a branch.
Report the one-based step and exit code, signal, or shell startup failure without
echoing source. Hook side effects remain; trusted hooks are not rolled back.
Provide a safely quoted `timber done [--base <ref>] [--keep-branch] [--keep-ignored] -- '<path>'`
retry preserving the invocation's retention options. Retrying deliberately runs
all steps from the beginning after safety checks; never retry automatically.

After successful hooks, recheck repository/worktree identity and registration,
branch/head, file status, validated base/integration and required live publication
before removal. Changed target/base refs, upstream identity or preservation
evidence, new modified/untracked files, and ignored files under `--keep-ignored`
refuse cleanup. Leave the resulting files and refs intact; do not undo hook work.
Ignored content otherwise follows the existing discard policy. Hooks never
authorize bypassing cleanup safeguards.

## Editor terminals (TIM-27)

Ordinary and workflow editor tables accept optional `integration = "orca"`.
Omission keeps the generic editor launcher. The command names the local Orca CLI
(e.g. `orca-ide`), with literal args separate from agent args. Require a running
local Orca window, registered repository and visible external worktrees. Never
start another window/runtime. Remote routing is unsupported. Editor-owned
terminals currently support only `orca-ide`. Zed and VS Code (`code`) use the
generic editor launcher (window open only); in-panel terminals for those editors
are deferred until a demonstrated external bridge exists (see #61 for VS Code).

Ordinary and workflow agent tables accept boolean `wait_for_setup`, default false.
Whole-table replacement applies; explicit workflow agents default independently,
while omitted workflow agents inherit the entire ordinary configuration. Guided
setup offers an Orca editor preset and asks for `wait_for_setup` whenever the
effective editor is Orca; it never writes the key for other editors unless kept.
For inherited agents, an unchanged dependency preference preserves inheritance;
a changed preference copies the complete effective agent table into this scope.

In enabled Orca mode, establish bounded exact-worktree readiness, then run ordinary
and workflow setup sequentially in one terminal and an independently enabled agent
in another. Both use the selected absolute cwd. Start the agent in parallel by
default; `wait_for_setup = true` requires setup success first. Agent-only opens do
not force setup. Existing opens with any enabled editor never implicitly restart
agents. Editor-disabled behavior stays unchanged, including foreground execution.
Flags and workflows continue to apply before mutation. An enabled, selected Orca
integration hosts the agent in its own terminal, so the invoking process does not
require stdin/stdout terminals or CI off. Without that integration, foreground
agent CI/TTY restrictions still apply, including with `--no-editor`.

Use private transient runner data for literal argv, unchanged hook sources and
Timber environment context. Preserve target-terminal Orca identity. Observe actual
agent spawn and setup completion, never agent lifetime. Setup failure stops later
steps; dependent agents are suppressed, parallel agents already running stay open.
Even agent handoff failure must await setup already started. Observed required
failures return nonzero, preserving workspace/refs/files; never fall back or kill
agents. Never retry terminal creation blindly. Fence unconsumed timed-out requests;
otherwise report uncertain launch and inspection guidance instead of immediate replay.
A failed window selection after terminal creation returns nonzero and identifies
the retained terminal, without fencing or recreating it. Await required setup
already started; a setup-terminal selection failure prevents the initial agent.

Definitive setup retry: `timber open --editor --setup --no-agent -- '<absolute-path>'`.
Definitive agent retry: `timber open --editor --agent -- '<absolute-path>'`.
Definitive failures before a step's runner claims its request print one retry for
everything not yet started, e.g. `timber open --editor --setup --agent -- '<absolute-path>'`.
Safely render these display commands. See [Orca integration](editor-terminals.md).

## Interactive agent launching (0.2)

The following foreground behavior applies outside enabled Orca integration;
TIM-27 takes precedence in editor terminal mode.

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
defaults live in an optional advanced section, skipped by default. Unconfigured
integrations offer one None choice (the default), without a duplicate Skip/Keep
disabled choice. Existing enabled integrations retain a default Keep choice;
machine-default resets appear only when they change the effective setting.
Git/folder menus similarly offer one automatic/inherited default without a
duplicate Skip choice. Blank Enter leaves new settings absent or retains
existing values. Each question is separated
by a blank line. Terminal selectors support Up/Down arrows and Enter; single-key
number shortcuts 1–9 select immediately. Additional options in long menus use
arrows, with no ambiguous multi-digit shortcuts; menus show a viewport sized to
the terminal height and keep the highlighted choice visible. q/Escape/Ctrl-C/EOF cancel and
terminal input mode is restored. Editors and agents default to disabled; setup asks separately whether each configured command should launch automatically. Executable
checks do not launch anything; new custom executable selections must be program
names on PATH or absolute paths, never relative paths that change meaning across
workspaces. Setup never changes refs, creates worktrees, runs
hooks, or edits shell startup files. Jira credentials are edited separately from configuration: repository and global
setup share `${XDG_CONFIG_HOME:-$HOME/.config}/timber/credentials/jira.json`
(absolute XDG paths only). The store is versioned JSON, plaintext with a private,
user-owned 0700 credentials directory and user-owned 0600 regular file. Symlinks,
unsafe permissions, malformed records, and storage within Git worktrees or Git
administrative directories are refused. Neither ordinary config file contains
credentials. Setup explains token creation, scoped/unscoped API roots and cloud-ID
discovery. Validate the site URL before asking about token scopes or credentials;
invalid URLs show an inline error and retry the URL field immediately. This
validates URL format and supported hosts; availability uses the optional connection
check.
Token characters are hidden, including pasted input, and never redisplayed.
The current input shows asterisks as typing/paste feedback, capped to fit the
terminal width; Backspace updates the mask without revealing characters.
Extra buffered lines from unbracketed secret pastes are discarded and the input
is rejected; paste one single-line token and wait for each prompt.
Keep, replace, remove, or skip the selected site's pair; disabling Jira does not
delete credentials shared by other repositories. Review shows the destination and
pending actions without credential values. Only explicit Save publishes changes.

An explicit default-off connection check calls `GET /rest/api/3/myself` using the
draft pair (not environment overrides), with redirects/retries disabled and the
existing 10-second full-body deadline. A nonblank account ID confirms current-user
access only, never all project/issue permissions. Scoped tokens may need additional
current-user read scopes for this optional check. Errors omit bodies and raw errors.
Cancellation aborts the check and restores the terminal.

Credential publication holds a private lock through config publication and
rechecks original bytes to reject concurrent changes. Failed config publication
restores owned credential changes; concurrent external changes survive with an
incomplete-rollback diagnostic and manual recovery guidance. Individual files are
published atomically, with no-clobber creation for a new store. Cross-file crash
atomicity is not guaranteed: an uncatchable crash can leave a credential update
before config publication and a stale lock. Inspect private storage and rerun setup;
never copy its contents into reports.
Locks coordinate Timber writers. As with ordinary config, an unrelated editor
can race the final check-to-rename; byte comparisons detect changes at the check,
not transactions spanning arbitrary external writers.

Open directly on the settings menu with destination, scope, compact section status,
and an explicit Save and exit choice,
individual editor/agent/Jira/setup-scripts/pre-done-scripts/base-branch/remote/workspace-folder edit choices,
and cancellation. Save is the menu default. Do not show introductory summaries or
require acknowledgements between edits and the menu. Full-screen prompts show
guidance, errors, and pending credential actions inline with the active question
or menu. Errors appear first beneath the question, labeled `! ERROR`, with bold
white text on a red background. `NO_COLOR` or `TERM=dumb` disables styling but
retains the label. Error text remains while editing and clears on the next field.
Long context wraps and scrolls with PgUp/PgDn while the question and
input/choices remain visible; scrolling is optional and never selects or submits.
Editing
preserves the other draft answers, uses current draft values for keep/reset
choices, and returns directly to the updated menu.
Advanced sections remain editable even if skipped initially. Invalid scalar edits
retry their input without discarding the draft. No writes occur until Save.
Setup and pre-done script lists are edited separately, including in the guided
advanced steps. Each script step offers only None and Add/Edit scripts: None is
the default for empty lists, and Edit is selected for existing lists with commands
prefilled. Accepting unchanged commands preserves inheritance. Editing or disabling
one list preserves the other effective list, copying it into the local hooks table
when inherited. Restore whole-table inheritance by removing the TOML override.
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
`new --base` and `done --base` can complete local/cached branch refs.

Prefix matching is literal and results are deduplicated and sorted. Missing Git,
inaccessible metadata, and non-repositories quietly yield no target candidates;
command/flag completion still works. The Git reads behind one Tab press share a
one-second deadline and skip optional locks; a stalled Git yields none as well. Dirty/stale/locked entries remain discoverable
and never imply safe cleanup. Normal execution retains all preservation checks.
Shell-independent candidate lookup returns raw selectors. Bash transports them
with NUL separators and quotes insertion literally, including spaces and shell
metacharacters, without evaluating candidate text. See [Bash completion](completion.md)
for activation and the actually verified Bash/Linux environment.

## Arena creation (post-1.0, TIM-20)

`timber arena new <name-or-ticket>` prepares at least two fresh attempts from one pinned
commit and identical immutable task instructions, then launches agents sequentially
in the invoking terminal. This enhancement does not block stable release;
resume/pick remain separate tickets.

### Lifecycle boundaries

[TIM-20](https://github.com/Coding-M8s/timber/issues/40) owns creation and initial
sequential foreground launches. Existing committed progress is a source for fresh
attempts, whether its branch is local or remote and whether it has a worktree.
Source selection never adopts that branch as an attempt. Existing arena identities
and attempt destinations fail preflight rather than implicitly resuming or replacing
work. Ticket-key input is a source-selection convenience within this lifecycle;
it does not change the task, isolation, execution, or preservation contract.

[TIM-21](https://github.com/Coding-M8s/timber/issues/41) owns recovery/revisit of a
recorded attempt. It must revalidate membership, reuse the task/configuration,
preserve the attempt's evolved committed and uncommitted state, and require explicit
setup retry. Workspace continuation does not promise universal conversation restore.

[TIM-22](https://github.com/Coding-M8s/timber/issues/42) owns grouped summaries and
human winner selection: attempt labels, agents, branches, paths and known states;
tracked committed/uncommitted changes against the recorded base; separate untracked
indicators; and inspection/reopen paths. A selected winner remains intact. Losing
work is eligible for cleanup only through the ordinary preservation checks, and
selection itself is not publication or integration evidence.

Creation exposes live foreground output, paths and stage/exit outcomes. These
contracts do not add collected final-answer reports, automatic quality judging,
parallel/background session management, automatic merging/publishing, or implicit
process killing. Resume and pick remain future commands until their tickets land.

### Tool, model, effort, and runs

`--tool <query>` starts an ordered native (`codex`, `claude`, `cursor`) or manual
group; `--preset <query>` starts a saved agent configuration group. `--model <id>`
and `--effort <level>` attach only to a tool group; when both appear, model comes
first. `--runs <count>` attaches to either tool or preset and defaults to one.
A preset owns its model/effort/arguments, so overrides are rejected. Require at
least two runs overall and positive safe integer counts/total; no fixed upper
cap in parser, questionnaire, plans, or storage. Counts control batch size, while
agents remain sequential. Practical scale depends on resources/runtime limits;
distributed or million-run execution is not established. Reject orphan/duplicate
fields, models/effort for manual groups, and unsupported effort before mutation.

Public labels use “Agent tool,” “Model,” “Effort,” “Runs,” and “Agent preset.”
Draft --harness/--attempts/--task-file/--participant and preset colon counts have
no compatibility aliases. Internal v1/v2 harness fields retain their identity.

A shared matcher ranks exact canonical values, then canonical prefixes, then
fuzzy name/label/keyword matches. Ranking uses fuzzysort behind a small pure
adapter; terminal and catalog ownership remain separate. Tools/models/presets
share it between flags and guided selection. Unique matches resolve; ambiguity
requires explicit searchable selection in an interactive terminal, or actionable
exact choices without prompting in scripts. Terminal search treats letters and
digits as query text, preserves pasted answers, scrolls within terminal height,
and restores original terminal modes. Cancellation remains mutation-free. Unknown
custom model IDs pass literally to the tool; do not guess their capabilities.
Wizard custom IDs are always literal. Resolve flag queries once and preserve the
exact selected value through planning, storage, and launch.
Never fuzzy-match task text, branch refs, or record identities.

Interactive order is tool → model → supported effort → run count; an agent preset
supplies the saved configuration and goes to run count. Model omission passes no
native override, never infers another session's selected model. Model discovery
is invocation-local and tool-specific: bounded/closed-stdin `cursor-agent models`,
Codex's local model cache, and Claude's native aliases from installed CLI help,
plus configured exact preset models. Native command discovery is bounded to eight
seconds and 1 MiB output; failure is visible and leaves default/custom/preset
paths. Cache/aliases do not promise account availability. Do not build a provider
integration framework, start agent tasks for discovery, or dump private native
configuration/credentials into diagnostics.

`--default-effort <level>` sets an arena-wide fallback independent of flag order.
A native tool group's `--effort <level>` overrides it; `--effort default` opts that
group into native defaults. A preset's saved effort wins over the fallback; native
presets without saved effort inherit it. Manual and wrapper groups do not inherit
native effort. Validate every resulting native tool/model separately before Git
mutation; unknown/unsupported levels fail with no silent skip. Global `default`
means no fallback. Guided selection offers inheritance and native opt-out after
model selection, alongside supported model-specific levels. Preset definitions and
ordinary agent configuration are never mutated by invocation defaults.

Effort choices are the capability levels available for that selected tool/model,
plus native default; no common universal scale. Missing metadata means no effort
picker/override, rather than guessed levels. Codex translates to
`--config model_reasoning_effort="<level>"`; Claude to native `--effort`; Cursor
uses variants actually advertised by its model listing. Explicit conflicting
Cursor model variant and effort fail; wizard effort selection can choose another
advertised variant. Claude general help is not model-specific capability evidence;
its aliases retain unknown effort support, with a visible notice, no effort picker,
and no override. Users can select supported effort inside Claude. Recognized effort
spellings, including Codex `ultra`, share one definition across discovery,
validation, and storage; only model-advertised subsets are offered.
Reviews and launch output label explicit effort as requested, native omission as
tool/model default, and effective runtime effort as unknown in both cases. Capture
an inherited `CLAUDE_CODE_EFFORT_LEVEL` for Claude defaults in optional V2
`effortEnvironment`: recognized spellings or `auto` only, otherwise `unrecognized`
without raw contents. It is observation of inherited input, not model capability
proof or effective effort. Explicit validated Claude effort sets the child's native
flag and environment variable to the same requested level; do not modify the parent
process environment or other tools. Native settings can still override a request.

Native account/model policy remains authoritative. Presets
may store optional native `effort`; reject duplicate field/native-argument effort.

Built-ins invoke `codex`, `claude`, or `cursor-agent` on PATH. Never substitute
Cursor editor `cursor` or ambiguous `agent`. Named presets own custom executable
paths/literal args. Strict `[arena.agents.<name>]` tables accept tool (`codex`,
`claude`, `cursor`, `wrapper`), command, args (default []), and optional native
model/effort. Wrapper model/effort belong in literal args, not native fields.
Accept unambiguous native --model/--model=..., Codex -m, and native effort arguments;
restricted argument boundaries prohibit implicit prompt/subcommand/workspace/
background/resume behavior. Cursor native args initially accept only --model.
Validate every config scope even for unused/overridden presets. Merge whole named
presets; per-name false and arena=false remove inheritance. Setup preserves arena
tables. Ordinary [agent]/workflow contracts remain compatible; ordinary-agent
reuse asks task handoff explicitly. `configured` and `manual` stay reserved.

Names match `^[a-z][a-z0-9_-]{0,47}$`. Exact uppercase ticket input retains its key
as context and derives a lowercase arena identity; `--name <name>` overrides it,
including for multiple pieces of one ticket. No task text or Jira body is inferred
from the key. Prompt/file or interactive instructions describe remaining work.

### Source resolution and confirmed refresh

Explicit `--base <branch-or-ref>` wins, including exact local full refs and explicit
remote/branch selectors. Missing explicit base is an error. Without it, ticket input
seeks local committed branches first; unique local progress works offline without
a source worktree. Multiple matches require a stable chooser or exact noninteractive
selector. Ticket matching recognizes the key at the start of a slash-delimited
branch segment followed by end or `-`, `_`, `.`; no arbitrary substring or longer
key match. This arena policy does not alter ordinary new/open matching.

With no local ticket match, discover live remote heads respecting explicit/configured
remote selection, otherwise relevant remotes. Discovery failure blocks fallback.
Only successful absence permits configured/default base selection. Name-only input
uses ordinary precedence: configured base, selected remote default, then unambiguous
local main/master. Selected local refs remain offline; selected remote refs require
refresh, even if cached. Source worktree creation is never needed. Raw SHA base
selection is outside this interface.

Source discovery and complete destination/input preflight are read-only. Interactive
review shows source ref and advertised/validated commit, ticket/default-source note,
tool/model/effort groups, counts and destinations; defaults to Cancel. Task body and raw
arguments are omitted. Keep one prompt lifetime through source choice/review and
restore modes before Git/setup/launch actions. Cancellation before confirmation
returns zero without refs/files/records changes. Noninteractive explicit input is
confirmation, with no prompts.

After confirmation, refresh only the selected remote branch with argument arrays,
closed stdin, disabled Git terminal prompting, and bounded runtime. Verify the
fetched commit equals the reviewed advertisement; a moved tip or failed fetch stops
without attempt creation, never silently falling back to stale cached refs. Report
that this explicitly confirmed fetch may have updated cached refs. A local selected
commit stays pinned even if its branch later advances. All attempts use the exact
one recorded commit. Never copy/stash/reset/commit source modified, untracked, or
ignored content, nor create or publish the source branch locally.

### Attempts, records, and failures

Generate fresh branches `arena/<name>/<group-label>-<ordinal>` and use existing
configured/default worktree paths. Validate the whole batch's local refs, namespace,
paths, primary protection, and known remote target names before confirmed fetch or
creation. Known remote attempt-name/namespace collisions require another arena
name; source branches are read, not reused as attempts. Local sources consult cached
remote inventory and stay offline. Remote sources also consult discovered live
heads; unknown/unreachable remote collisions cannot be ruled out offline.
Creation still rechecks local targets and expected physical paths at mutation time.

Reserve `<commonGitDir>/timber/arenas/<name>/` exclusively after source finalization.
Private dirs 0700/files 0600 hold immutable `task.txt` and atomic versioned manifest.
Manifest reads have no fixed byte ceiling tied to attempt count; regular-file,
private-permission, symlink, schema, and identity checks still apply. Task snapshots
retain their separate 1 MiB limit. V2 includes arena/attempt UUIDs, canonical repository identity, pinned base, source
selector/provenance, optional ticket key, requested tool/model/configuration and optional effort
reference/fingerprint, task reference/digest, Git/worktree identities, stages and
exit/signal outcomes. No raw task/command argument dump. V1 and existing V2 records remain readable unchanged. Missing optional effort
remains unknown/default; never synthesize historical effort or model defaults. Reject unsupported,
malformed/inconsistent/stale records, unsafe/symlink metadata, changed task snapshots,
and active/interrupted invocation locks. Never overwrite an arena or take ownership of an existing invocation lock.
Reciprocal UUID markers prevent adopting removed/recreated worktrees by path/name.
Git remains authoritative and membership is never cleanup/deletion proof.

`--prompt-file` paths resolve from invoking cwd: nonsymlink regular UTF-8, nonblank, no NUL,
at most 1 MiB; preserve bytes. Interactive multiline entry finishes with /done and
supports explicit cancellation. Optional quoted `--prompt <text>` uses the same
validation/snapshot and is mutually exclusive with --prompt-file; it appears in
Timber argv/shell history but is never echoed in review/diagnostics. Native launch appends `--` plus an identical prompt
to read the private absolute snapshot; body never enters native agent argv. Wrapper handoff uses
TIMBER_TASK_FILE without guessed flags. Agents receive arena/attempt/repository/
worktree/branch environment data; inherited TIMBER_WORKFLOW/TIMBER_TASK_ID are
removed. Tools may store their own transcripts/output; native model file access is
not universally guaranteed by Timber transport tests.

Create/bind all attempts, run ordinary hooks for all, then editor policy and optional
foreground agent per attempt. `--no-agent` prepares only. Explicit group selection
opts into initial interactive launch independent of ordinary agent.enabled.
Noninteractive native/wrapper preparation requires --no-agent and explicit prompt/file/groups;
manual needs no agent flag. CLI editor overrides and preflight remain as before.
Immediately revalidate reciprocal Git/UUID identity before each external setup,
editor and agent boundary, including after awaited editor startup. Await one owned
agent with inherited terminal stdio and existing signal handling; no detach/unref.
Stop first failed stage/nonzero child, retain all completed state, preserve numeric
statuses including 130/143, and never claim exit zero proves quality/integration.

Persist intent before hooks/launch and actual outcomes afterward. Stages: planned,
created, setup-running, ready, launch-running, exited, failed; failures identify
creation/setup/editor/agent. Metadata errors stop later stages; uncertain crash
states never authorize implicit replay or recreation. Source-fetch failure may
leave only refreshed cached refs; later failures retain private records/workspaces.
Inspect timber ls, reopen with `timber open --no-editor --no-agent -- '<path>'`, or
explicitly rerun hooks with --setup. Relaunch assigned tool/preset manually with
the task snapshot until TIM-21. Ordinary open --agent uses ordinary config, not the
arena preset. No automatic winner, merge, publish, cleanup, or unrelated process kill.

### Downstream Arena consumers

TIM-21 must reuse recorded exact tool/model/configuration, optional requested
effort and task snapshot after Git identity revalidation; synchronize explicit Claude
effort with its child environment. Optional inherited effort observations may be
shown as historical inputs, never runtime confirmation. Absent historical
values stay unknown and never trigger guessed overrides. TIM-22 may display
these selections alongside state/diffs and retain its existing human selection
and preservation rules. Neither command should rerun fuzzy resolution against
mutable current catalogs to reinterpret a recorded run. No resume, winner,
comparison, merging, cleanup or parallel-session behavior is added by selection.
