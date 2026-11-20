# Timber CLI behavioral contract

The additive [experimental IDE machine interface](ide-contract.md) defines opt-in
`ls --json`, `backup list --json` and New/Open/Rebase/Publish/PR/backup restore
`--result-file` records, plus hidden commands that let an app read settings, pull
requests and linked issues, save and check settings, and delete one confirmed backup.
Ordinary human commands and
release behavior retain the contracts below.

Windows x64 candidate additions are specified in [Windows support](windows.md).
They retain the preservation rules below. On Windows, Git for Windows supplies
the POSIX hook shell; native executable launch excludes command-script shims;
PowerShell quoting renders retry commands; Windows ACLs replace private POSIX
mode checks. Absolute XDG paths retain precedence, with HOME then USERPROFILE
fallback. Filesystem path collision/identity comparisons normalize separators and
case on Windows, while Git branch/ref names retain their exact spelling. Windows
support and this change's Linux regression gates remain unverified until actual
platform evidence is recorded. Existing Linux-specific promises below continue
to describe Linux, including Orca and POSIX process-group behavior.

1. Discover repositories from nested directories and linked worktrees; distinguish the current worktree root from the common Git directory.
2. Git operations use the detected repository, not a hardcoded current directory.
3. `new <branch...>` creates a new branch from the configured or explicit base. The CLI joins its positional words with literal spaces; if the joined input contains U+0020, trim surrounding U+0020, lowercase, and replace each internal run of U+0020 with one hyphen. If the branch exists locally, report it and suggest `open`. After the final name is resolved (including normalization, ticket slugs and length shortening) and before any creation, `new` also guards against existing remote work; see [Existing branch guard](#existing-branch-guard). In a repository with no commits (unborn HEAD and no branches), `new` refuses with a diagnostic naming the missing initial commit, with or without `--base`, and creates nothing.
4. `open <input>` resolves an existing worktree, exact local branch, then exact remote branch. An explicit remote such as `origin/feature/foo` selects that remote. When cached refs cannot identify one local target, `open` discovers live remote heads without changing refs, respecting the explicit/configured remote or checking all remotes. Discovery failure blocks materialization; existing local targets remain offline.
5. A ticket prefix such as `ENG-834` may match branch names on a delimiter boundary. Multiple matches must include every distinct candidate in one chooser when interactive; mark candidates that require manual selection, and do not mutate if one is selected. Without a chooser, show at most five sorted candidates and the total, with exact manual-selection guidance. Do not use arbitrary substring matching.
6. Refresh the selected remote before creating from a remote branch. An existing local worktree can open offline. A failed remote refresh must not be reported as success. `new` contacts the eligible remotes (the configured remote, else every remote) with a bounded, non-prompting `git ls-remote`, so in a repository with remotes it needs network access; repositories without remotes stay offline.
7. Base selection: `--base`, repository/global config, configured remote's default branch, then an unambiguous existing `main` or `master`. Never guess if resolution is ambiguous. `done` selects its integration target from `--base`, then the worktree's saved base, then repository/global config and existing default discovery. `done --base <ref>` selects an invocation-local integration target using the existing branch/ref resolver; it never writes TOML or changes a local branch tip. An explicit missing, invalid, ambiguous, or target-local-branch base fails before hooks or removal, even with verified publication or `--keep-branch`. Revalidate the same selected ref/commit before removal and branch deletion. An absent saved association preserves configured/default-base and live-publication behavior. A missing saved ref fails without fallback, even with verified publication or `--keep-branch`. Malformed/unreadable metadata blocks cleanup; stale identity metadata requires an explicit replacement. Cleanup never rewrites the saved association. Re-read the association before removal and retain its selected input for base revalidation after Git removes the metadata. No automatic parent-branch inference. Before cleanup, automatically refresh a selected remote base (explicit, saved, configured or default); explicitly selected local bases remain local. Fetch only its exact remote branch without tags, pruning, submodule recursion or destination ref, verify FETCH_HEAD against its live advertisement, then conditionally update only the selected direct remote-tracking ref without following symbolic refs. Discovery/fetch failure, a moved advertised tip or concurrent cached-ref change stops before hooks/removal with no cached fallback. Re-read worktree identity, status and the selected base after refresh; changing base selection also stops. Fetch metadata and the selected remote-tracking ref may change even if subsequent safety checks refuse cleanup. Read-only inspection does not fetch.
8. Worktree paths default to a sibling directory, `../<repository-name>-worktrees/<safe-branch-slug>`. Resolve config paths relative to the primary repository root. Reject collisions, path traversal, and attempts to target the primary repository.
9. `ls` lists the current repository's primary and linked worktrees, including ones created outside Timber, and identifies the primary worktree.
10. `done` resolves cleanup targets among registered worktrees; remote-only and unchecked branches do not make a single matching worktree ambiguous. Multiple worktrees use the five-option chooser (or a capped diagnostic without a terminal), and selection is revalidated by absolute path and branch before cleanup. Cancellation succeeds without mutation. `done` never removes the primary worktree. For ordinary cleanup, modified or untracked files block removal, and unpublished or unknown publication blocks removal unless commits are contained in the validated base or content integration is proven. A successful exact live upstream query confirming the configured remote branch is absent authorizes automatic removal and local branch deletion regardless of local commit integration or modified/untracked files. Report this reason before removal. Missing upstream configuration or tracking cache, remote failures, timeouts and malformed responses are not proof of deletion. For other file/commit preservation refusals, interactive cleanup shows the reason and asks whether to delete anyway, defaulting to No. Accepting authorizes discarding local commits and modified/untracked files for the exact selected identity, tip and file state; cancelling succeeds without hooks or mutation. Noninteractive cleanup refuses when confirmation is required; no force CLI flag is exposed. Unknown file status, invalid identity/metadata, locks, stale registrations, primary worktrees and in-progress Git operations remain hard failures. Revalidate tracked/untracked file contents, index state, target and applicable upstream evidence after confirmation/hooks before removal; changed state stops cleanup. Ignored runtime file changes do not invalidate discard when ignored files are being discarded; --keep-ignored remains enforced, including inside initialized submodules. Keep options remain enforced.
11. Except for confirmed upstream deletion or explicit interactive discard under rule 10, delete a local branch only when every local commit is reachable from its verified live remote upstream, its commits are contained in the validated base, or Git proves content integration: a successful virtual merge produces exactly the validated base tree, or the complete local tip tree matches a commit reachable from the pinned validated base. Historical tree equality preserves the complete snapshot even after later base edits or reverts, without requiring the original commit IDs or a live feature upstream. Recheck the target and preservation evidence before removal and branch deletion. Publication-only cleanup must verify the live upstream after the final local safety reads and again after worktree removal; changed upstream identity or lost publication retains the local branch. A missing base does not block verified publication, but a validated local base branch cannot be deleted. Use only built-in merge behavior: reject custom merge-driver configuration and disable renormalization for this proof. Virtual merge conflicts alone never authorize deletion; historical integration requires exact full-tree equality from a successful, hash-validated history read rooted only at the pinned base commit. Unsupported Git operations and uncertain integration evidence never authorize deletion through these proofs. `--keep-branch` retains the local branch; clean published worktree cleanup does not require integration with or without this option. Do not infer safety from a closed PR. Detached worktrees require commit ancestry into the validated base or explicit interactive discard. Confirmed upstream-deletion cleanup pins the remote identity and rechecks live absence before removal and local branch deletion; changed or unknown upstream evidence retains the worktree, or the local branch if removal already completed. Explicit discard skips commit-preservation proofs but not conditional ref deletion or base/identity checks.
12. No `--force` CLI option. Git force removal is internal and permitted only under rule 10 discard authorization. No remote branch deletion, automatic stash, or implicit process killing.
13. `done` discards ignored files and directories, including `.env`, with the worktree by default. `--keep-ignored` refuses cleanup when ignored content exists, leaving those files, the worktree, and branch in their original locations; it does not copy them elsewhere. Retain `--discard-ignored` as a compatibility option. Reject combining it with `--keep-ignored`. Neither ignored-file option authorizes bypassing modified/untracked files or commit/integration checks; rule 10 controls discard authorization. Document the default in CLI help and the README. Recovery backups are outside the worktree and are kept; see [backup lifecycle](#backup-list-deletion-and-done-lifecycle-120).
14. Editors default to off, including when a command is configured without `enabled = true`. `new` and `open` accept `--editor` and `--no-editor`; explicit enable or disable overrides `[editor].enabled`. Agent launching is opt-in and uses either the invoking terminal or explicitly selected editor terminals; see the launch contracts below.
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

## Publish a worktree's branch (#154)

`timber publish <branch-or-worktree>` pushes the branch of an existing
Git-registered worktree. Selection matches `rebase`: exact branch, absolute path,
or delimiter-boundary ticket matching, filtered to registered worktrees, with the
existing chooser or capped diagnostic; cancellation does not push. Never create a
worktree or branch. Refuse a detached HEAD, an unborn branch, and missing, stale
or unverifiable targets. The primary worktree is eligible when explicitly
selected. Modified and untracked files, locks and in-progress operations on a
checked-out branch do not block publishing; only commits are pushed.

Push the branch under its own name, `refs/heads/<branch>` to the same ref. With
an upstream, use that upstream's remote; refuse an upstream that is a local
branch, names no configured remote, or has a different branch name. Without an
upstream, use the configured `remote` or the sole remote, refuse when neither
identifies one, and set the upstream with the push. Revalidate the selected path,
reciprocal Git identity, checked-out branch and tip before the push.

Run one `git push` in the target cwd with a literal argument array and closed
stdin. Never force, with or without a lease; never push tags; never delete a
remote ref. Disable terminal, askpass, credential-manager and SSH prompts, so a
remote that needs a sign-in fails with a sign-in reason instead of waiting.
Ordinary Git hooks remain Git's responsibility. Do not fetch, pull, rebase or
create pull requests.

Published and up-to-date return zero and report worktree, branch, remote,
upstream and the commit on the remote. A remote branch that has moved on
(a non-fast-forward rejection) is a refusal: nothing is pushed, no local ref or
branch setting changes, and the diagnostic says Timber never force-pushes.
Distinguish that refusal from sign-in, network, remote-side and hook failures.
Every refusal and failure returns exit 1. Git's own output and remote messages
go to stderr with control characters escaped.

## Open a pull request (#157)

`timber pr <branch-or-worktree> --title <text> [--body <text>] [--base <ref>]
[--draft] [--reviewer <login|org/team>]...` publishes a registered worktree's branch and opens one pull request
for it on github.com or Bitbucket Cloud (bitbucket.org, #175). Selection matches `publish`. The title is required, one
line and at most 256 characters; the body is at most 65536 characters.

The base is `--base` when given, otherwise the saved base. `--base` accepts
`<remote>/<branch>`, `refs/remotes/<remote>/<branch>`, or a plain branch on the
configured or sole remote; the longest matching remote name wins. It is never
saved. Refuse `HEAD`, `refs/heads/...`, an unassigned or invalid saved base, a
saved local-branch base, a remote that is no longer configured, an invalid branch
name, and a base equal to the branch itself in the same repository. The base
remote's fetch URL and the publish remote's push URL must each name one
github.com or bitbucket.org repository, both on the same host; they may differ,
so a fork's branch opens against its upstream repository. A remote on any other
host, including Bitbucket Server/Data Center, is refused. Do not fetch or verify
that the base exists; the host's rejection reports that.

Bitbucket remotes are `https://bitbucket.org/<workspace>/<repo>`, the same with
a `<user>@` (Bitbucket's default HTTPS clone URL), `git@bitbucket.org:<workspace>/<repo>`,
`ssh://git@bitbucket.org/<workspace>/<repo>`, the `ssh.bitbucket.org` SSH host,
and `ssh://git@altssh.bitbucket.org:443/...`, each with an optional `.git`. A URL
carrying a password is refused, and the refusal names only the remote.

Every Timber preflight refusal happens before reading the login and before
any push, so no local ref, branch setting or remote ref changes. A remote branch
that has moved on is refused by the push itself, which also changes nothing.
After preflight, read the login once
(on GitHub: `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`, with prompts
disabled; on Bitbucket: the login below); a missing login fails before the push. Publish with exactly the rules of
`timber publish`, even when a pull request already exists, so the pull request
gets the latest commits.

After the push, list open pull requests filtered by `<head-owner>:<branch>` and
check the head branch, head repository and base of each result, since GitHub
ignores a filter it cannot parse. When one is open into the same base, report it
and create nothing; an open pull request into another base does not count.
Otherwise create one with the title, body, base and draft flag. A creation that
GitHub rejects because one already exists is followed by one more lookup.
Build the reported URL from the validated repository and number. Map GitHub
rejections to fixed diagnostics and never echo response bodies or tokens. Each
request has the existing 10-second deadline, rejects redirects and is not
retried; a creation timeout says the pull request may exist.

The worktree's saved issue link (#153) names the issue to mention. Without a
saved link, fall back to a ticket key at the start of the branch name (as
`TIMBER_TASK_ID`), whose GH number belongs to the default issue remote. An
unreadable link adds no mention and warns on stderr. Append a reference to the
body unless it already mentions the issue: `Refs #<n>` for a GitHub issue in the
base repository, `Refs owner/repo#<n>` for one in another repository (where a
bare `#<n>` does not count as a mention), and `Refs <KEY>` for Jira and Linear.
Never add a closing keyword: GH numbers share one local namespace across issue
repositories.

Created and exists return zero and print the number and URL. Every refusal and
failure returns exit 1. Editing, merging, labels and hosts other than
github.com and bitbucket.org are out of scope.

### Reviewers (#174)

`--reviewer` may be repeated and takes a GitHub user login or `<org>/<team>`
(the team slug). Values are trimmed and deduplicated case-insensitively in the
order given; at most 15 remain. Preflight refuses, before the login is read and
before any push, a value that is not a valid login or `org/team`, more than 15
reviewers, a team whose org is not the base repository's owner, and any
`--reviewer` on a bitbucket.org base: reviewers are requested only on
github.com.

Once the pull request is created or found open (including the `exists` result
and the one more lookup after a race), request each reviewer in order with
`POST /repos/<owner>/<repo>/pulls/<number>/requested_reviewers`, one request per
reviewer (`reviewers` for a user, `team_reviewers` with the slug for a team),
using the same login. Each request has the 10-second deadline, rejects
redirects and is not retried. A reviewer is requested even when already
requested or after they reviewed; what GitHub does then, such as notifying them
again, is GitHub's behavior.

A failed request never changes the pull request result or exit code. Each
failure maps to a fixed diagnostic (422 for a reviewer who cannot be requested,
such as a non-collaborator or the author; 401; 403/429; 404/410; other
statuses; an invalid response; the network; a timeout, which says the reviewer
may have been requested) and is written to stderr as a warning. GitHub's
response bodies and the token are never echoed. Successful requests are listed
on stdout after the pull request line.

### Bitbucket Cloud (#175)

On a bitbucket.org base, Timber never prompts for the login. If either
`BITBUCKET_EMAIL` or `BITBUCKET_API_TOKEN` is supplied, both must form a
complete pair of an Atlassian account email and a nonblank API token without
whitespace; that pair overrides the saved login, and an incomplete or invalid
pair fails without fallback. Otherwise use the single private pair saved by
`timber setup` at `${XDG_CONFIG_HOME:-$HOME/.config}/timber/credentials/bitbucket.json`
(`{ "version": 1, "email", "token" }`), under the same private-storage rules as
`linear.json`. A missing login points to `timber setup` and the variables. The
pair is sent as HTTP Basic credentials to the fixed `https://api.bitbucket.org/2.0`
origin. The token is an Atlassian API token with the scopes
`read:pullrequest:bitbucket` and `write:pullrequest:bitbucket`; pushing still
uses the user's own Git login.

After the push, list `GET /repositories/<workspace>/<repo>/pullrequests` with
`state=OPEN`, `pagelen=50` and a `q` filter on `state = "OPEN"` and the source
and destination branch names (quoted, with `"` and `\` escaped), because
Bitbucket ignores the `state` parameter once `q` is given. Then check each
result's state, source branch, source repository (`full_name`, case-insensitive) and destination branch,
since the filter is not trusted. A result whose source repository is null (a
deleted fork) does not count. The lowest matching id is reported. Otherwise POST
the title, `description`, `draft`, the source branch (with its repository only
when it differs from the base repository) and the destination branch. The
reported `number` is the pull request id and the URL is
`https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>`, built from the
validated parts. Map 400, 401, 403/429, 404/410 and other statuses to fixed
diagnostics that never echo Bitbucket's text. Requests use the same 10-second
deadline, reject redirects and are not retried. Bitbucket's answer to creating a
second pull request for an already open source and destination is not
documented, so a creation rejected with 400 is followed by one more lookup, as
on GitHub: an open pull request found then is reported as `exists`, otherwise
the rejection stands.

Issue mentions follow the rules above, except for GitHub issues: on Bitbucket a
bare `#<n>` names a Bitbucket issue, so a GitHub issue is mentioned as
`Refs https://github.com/<owner>/<repo>/issues/<n>` when its repository is
known, and its link or `owner/repo#<n>` count as an existing mention. Without a
known GitHub repository, no GitHub mention is added. Jira and Linear keys are
mentioned as `Refs <KEY>`. `__app-pr` still reads only GitHub.

## Saved worktree bases (#79)

`new` saves its resolved canonical base ref in private, versioned Git-admin metadata
before setup or launches. Store the moving branch identity, not its creation commit.
Metadata is bound to the canonical repository/worktree paths, validated against Git's
reciprocal worktree identity, and published atomically with private permissions. Save failure retains
the created worktree and reports recovery guidance. `open` never prompts for,
resolves, reads or writes a base association. Opening an unassigned branch leaves
its base unset; existing saved or invalid associations
remain unchanged. Use `rebase --base <ref>` to assign a base later.
Arena creation is unchanged.

`ls` shows a BASE column after BRANCH: remote bases display `remote/branch`, local
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
previous saved association. Cleanup uses the same saved-base precedence, with invocation-local overrides that never save a new association.

## Worktree issue links (#153)

When `new` creates a worktree from a GitHub, Jira or Linear issue, through an
explicit selector or the default tracker, it saves the link in private, versioned
Git-admin metadata beside the saved base, after saving the base and before setup or
launches. The link holds the tracker (`github`, `jira`, `linear`), the key (the
GitHub issue number or the Jira/Linear key the tracker returned), and the issue URL
from the lookup. It is bound to the same worktree identity as the saved base and
published atomically with private permissions. Saving and reading never contact a
tracker. A branch name, a sentence, or a default-tracker input that fell back to a
literal branch saves no link. Save failure retains the created worktree, skips setup
and launches, and prints an `open --issue` retry command.

`open --issue <selector>` attaches a link to an existing worktree or to the worktree
it creates from an existing branch. The selector uses `new`'s issue forms, including
default-tracker keys and numbers; other input is a usage error. Before any lookup,
Timber reads the existing link offline: the same tracker and key changes nothing and
makes no lookup, a different link is refused without changes unless
`--replace-issue` is given, and malformed or unreadable metadata is refused even with
`--replace-issue`. Stale identity records may be replaced. Timber then looks the issue
up once to confirm it and read its URL. Closed and completed issues are accepted,
since the link records existing work. A failed lookup stops before creating a
worktree or changing metadata. The primary worktree cannot be linked.
`--replace-issue` without `--issue` is a usage error. Other `open` behavior is
unchanged.

`done` removes the link with Git's worktree metadata. A branch kept with
`--keep-branch` and opened again later starts unlinked. Rebase, publish, backups and
Arena neither read nor write links.

`ls --json` reports each worktree's link as described in the
[IDE contract](ide-contract.md#issue-link). Damaged metadata is reported as invalid
with a reason and a stderr warning, never hidden, and never fails the listing. The
human table has no issue column.

## Worktree recovery backups (#119)

`timber backup create <branch-or-worktree>` captures a recoverable starting point
for one existing registered worktree. `timber backup restore <id> <destination>`
recovers it into a new directory and recovery branch. A backup is recovery, not an
agent permission boundary and not a full repository disaster backup.

Selection matches `rebase`, including mapping a paused rebase's branch to its
worktree so the refusal below is reported: exact branch, absolute path, or delimiter-boundary
ticket matching, filtered to registered worktrees, with the existing chooser or
capped diagnostic; cancellation does not mutate. The primary worktree is eligible.
Detached worktrees with a commit are eligible. Refuse missing, stale, locked,
unverifiable and unborn targets, and in-progress rebase/am/merge/cherry-pick/revert/
sequencer state; finish or abort those explicitly first.

Storage lives in `<commonGitDir>/timber/backups/`, outside every worktree, so
`timber done` or `git worktree remove` cannot delete it. Deleting the repository's
common Git directory deletes its backups. Directories are 0700 and files 0600
(private ACLs on Windows). A published backup `<id>/` holds `record.json`,
`manifest.json` and numbered regular-file blobs. IDs are
`<UTC YYYYMMDDTHHMMSSZ>-<8 lowercase hex>`. The private ref
`refs/timber/backups/<id>` pins the original commit; default fetch/push refspecs do
not transfer it and Timber never pushes it. Backups copy ignored files, including
secrets such as `.env`. Timber never prints file names, contents or link targets.

The snapshot walks the worktree root without following symlinks. It records
directories, regular files with their bytes and permission bits (0777 only), and
symlinks with their literal targets; empty directories are kept and hard links
become independent files. Tracked, modified, untracked and ignored content is
included. Exclude every `.git` entry at any depth (case-insensitively on macOS and
Windows), the worktree's own and common Git directories by path, and the roots of
other registered worktrees nested inside the target. Sparse-checkout worktrees are
refused because a restore would show excluded paths as deletions. Sockets, FIFOs, devices, other
unsupported types and names that are not valid UTF-8 refuse the whole backup;
nothing is silently skipped. The Git index and in-progress operation state are not
captured.

Creation builds an exclusively created `.incomplete-<id>/` directory, checks free
space against the measured snapshot size, copies each file through a
no-follow, nonblocking descriptor (POSIX) while hashing it, reads no more than its
observed size, and compares file metadata before and after
each read. It then re-walks the source and compares every entry's type, mode, size,
inode and change/modification times, revalidates worktree identity, branch, original
commit and idle state, and re-reads every blob against the manifest. Only then does
it write the record, create the ref with a create-only update and atomically rename
the directory to `<id>`. Any failure, including insufficient storage, unsupported
files and concurrent changes, removes the incomplete directory and the ref only if
Timber created it and it still names the backed-up commit, and reports that no
backup was created. SIGINT and SIGTERM remove the incomplete directory and any ref Timber
created before exiting. A forced kill can leave an `.incomplete-*` directory and
possibly its ref; neither is a usable backup. Sequential reads cannot lock out
concurrent writers, and a writer that restores identical metadata can evade
detection; do not edit the target during a backup. Creation never changes the
source worktree, its index or its refs, and never runs hooks, editors or agents.

Report the ID, worktree, branch, commit, entry count, size, storage directory, that
ignored files were copied, and the restore command.

Restore resolves `<destination>` from the invoking directory. It must not exist,
its parent must be an existing directory, and it must not be inside the common Git
directory. Before creating anything, read the record and manifest as private
regular files, validate their schema, ID and digest, check that the ref names the
recorded commit (location and ref prove membership; recorded paths are
informational, so a moved repository stays restorable), validate every manifest path (relative,
unique, no `..` or `.git` component, parents declared as directories) and verify
every blob's size, digest and private mode. The recovery branch is
`recovery/<id>`; an existing branch refuses restore.

Restore then runs `git worktree add --no-checkout -b recovery/<id>` with hooks
disabled, verifies the new worktree's identity, creates directories, writes files
exclusively and creates symlinks last so no write follows a restored link, applies
recorded modes, and runs `git read-tree <commit>` so the index matches the backed-up
commit without touching files. The recovered changes therefore appear as unstaged
or untracked; original staging is not restored. Restore never runs hooks, setup,
editors, agents or repository scripts, and never changes the source worktree or the
backup. If Git fails before creating the worktree but leaves the branch, report the
`git branch -D` command. If it fails after creating the recovery worktree, it keeps the incomplete
workspace and branch, returns nonzero, and reports exact
`git worktree remove --force` and `git branch -D` commands for manual removal.

Ordinary `rebase` behavior is unchanged. Listing, deletion and the `done`
lifecycle are below (#120); retention is separate (#121).

## Backup list, deletion and done lifecycle (#120)

`timber backup list` is read-only. It reads `<commonGitDir>/timber/backups/` and
`refs/timber/backups/` and prints, for each usable backup, its ID, source branch
(or `detached HEAD`), creation time, snapshot size and entry count, recorded source
worktree path, protection status and expiry, followed by the total size. Names,
branches and paths are rendered with control characters escaped. A usable backup
is a private directory, not a link, whose record and manifest validate as for
restore, which holds exactly the record, the manifest and the listed blobs, and
whose ref names the recorded commit. Everything else is reported under "Not
usable" with a reason and is never offered for deletion: malformed, unreadable or
nonprivate records, links, unexpected or missing files, a missing or moved ref,
`.incomplete-<id>` directories, unrecognized names, and refs with no backup
directory. Interrupted deletions (`.deleting-<id>`) are listed separately as
unfinished. Missing storage lists no backups and creates nothing. Output never
includes snapshot file names or contents and repeats that backups can contain
copies of ignored files such as `.env` after their source worktree is removed.

`timber backup list --json` prints the same list for app consumers as one JSON
object plus newline on stdout, schema version 1 (`schemaVersion: 1`). It reads the
same inventory, validation and protection as the text form, so the two never
disagree, and it is just as read-only: it changes no files, refs or backup storage,
creates nothing when storage is missing, and skips the first-use setup hint. It
never includes snapshot file names or contents.

```ts
type BackupListRecord = {
  schemaVersion: 1;
  outcome: "succeeded" | "failed";
  exitCode: 0 | 1;            // equals the process exit code
  repository: RepositoryIdentity | null; // as in ls --json; null when discovery failed
  diagnostic: string | null;  // terminal-safe failure text, not a stable code; non-null only when failed
  backups: {                  // usable backups, ascending ID
    id: string;
    branch: string | null;    // recorded source branch; null for detached HEAD
    commit: string;           // recorded commit, pinned by refs/timber/backups/<id>
    createdAt: string;        // creation time as recorded; Timber writes ISO 8601 UTC
    bytes: number;            // snapshot size in bytes
    entries: number;          // snapshot entry count
    worktreePath: string;     // recorded source worktree path; it may no longer exist
    recordSha256: string;     // lowercase hex SHA-256 of the exact record.json bytes
    protection: { protected: false; reason: null } | { protected: true; reason: string };
    expiry: null;             // version 1 records carry no retention policy; kept until deleted
  }[];
  unfinished: {               // .deleting-<id> directories, ascending
    id: string;
    directory: string;
    recordSha256: string | null; // null once record.json is gone or the remains cannot be read
  }[];
  notUsable: { name: string; reason: string }[];   // storage names ascending, then refs ascending
  totalBytes: number;         // sum of bytes over usable backups
};
```

Unusable entries, unfinished deletions and protected backups keep `outcome:
"succeeded"` and exit 0, as in the text form; exit 0 does not mean every entry is
usable. Storage that is not private, a ref listing Git cannot read, or a failed
repository discovery give `outcome: "failed"`, exit 1, empty lists and
`totalBytes: 0`, with nothing on stderr. Names, branches and paths are raw values
(JSON-escaped on the wire), not the escaped terminal rendering; treat them as
untrusted text. `reason` is the text form's terminal-safe wording, not a stable
code. `expiry: null` means no recorded retention policy; #121 defines any non-null
form, and consumers must not assume its shape. Help and option parse failures
print ordinary help or errors and no record. Additional fields may be added within
version 1; incompatible changes need a new schema version. See the
[IDE machine interface](ide-contract.md#backups-for-app-consumers-experimental-v1).

Expiry: version 1 records carry no retention policy, so expiry is shown as
"none, no retention policy; kept until deleted". Timber never derives an expiry
for a record without a recorded policy; #121 defines retention and its migration.

Protection: a backup is protected while a rebase is active or uncertain for it.
Timber inspects the common Git directory and every `worktrees/<name>` admin
directory, including stale ones, for `rebase-merge` or `rebase-apply`. A backup is
protected when its recorded source admin directory (mapped into the current
common Git directory, so moved repositories still match) has rebase state, or
when any rebase names the backup's recorded branch in `head-name`. Uncertainty
protects every backup: an admin directory or rebase marker that cannot be
inspected, a link in `worktrees/`, rebase state whose branch cannot be read (this
includes `git am`), or a record whose source admin directory cannot be mapped.
A missing admin directory, for example after `timber done`, is not rebase
state. Version 1 backups are created only from idle worktrees and record no
operation origin; a future record that marks a rebase origin must stay protected
until completion or abort is reliably observed, never inferred from a missing
rebase directory (#121). Protected backups are listed with their reason and are
never offered, by either form of `backup done`.

`timber backup done` reviews eligible (usable, unprotected) backups one at a time,
oldest ID first, showing the same details as `list`, then asks `Delete backup
<id>? Type y and press Enter to delete [y/N]`. Only `y` or `Y` followed by Enter
deletes; Enter alone, any other answer (including `yes`) keeps that backup and
moves to the next. End of input or Ctrl-C stops the review and keeps the rest.
`timber backup done --all` selects every eligible backup, prints the IDs, the
count and the total size, and asks once, `Delete all <n> backups (<size>)?`, with
the same rule; selection is not confirmation, and declining deletes nothing. Both
forms first print protected and unusable entries as not offered. Deletion
requires an interactive terminal (stdin and stdout are terminals and CI is off);
otherwise both forms refuse with a nonzero exit before reading storage. The human
command has no noninteractive or force option. Cancellation exits 0. An app deletes
one backup through the separate [app form](#backups-for-app-consumers-168), whose
approval is scoped to one confirmed backup state.

Each confirmed backup is deleted as one logical bundle: snapshot directory, ref
and record. Immediately before deletion Timber rereads the directory and record
and requires the same record bytes (SHA-256), the same directory identity
(device and inode, so a substituted link or directory fails), exactly the
expected files, the ref still naming the recorded commit, and no protection.
Any difference keeps the backup unchanged and reports it. It then renames
`<id>/` to `.deleting-<id>/` inside the backup root, checks identity, exact
contents and protection again (renaming back on any difference), deletes the ref with
`git update-ref -d <ref> <commit>` so a moved ref is never deleted (renaming back
on failure), and removes only the manifest-listed blobs, then `manifest.json`,
then `record.json`, by name with no recursion and no link following, checking the
directory identity before each removal, and finally removes the empty directory.
Unrelated files, other backups, other refs and every source worktree are never
touched. Git runs with hooks disabled and argument arrays.

A failure after the ref is deleted reports the actual remaining state (whether
the ref still exists and how many files remain where), says the backup is no
longer restorable, never reports success for it, and exits nonzero. The next
`timber backup done` (either form) offers the unfinished deletion with the same
confirmation and finishes it only when its contents are a state Timber's own
deletion order can leave (a subset of listed blobs, then manifest, then record)
and any remaining ref names the recorded commit; otherwise it is listed as not
usable for manual inspection, and the report includes a manual `rm -r` command.
The summary reports how many were deleted and how many were not fully deleted.

`timber done` never deletes or changes backups; its Git and worktree safety
rules are unchanged. After a successful cleanup it reports the IDs of usable
backups whose recorded source worktree path is the removed worktree, that they
can still contain copies of ignored files including secrets such as `.env`, and
how to list, restore and delete them. A failure to read backups only replaces
that report with a pointer to `timber backup list`; it never changes the cleanup
outcome. Restore works unchanged after `timber done` removed the source worktree.

## Backups for app consumers (#168)

`timber backup restore <id> <destination> --result-file <path>` restores exactly
as above and also writes one v1 record; human output and exit codes are unchanged.
See [Backup restore outcome](ide-contract.md#backup-restore-outcome).

`timber __app-backup delete --id <id> --record-sha256 <digest> --result-file <path>`
is a hidden, noninteractive form for an app that shows one backup and asks for
confirmation itself. All three options are required, and there is no form that
selects more than one backup. `<digest>` is the lowercase hex SHA-256 of the exact
`record.json` bytes of the backup the person confirmed. `timber backup list --json`
supplies it as `recordSha256` on each usable backup and unfinished deletion. It needs no terminal, asks nothing, and runs every
check of `backup done` immediately before deletion: the backup must be usable and
unprotected, its record bytes must match the digest, and the rereads, rename,
conditional ref deletion and named file removal above follow unchanged. Anything
else, including an unknown ID, an unusable or substituted entry, a protected
backup, a record that changed, or more than one storage entry with that ID, is
refused with exit 1 and nothing is changed. The approval covers one backup state
only; it is not a general force option.

A partial failure reports the actual remaining state and the manual `rm -r`
command, as `backup done` does, plus `git update-ref -d` for a private ref that
still exists. Those commands are a manual fallback without Timber's checks. A later `__app-backup delete` with the same ID
finishes an unfinished `.deleting-<id>` deletion under the `backup done` rules:
while its `record.json` remains the digest must still match; once the record is
gone nothing restorable remains and the ID alone identifies it. `backup done`
can finish it too. See [Backup delete outcome](ide-contract.md#backup-delete-outcome).
Interactive `backup done` is unchanged.

## Update notice and `update` (#146)

`timber update [--check] [--version <tag>]` updates the standalone executable.
`--version` takes the installer's tag grammar (`vMAJOR.MINOR.PATCH` with an
optional `-rc.N`). `--check` and `--version` together are rejected. Without `--check` it refuses, with a diagnostic and no changes,
on Windows, from a source run, when the install directory is not writable, when the
running executable is not named `timber`, or when `curl` or `sh` is missing. Otherwise
it resolves the latest tag from the `releases/latest` redirect (or uses `--version`),
exits 0 without downloading when that is the running version (or, for latest, an older one;
the message says `already installed` for an exact `--version` and `already the latest version` otherwise),
downloads `<releases>/download/<tag>/install.sh`, and runs `sh <file>` with
`TIMBER_INSTALL_DIR` set to the running executable's directory and `TIMBER_VERSION`
set to the tag. `curl` and `sh` receive argument arrays only, and installer output streams to the terminal. A nonzero installer exit is an
error and leaves the existing executable as the installer left it (unchanged on
download or checksum failure). On success it prints the version the new executable
reports. `--check` does a fresh check, refreshes the cache, prints either
`Update available: timber X -> Y` plus `Run: timber update` or `Timber X is up to date.`,
and installs nothing.

Hidden `__update-check` is the one-shot child the notice spawns detached and unref'd,
from the temporary directory rather than the caller's working directory.
It resolves the latest stable tag, writes `$XDG_CACHE_HOME/timber/update-check.json`
(default `~/.cache/timber/`; JSON `{"tag"?, "checkedAt"}` with epoch milliseconds)
by temp file and rename with private modes, and exits 0 silently. It records
`checkedAt` even on failure and leaves a cached `tag` unchanged on failure.

After any other command finishes, when the cached stable tag is newer than the
running version, Timber prints `Update available: timber X -> Y` and `Run: timber update`
to stderr. A cache that is missing, corrupt or older than 24 hours spawns the child; the
parent never waits. Before spawning, the parent records the attempt time in the cache, so
commands run while the child works start no second check; when that write fails, no child
is started. Release candidates are never cached as the latest tag or announced.
Both the check and the notice are skipped when stderr is not a terminal, `CI` is set,
no subcommand is given (bare `--version` or `--help`), the command is hidden (`__*`), `update`
or `completion`, an argument is `--json`
or `--result-file`, the run is not a standalone executable, `TIMBER_NO_UPDATE_CHECK=1`
is set, or global config sets `update_check = false`. The request is a plain HTTPS GET
with a generic User-Agent and no query. `TIMBER_RELEASES_URL` must be https.

`update_check` is an optional boolean; only the global configuration is consulted, and `false` disables
the check and notice. See the [guide](guide.md#update-notice-and-timber-update).

## `new` branch input

Quoted and unquoted sentence arguments are joined into the same raw input by the
CLI. Only inputs containing literal U+0020 spaces are normalized: remove leading
and trailing U+0020 spaces, lowercase, and replace each run of internal U+0020
spaces with one hyphen. Inputs without U+0020 remain byte-for-byte unchanged, so
exact Jira ticket detection continues to use the raw whole input. Reject blank
names and control characters before worktree creation; safely render the original
input in control-character diagnostics. Preserve other characters for installed
Git to validate. Do not slugify punctuation or append suffixes. Sentence-derived
names are truncated only when `max_generated_branch_name_length` is configured;
inputs without U+0020 spaces remain exact regardless of this setting.

### Existing branch guard

For the final resolved name, `new` inspects the exact local ref, each eligible
remote's cached remote-tracking ref, and the live remote head (`git ls-remote
--heads` for the exact `refs/heads/<name>`; a longer ref that merely ends with the
name never matches). It never fetches and never changes refs during the check.
Eligible remotes follow the remote-selection rules above: `remote` from
configuration when set (it must exist), otherwise all remotes. Absence is only
reported when a lookup succeeds and returns no such head. A failed, timed-out or
unparsable lookup is "unknown", never "absent".

| State | Behavior |
| --- | --- |
| No remotes, no local branch | Create as before, no network. |
| Every eligible remote verified missing, no cached refs | Create. |
| Local branch exists | Refuse: `Branch <name> already exists. Use timber open instead.` with a quoted `timber open` command (the worktree path when checked out). The branch tip and upstream are untouched. |
| Live remote branch exists, no local | Interactive: ask `Branch already exists on <remote>. Did you mean timber open?` with `Open existing branch` and `Cancel`; Cancel is the default and quit or end of input also cancels (prints `Cancelled.`, exit 0). Noninteractive: refuse with exit 1 and `timber open -- '<remote>/<name>'`. |
| Cached and live differ, or only live exists | Same as above, plus `Cached <remote>/<name>: <12-char commit or missing>; live: <12-char commit>`. |
| Cached ref exists but the live branch is missing | Refuse in both modes (stale tracking ref); no prompt. |
| Any eligible remote unknown | Refuse in both modes, naming the remote; no prompt. |
| Live branch on several remotes | One chooser listing each remote plus Cancel; noninteractive refuses listing every command. A remote is never chosen silently. |
| `--base` with an existing local or remote branch | Refuse; `--base` is never silently ignored. |

Accepting Open re-inspects the target, then requires the local branch to still be
absent and the chosen remote's live head to equal the commit shown. Otherwise it
refuses with `<remote>/<name> changed or disappeared after selection` and never
falls back to creation. It then delegates to the ordinary `open` handler with the
exact `<remote>/<name>` selector (refresh, materialize history, configure the
upstream; no rebase onto a newer base, no base association). `--workflow`,
`--editor`, `--agent` and `--no-setup` carry over. A resolved ticket is passed on
as `--issue`, so the opened worktree is linked to it; a GitHub ticket selected with
`--remote` is not linked, because `open` resolves GitHub issues in the default
issue repository, and `new` says so. Refusal and cancellation run no
hooks, editors or agents and leave files, refs and worktree registrations intact.

## Repository configuration

Read `.timber.toml` from the primary worktree root and Linux machine defaults from `${XDG_CONFIG_HOME:-$HOME/.config}/timber/config.toml`. Empty or relative XDG paths use the HOME fallback. Do not search nested or linked-worktree configuration. Validate both existing files independently; unknown keys, unreadable files, and invalid values are errors even when overridden in the other scope. Missing files use defaults.

Core configuration keys are `base_branch`, `remote`, `worktree_dir`,
`max_generated_branch_name_length`, `update_check`, `[editor]`, and `[agent]`. `base_branch` and `remote` default to absent. `worktree_dir` defaults to absent and, when relative, resolves against the primary root. `[editor]` requires a non-empty executable `command`; `args` is a string array defaulting to `[]`, and boolean `enabled` defaults to `false`. `[agent]` also requires `command` and accepts `args` defaulting to `[]` plus boolean `enabled` defaulting to `false`. Editor tables additionally accept `integration = "orca"`; agent tables accept boolean `wait_for_setup` (default false), as specified in TIM-27 below.

Precedence is explicit CLI options > repository TOML > global TOML > built-in defaults. Absent keys inherit. Present optional tables replace the whole lower-scope table: executable/argument combinations stay together, and argument arrays and hook lists never concatenate. Relative `worktree_dir` in either scope resolves against the current repository's primary root. Root-level `editor = false`, `agent = false`, `hooks = false`, or `jira = false` explicitly disables that inherited integration; `true` is invalid. Editor and agent tables with a command and `enabled = false` still support explicit `--editor` and `--agent`, respectively; root-level `false` removes the inherited command. Diagnostics identify the config file and invalid field without printing config values. Do not store credentials or other secrets in this file; use environment variables or a secret store. Hooks and Jira are optional integrations described below.

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

`max_generated_branch_name_length` is an optional positive safe integer in either
configuration scope. Repository values override global values; both files must be
valid independently. It caps the complete generated branch name in Unicode code
points, including an issue's full canonical ID and its separator. For example:

```toml
max_generated_branch_name_length = 80
```

GitHub, Linear and Jira names retain the full ID plus at least one descriptive
ASCII suffix character. Refuse a limit too small for these before creation.
Their existing title normalization is unchanged. Sentence input retains existing
space/lowercase normalization. When a configured limit is exceeded, cut back to the
last complete word (separators `-`, `_`, `.`, `/` for sentences; `-` for issue
slugs) and remove trailing separators. If not even one whole word fits, fall back
to a hard cut at the limit without splitting Unicode code points. Issue names
always keep the full ID, its separator and at least one suffix character. Refuse
an empty result.

When a name was shortened and the command is interactive, `new` shows the
generated name, the shortened proposal and the limit before any Git mutation, and
lets the user accept the proposal, finish the word the limit cut, or enter a
replacement. The finish choice appears only when the limit fell inside a word; it
extends the cut to the end of that word (next separator or end of name), removes
trailing separators, and may exceed the limit (for example limit 10 turns
`fix-this-issue-with-number-5` into `fix-this`, with `fix-this-issue` offered). It is
still validated as a Git branch name. A typed replacement must be
non-blank, within the limit, a valid Git branch name, and for issues start with
`<ID>-`; invalid input is asked again. Cancelling or end of input aborts with no
Git changes. Non-interactive runs use the shortened proposal without prompting.
Names within the limit are never prompted. Installed Git validates the final name, and existing branch/path
collision checks still refuse without mutation or automatic collision suffixes.
Explicit names without spaces, existing branches opened by `open`, and Arena's
structured names are unaffected. When unset, issue names retain their 120-character
cap and sentence names remain uncapped. A configured value above 120 can increase
the issue-name cap; filesystem and Git limits still apply.

An alternative for Visual Studio Code is:

```toml
[editor]
command = "code"
args = ["--new-window"]
enabled = false
```

The editor executable must be available on `PATH` or configured by absolute path. Editor and agent commands are executable names plus argument arrays, never shell command strings. Pass editor arguments literally and append the absolute selected worktree path as the final argument. `--editor` requires a configured command and fails before worktree creation if one is absent; `--editor` with `--no-editor` is an error before mutation. On startup failure after worktree creation, retain the worktree and provide a retry command of the form `timber open --editor -- '<absolute-worktree-path>'`; retry opens the existing worktree after the user fixes the editor configuration or `PATH`. The retry string is display text and must not be executed internally. Trusted shell hooks receive context through environment variables; do not substitute branch names or ticket text into shell source.

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

Outside enabled Orca integration, on local worktree creation, including `open` materializing an existing local or remote branch, Timber runs ordinary `post_create` hooks, runs the selected workflow's `post_create` hooks, opens the effective editor, then starts the initial agent. A workflow applies only to the invocation that names it: Timber saves nothing about it in the worktree, and `ls` and the machine records do not report it. Setup receives `TIMBER_WORKFLOW` as environment data; an invocation without `--workflow` has no inherited `TIMBER_WORKFLOW`. Shell source is never interpolated. A user's executable or wrapper may supply its preferred prompt or open a separate window; Timber itself keeps the agent in the invoking foreground terminal and passes arguments literally.

`open --workflow <name>` on an existing worktree applies the selected editor launch policy for that invocation, without creation scripts or an implicit agent, even when global `[agent].enabled = true`. Repeating it behaves the same. A later `open` without `--workflow` remembers nothing and follows ordinary `[editor]`, `[agent]` and hook settings, exactly as for a worktree that never used a workflow. `open --setup` deliberately reruns ordinary scripts from the start once, followed by workflow scripts only when `--workflow <name>` is given again; it does not imply an agent launch. `open --agent --workflow <name>` deliberately launches that workflow's agent or its inherited ordinary agent, including its initial prompt arguments; `--no-agent` suppresses it. Agent launch requires either an interactive stdin/stdout terminal with CI off or an enabled, selected Orca editor integration. Without either host, explicit agent launch fails before mutation and config-driven agent launch skips.

No workflow association is stored. A `timber/workflow.json` file left in a worktree's private Git administrative directory by an earlier version is ignored: it is never read, shown, or modified, and Git removes it with the linked worktree. An unknown workflow name fails before any mutation or launch.

Failures after creation retain the worktree, refs, and script files. In foreground mode, script failures stop editor and agent launch; editor startup failure stops agent launch. An ordinary reopen does not retry creation actions. Repair and deliberately rerun scripts with `timber open --setup -- '<absolute-worktree-path>'`; retry the editor with `timber open --editor -- '<absolute-worktree-path>'`; retry the agent with `timber open --agent --no-editor -- '<absolute-worktree-path>'`. When the failed invocation named a workflow, each printed retry command repeats `--workflow <name>` before `--`, because the workflow is not remembered. Scripts must tolerate explicit reruns. Timber does not promise exactly-once side effects across crashes. Keep secrets out of config, metadata, and diagnostics.

## Issue list settings

Optional `[github]` (`project`, `milestone`) and `[linear]` (`team`) tables, and the
`board`, `sprint_jql` and `project` keys of `[jira]`, say where
`timber __app-issues` finds a sprint and a project. They are strict, validated in
both scopes like every other key, kept by `timber setup`, and used by nothing
else; `github = false` or `linear = false` clears them. See
[issue lists](ide-contract.md#issue-lists-for-app-consumers-experimental-v1).

## Default issue tracker

Optional `default_tracker = "github"`, `"linear"`, `"jira"`, or `"none"` selects
unprefixed lookup. Repository settings override machine defaults. Absence inherits;
absence in both scopes preserves legacy configured-Jira/literal behavior, including
legacy Jira suggestions. An explicitly saved global default applies to repositories
without a local preference. Repository `"none"` overrides it without removing Jira
site settings or any provider credentials. None makes all unprefixed names literal.

Explicit whole-input `github:97`, `linear:ENG-123`, and `jira:ENG-123` select their
provider regardless of the default, including None. Jira requires effective site
settings and credentials, and cannot override `jira = false`. Malformed explicit
selectors fail before lookup/mutation. No explicit selector falls back or suggests.

With GitHub selected, a raw whole positive decimal matching the explicit GitHub
number grammar is an issue selector. With Linear/Jira selected, raw uppercase
keys matching `^[A-Z][A-Z0-9]*-[0-9]+$` select that provider. All other inputs remain
ordinary branches; do not trim, normalize, search, or probe providers to find an
issue. Existing sentence normalization applies only to the eventual literal branch.

For a default-origin lookup only, an exact missing result prints a safe notice
before creating the original literal branch, such as `Jira ticket ENG-123 was not
found. Creating literal branch ENG-123.` Exact GitHub/Jira issue HTTP 404 qualifies.
Linear requires one GraphQL INPUT_ERROR with exact Issue-specific missing wording
and no partial data. Path and type, when supplied, must identify the issue lookup
and invalid input; generic input errors are never missing.
Providers may hide inaccessible tickets as missing; this ambiguity is accepted.
Authentication, explicit permission denial, timeout, rate limit, redirect, HTTP 410,
malformed/partial data, unknown state and deleted/trashed-issue failures stop before
creation, scripts or launches. A Git creation failure never retries with a literal.

`-c` allows known terminal issues for every provider without reopening/updating them:
GitHub closed, Jira done, Linear completed/canceled/duplicate. Unknown or deleted
states always fail. Without `-c`, known terminal issues refuse with flag guidance;
new explicit/default flows never offer Jira suggestions. Legacy bare Jira with `-c`
is exact, without suggestions or missing fallback. `--remote` stays GitHub-only;
issue-only flags fail on literal routes, including None. Valid default lookups may
still fall back on missing with those flags. Base selection remains independent and
finishes before credentials/HTTP. Canonical key/title/browse URL are safely displayed
after creation, before scripts or foreground/Orca launches. Branch naming and link
output do not add persisted issue association metadata. Existing Git preservation,
metadata-save and failure-retention rules remain binding.

Guided setup question 3 is "Which issue tracker do you use?". Selecting GitHub,
Linear or Jira sets the preference and opens only that provider's connection setup.
None stores `"none"`; Inherit machine default removes only the preference. The hub
has a Default issue tracker section and an independent Connections
menu for all providers and the Bitbucket pull request login; connection edits do not change the default. Saving an
unconfigured preference is allowed, but runtime authentication/configuration failures
remain errors. Existing credential Save/cancel/rollback and immediate external
GitHub login behavior are unchanged. Selecting another tracker never logs out or
removes credentials. The provider sections below retain their transport and auth
requirements subject to these routing/setup changes.

## GitHub issue lookup (#96)

`timber new github:123` resolves one exact GitHub issue in a repository selected
from the current project's Git remotes. Explicit raw whole input
`github:<positive-decimal-number>` is recognized; the configured GitHub default also recognizes bare numbers. Reject zero, leading zeros,
unsafe integers and malformed `github:` inputs before lookup or mutation.
No issue URLs, explicit owner/repo syntax or Enterprise hosts.

Issue remote precedence is explicit `--remote <name>`, configured `remote`, then
`origin`. If none identifies a registered remote, require explicit selection.
Reject invalid selected remotes without probing alternatives. Read effective fetch
URLs from installed Git using argument arrays. Require exactly one github.com
repository URL in HTTPS, `ssh://git@github.com/owner/repo`, or
`git@github.com:owner/repo` form; optional `.git` is supported. Reject embedded
HTTPS credentials, query/fragment/control bytes and ambiguous destinations.
`--remote` selects only the issue repository. It does not override ordinary base
selection; `--base` remains independent. Reject `--remote` for non-GitHub inputs; `-c` applies to every issue provider.
Ordinary base resolution is unchanged.

Resolve the base before credentials or HTTP. Explicit process `GH_TOKEN` overrides
`GITHUB_TOKEN`, then the active github.com account from
`gh auth token --hostname github.com`. A supplied blank or malformed higher-priority
override fails without fallback. Environment overrides need no saved login;
otherwise gh must be installed and logged in. No dotenv loading, anonymous
fallback, account switching or Timber GitHub credential file. The existing Bun
source-runner dotenv caveat in the Jira section also applies here.

Capture token output privately in memory with closed stdin, bounded output and
safe subprocess errors. Disable gh debugging/prompts for runtime retrieval.
GitHub CLI owns its credential lifecycle; Timber never explicitly refreshes or
changes its authentication during lookup. Only stable token/login flags are used;
the development check used gh 2.101.0, without assuming newer --no-refresh flags.

One 10-second deadline includes token retrieval, the exact fixed-host REST request,
body parsing and validation. Reject redirects and do not retry. Request
`https://api.github.com/repos/<owner>/<repo>/issues/<number>` with JSON accept and
the supported `2022-11-28` API version. Validate exact issue number, nonblank title,
known open/closed state, and absence of `pull_request`. Construct the browse URL
from the validated requested repository and number. Never expose tokens, raw
transport errors or response bodies. Failures stop before creation/hooks/launch.

Closed issues refuse creation and suggest `-c`. Explicit `-c` permits closed
issues but never reopens them, permits PRs, or bypasses Git protections. Generate
`GH-<number>-<title-slug>` with the existing Jira algorithm and configured total cap
(120 characters when unset). No collision suffixes. Output the branch/path and
GitHub URL after creation.
Titles become potentially public branch text. Different issue repositories share
the local GH-number namespace, and title changes can produce new branches:
`open GH-123` uses existing offline matching, including its ambiguity chooser.
Hooks extract `TIMBER_TASK_ID=GH-123`. `open`, `ls` and `done` stay offline.

Both setup scopes expose GitHub login through the default chooser and connections
menu, with no Timber GitHub credential Save participant. A successful check identifies the authenticated
account, not repository/team/issue access. When logged out, explicitly offer an
awaited interactive `gh auth login --hostname github.com` with inherited terminal
stdio. Explain first that this is an immediate external login and cancelling
Timber setup afterward cannot undo it. GitHub CLI may offer its own Git protocol
or authentication settings during login; users control those choices. Timber does
not invoke setup-git, install gh, switch accounts or change remotes. Environment
overrides must be unset before using assisted saved-account login. Missing gh gets
installation guidance. Failed checks/login return to setup for retry or cancel.
Release and restore the prompt's input listeners and raw mode around login; do
not impose the runtime request deadline on human interaction. Jira drafts and
ordinary config Save/cancel remain unchanged.

See [GitHub CLI token](https://cli.github.com/manual/gh_auth_token),
[login](https://cli.github.com/manual/gh_auth_login),
[environment precedence](https://cli.github.com/manual/gh_help_environment), and
[GitHub issue REST API](https://docs.github.com/en/rest/issues/issues#get-an-issue).

## Linear issue lookup (#97)

`timber new linear:ENG-123` resolves an exact Linear issue without TOML
configuration. Recognize explicit raw whole-input `linear:<KEY>` using the existing
uppercase ticket-key grammar. Reject malformed inputs beginning with `linear:`
before lookup or mutation. Bare `ENG-123` uses Linear when selected as the default;
without a default it retains configured Jira/literal behavior.
No URL selectors, search, provider inference, OAuth or issue updates. `--remote`
remains GitHub-only; `-c` permits known terminal Linear issues.

Resolve the ordinary explicit/configured base before credentials or HTTP. A supplied
process `LINEAR_API_KEY` overrides the saved personal key; blank or malformed
supplied values fail without fallback. Otherwise read the single private personal
key from `${XDG_CONFIG_HOME:-$HOME/.config}/timber/credentials/linear.json` through
the existing XDG/HOME path rules. Missing credentials point to `timber setup`.
Do not load dotenv files explicitly; the Bun source-runner caveat below applies.

POST a static GraphQL query with identifier variables to the fixed
`https://api.linear.app/graphql` endpoint. Personal API keys use `Authorization:
<key>` without a Bearer prefix. Query `issue(id: $id)` for canonical identifier,
title, URL, trash flag and `state { type }`. Validate the canonical uppercase key, nonblank
title and HTTPS browse URL with exact `linear.app` hostname, no user information,
nondefault port or control characters. Use the canonical key when an old identifier
resolves to a moved issue. Allow nonterminal types `triage`, `backlog`, `unstarted`
and `started`; completed, canceled and duplicate require `-c`. Refuse unknown/missing state,
missing/deleted issues and malformed responses. Do not use customizable state names.
GraphQL errors refuse creation, including partial issue data; only the narrow
missing-only result described in #101 can authorize default-origin fallback.

One 10-second deadline includes credential resolution, fetch, body parsing and
validation. Reject redirects and never retry. Authentication, access, not-found,
rate-limit, network, timeout and validation failures return nonzero before Git
creation, metadata, hooks or launches, except the missing-only default fallback
described above. Never disclose keys, response bodies, raw GraphQL messages or raw transport exceptions.

Generate `<canonical-key>-<title-slug>` with the existing Jira slug algorithm and
configured total cap (120 characters when unset). Git remains authoritative for
collisions, without appended suffixes. Print branch/path and the Linear browse URL after creation. Reuse saved
base metadata, workflow selection, setup, hooks and editor/agent sequencing. Titles become
potentially public branch text; title changes can generate different branch names.
Offline ticket matching and hook `TIMBER_TASK_ID` extraction remain unchanged.
`open`, `ls` and `done` never contact Linear.

Both setup scopes expose Linear through the chooser/connections menu and edit the same
personal credential. Explain [personal key creation](https://linear.app/docs/api-and-webhooks),
Read permission and team restrictions. Offer keep, enter/replace and remove with
hidden token input, including pasted input. Review shows only the action and private
path. Keys are plaintext personal storage shared across repositories, never TOML.
Use owner-only 0600 files and a 0700 credential directory on Linux, with existing
private-storage protections, atomic publication, locks and concurrent-change checks.
No broad credential-store refactor or changes to Jira's storage format.

An optional read-only `viewer { id }` check uses the draft key, irrespective of the
environment override. Bound it to 10 seconds including body parsing, reject
redirects and show safe success/failure without saving. Authentication success does
not prove team/issue access. Failed checks permit correction or cancellation.
Entering/checking a draft never saves it. Save publishes personal credential drafts
with the existing configuration commit point; cancellation or save failure restores
prior credentials with guarded rollback that preserves concurrent changes. Scope
switches discard drafts. Removing a Linear key affects only Linear storage, leaving
Jira and GitHub authentication unchanged.

See [Linear GraphQL documentation](https://linear.app/developers/graphql) and the
[official schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql).

## Jira ticket lookup (0.2, TIM-10)

Jira lookup is enabled when the resolved repository/global configuration has a
`[jira]` table; local `jira = false` disables a global Jira integration. The strict table accepts `site_url`, optional `cloud_id`, and the optional issue list settings `board`, `sprint_jql` and `project` (see [issue lists](ide-contract.md#issue-lists-for-app-consumers-experimental-v1)), which ticket lookup ignores:

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
`feature/foo`, `ENG-834-fix`, and `eng-834` remain literal branch names; a
ticket-looking literal can be named explicitly as `feature/ENG-834`.

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
Without `-c`, reject `done` with a diagnostic naming the returned canonical key, before branch
or worktree creation. Missing, null, or unknown status categories fail closed.
Use only the category key; status display names may be localized or customized, and
resolution fields do not override it.

For a recognized ticket, `new` validates its base before lookup. If the exact issue
is available and active, it generates `<canonical-key>-<summary-slug>` before the
existing Git creation checks. Normalize the summary with NFKD, remove combining
marks, lowercase, replace each run outside ASCII letters and digits with `-`, trim
hyphens, and cap the entire generated name at the configured length (120 ASCII
characters when unset) while preserving the key. Use `issue` if the summary leaves
no slug characters. Git remains authoritative for branch validity, existing refs, and path collisions; do not append
numeric suffixes or bypass collisions. Report the generated branch and browse URL
only after creation succeeds. The title contributes to a public-looking Git branch,
so use a literal branch when a title is sensitive. If a title changes, `new` may name
a different branch; use `open ENG-834` to resume an existing ticket branch offline.

Only legacy unprefixed Jira, without an explicit default or `-c`, offers suggestions.
In that flow, an exact issue 404 or a `done` status-category result enables suggestions. The
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
`--no-editor` does not disable setup. `new --no-setup` and `open --no-setup`
create the worktree as usual and run no ordinary or workflow `post_create` hook;
with enabled Orca integration they open no setup terminal. Editor and agent
choices are unchanged. When hooks were skipped, Timber prints the command that
runs them, `timber open --setup -- '<absolute-worktree-path>'` (with the same
`--workflow <name>` when one was given). `open --setup --no-setup` is a usage
error, refused before any mutation. A `--result-file` record still reports
`materialized: true` for a created worktree, and adds `setupSkipped: true` only
when configured hooks were skipped, so a caller knows whether to run
`open --setup` itself.

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

Discard revalidation compares file contents and staged index entries, including
modes, conflict stages and assume-unchanged/skip-worktree flags in initialized
submodules. Git stat-cache refreshes alone do not invalidate discard authorization.

## Editor terminals (TIM-27)

Ordinary and workflow editor tables accept optional `integration = "orca"`.
Omission keeps the generic editor launcher. The command names the local Orca CLI
(e.g. `orca-ide`), with literal args separate from agent args. Require a running
local Orca window, registered repository and visible external worktrees. Never
start another window/runtime. Remote routing is unsupported. Runner portability
includes a beta macOS arm64/x86_64 path, using native
microsecond process start identity and the same private request protocol. Lookup
failure must fail closed. macOS releases are beta, with native release checks;
desktop integration and broader OS compatibility remain under test. Stable macOS
support and a minimum OS version are not claimed. See [macOS beta](releases.md#macos-beta).
Editor-owned terminals currently support only `orca-ide`. Zed and VS Code (`code`) use the
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

### Timber app terminals

Terminals of the Timber app set `TIMBER_APP_HANDOFF` to a private folder the
app watches. When it is set, stdin and stdout are terminals and CI is off, a
`new` or `open` that creates a worktree hands it to the app instead of starting
the agent in the invoking terminal, so the app opens the worktree's session:
its own first saved agent when Timber would have started one, else a shell.
Setup and editor startup still run first, in the invoking terminal, with
their usual failures. Orca integration takes precedence. An `open` of a worktree
that already existed, a run with `--result-file`, and every noninteractive run,
behave as above.

Before any Git change, Timber checks the folder: an absolute path to a
directory, not a symlink, owned by the current user, with no group or other
permission bits (the ownership and mode checks apply where the platform has
user ids). An unusable folder prints one `warning:` line on stderr and the
command runs as outside the app.

The handoff writes one record, `<millis>-<pid>-<random>.json`, mode 0600,
renamed into place after a temporary dot-file so the app never reads it half
written. See the [record](ide-contract.md#handing-off-from-app-terminals-experimental-v1).
Success prints `Opening <path> in the Timber app.` (with `with its agent` when
one was wanted) and returns 0. A write failure returns 1, retains the
worktree, never starts the agent in place, and names the retry
`timber open --agent --no-editor -- '<absolute-worktree-path>'` when an agent
was wanted.

## Guided configuration (TIM-18)

`timber setup` guides configuration in the primary checkout from its root, a nested
directory, or a linked checkout. `timber setup --global` configures defaults for
all repositories and works outside Git. Both require interactive stdin/stdout and
CI off; noninteractive use fails with guidance and no writes. Main questions cover editor, agent, and default issue tracker; scripts and Git/folder
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

## Uninstall (#147)

```bash
timber uninstall                    # remove the executable; keep settings
timber uninstall --remove-settings  # also remove machine settings, credentials and state
timber uninstall --yes              # confirm without a prompt
```

- Removes only the running executable (`process.execPath`), and only for a
  standalone compiled release build. A Bun source or `bun link` run is refused
  with a pointer to CONTRIBUTING.md. Windows is refused with a pointer to the
  manual steps in docs/windows.md and docs/guide.md, because a running `.exe`
  cannot be deleted.
- Prints exactly what will be removed and kept, then requires interactive
  confirmation (default No). Without an interactive terminal it exits nonzero and
  removes nothing unless `--yes` is given. `--yes` covers only the items of the
  chosen mode.
- `--remove-settings` also removes `config.toml`, `credentials/jira.json`,
  `credentials/linear.json`, `credentials/bitbucket.json`, the `setup-hint-shown` marker and the
  `update-check.json` cache, using the same XDG resolution as
  `src/config-paths.ts`. The `timber/` config, credentials, state and cache
  directories are then removed only if empty. Unknown files are never deleted;
  they are listed.
- Before anything is removed, every target is checked. A symlink, a target
  not owned by the current user, a non-regular file, or a path inside a Git
  worktree or Git directory is refused and nothing is removed.
- Repositories, worktrees, branches, `.timber.toml` and `<git common dir>/timber/`
  are never touched. One output line says so.
- After removal Timber warns on stderr when another `timber` is still on `PATH`
  and reminds the user to remove shell completion lines they added. Shell
  startup files are never edited. Credential contents are never printed. No
  update notice or background update check runs after `uninstall`.

## Shell completion (TIM-23, #84, #85)

`timber completion bash`, `timber completion zsh`, and `timber completion fish`
emit activation scripts without editing shell startup files. The generator and
hidden completion transport bypass installation guidance, first-use state writes,
and interactive selection. Unsupported shells produce an actionable error naming
every supported command.

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
Shell-independent candidate lookup returns raw selectors. Every adapter
transports them with NUL separators and inserts them literally, including spaces
and shell metacharacters, without evaluating candidate text. Bash parses its
command line for Readline; Zsh passes its native parsed words and lets `compadd`
quote insertion. Fish feeds native tokenized arguments to the same candidate
service and uses native literal insertion. Fish omits tab-containing selectors
because its completion API treats tabs as description separators; it must never
offer a truncated path. See [shell completion](completion.md) for activation,
this Fish limitation, and the actually verified Linux shell environments.

## Arena creation (post-1.0, TIM-20)

`timber arena new <name-or-ticket>` prepares at least two fresh attempts from one pinned
commit and identical immutable task instructions, then launches agents sequentially
in the invoking terminal. This enhancement does not block stable release;
resume and pick are specified below.

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
process killing. Resume and pick are specified below.

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
explicitly rerun hooks with --setup. Use arena resume below to relaunch the recorded
tool/preset with its task snapshot. Ordinary open --agent uses ordinary config, not
the arena preset. No automatic winner, merge, publish, cleanup, or unrelated process kill.

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

Apps list arenas, read each attempt's exact agent command, and read `arena new`
and `arena pick` outcomes through the
[arena machine interface](ide-contract.md#arenas-for-app-consumers-experimental-v1).
`arena new --result-file` requires `--no-editor --no-agent`.


## Arena resume (TIM-21)

`timber arena resume <name> [--attempt <label>] [--setup] [--no-agent]
[--editor | --no-editor]` revisits one recorded attempt. Names use the existing exact
arena-name validation. `--attempt` is an exact recorded label, not a fuzzy query,
branch/path selector, ticket resolver, or numeric index. Without it, an interactive
chooser presents recorded labels, tools, stages, branches and paths using stable UUID
values. Reject unoffered values; cancellation prints `Cancelled.`, returns zero,
and does not acquire a lock or write records. Without a chooser require `--attempt`,
show at most five sorted labels plus total count, and never prompt.

Discover the current repository and read the existing private record/task. Use the
same primary configuration scopes and validate both independently. Resume never
fetches refs, resolves a replacement base, creates/binds/recreates worktrees or
branches, resets evolved HEAD, cleans files, or changes another attempt. Preserve
committed, modified, untracked and ignored work. External trusted hooks/agents may
intentionally change work; Timber does not roll back those side effects.

Resume explicitly launches the assigned native/wrapper participant independently of
ordinary agent.enabled unless `--no-agent`. Require interactive stdin/stdout and CI
off before record updates for agent launch. Unattended use requires exact selection
and `--no-agent`; manual attempts have no agent/TTY requirement. Editor settings and
explicit overrides follow arena new. Setup precedes editor startup, which precedes
one awaited foreground agent with existing stdio/signals/status handling. TIM-27
editor-owned agent terminals remain specific to ordinary new/open.

Reconstruct the participant without catalog discovery or fuzzy matching. V2 built-ins
use recorded exact tool/model/optional requested effort; preset and ordinary sources
must reconstruct from the original configuration reference and match the fingerprint
of tool/executable/resolved literal arguments. Replay only recorded invocation effort
when it was added to a preset with no configured effort. Verify recorded model/effort
consistency and fingerprint; never silently substitute a missing/changed definition.
V1 uses recorded references/tool and exact fingerprint proof without inventing source,
model or effort fields. Missing optional historical values stay absent/unknown.
If exact reconstruction cannot be proven, explain original-configuration restoration
or workspace revisit with `--no-agent`. Check required executable availability before
updates. `--no-agent` does not require participant recovery, but malformed existing
repository/global configuration remains an error. External profiles, provider defaults,
PATH binary identities and tool versions are not frozen by a command fingerprint.

Keep the original task path/bytes/digest and native file-read instruction or wrapper
TIMBER_TASK_FILE handoff. Set the established arena/attempt/repository/worktree/branch
agent environment; clear inherited TIMBER_WORKFLOW and TIMBER_TASK_ID. Synchronize
explicit recorded Claude effort with its child environment. Historical inherited-effort
observations are never replayed as overrides; requested effort does not confirm
runtime effort. Do not log task body, raw argv, configuration values or raw launch
exceptions. Hook/agent output keeps its existing stream behavior.

Setup retry is explicit: `created`, `setup-running`, or `failed/setup` requires
`--setup` before an agent starts. `--setup` reruns all current ordinary post_create
hooks from the beginning once, even after prior success; no workflow hooks are
introduced. Never infer a partially executed hook is safe to replay. Without setup,
`--no-agent` may revisit these stages without changing lifecycle history. A revisit
without setup or agent preserves existing stage/exit/signal fields on editor success
and failure. Manual revisit follows the same rule. Unbound/planned or failed-creation
attempts cannot be adopted. `launch-running` and failed stages without a classified
cause, or non-failed stages carrying a contradictory failedStage, refuse external
actions pending inspection and explicit repair.

Read/select before acquiring a lock. Exclusively create a fresh active.lock only in
an existing private arena directory, then reread schema/repository/task and compare
the entire manifest with the selection snapshot. Changed records fail without
replaying work; release only the newly owned lock. Never reuse creation reservation,
replace arena/run UUIDs, overwrite task/markers, steal/clear an existing lock, or
perform automatic interrupted-stage repair. Updates use existing atomic manifest
publication and preserve V1/V2 versions and unrelated attempts. Persist setup/launch
intent before actions and actual outcomes after; stop later actions if publication
fails. Verify lock ownership before saves, task checks and release. Lock initialization
errors distinguish an existing lock from permission/capacity/I/O failures. If token
write, sync or close fails after creation, remove only the same owned file, verified
by filesystem identity; never remove a replacement lock. Failed/unverifiable cleanup
retains the lock and requires inspection, with the storage failure still reported.

Immediately before each setup/editor/agent boundary validate repository, absolute
path, branch, administrative Git directory and reciprocal UUID membership against
Git, then verify task integrity. Repeat after awaited setup/editor operations; evolved
commits/dirty files do not invalidate membership. Missing, stale, replaced or unbound
identities fail with inspection guidance and no recreation. Persist actual exits and
signals, including 130/143, and retain work on every failure. Diagnose affected attempt,
failed stage and a safely renderable exact resume retry; setup failures include
--setup. Retry hints preserve explicit --no-agent and editor enable/disable choices.
If saving a failed outcome also fails, retain the original failure detail and report
that additional metadata failure separately. Successful/skipped editor completion
is revalidated, including editor-only visits. Before an agent launch, persist ready
after editor completion, then persist a separate launch-running agent intent. Lock/uncertain metadata failures require inspection rather than automatic
retry. Do not detach agents, run concurrent attempts, manage unrelated processes,
merge, publish, compare, pick, or clean up.

Resume guarantees workspace continuation for valid retained identities, not universal
agent conversation restoration. No native resume flags/session IDs are inferred.
Only explicit tool/wrapper support may restore a conversation. Exit zero never proves
quality, integration, or a winning attempt.

## Arena pick (TIM-22)

Status: incomplete beta under active testing, not a finished stable feature.
Display this status in command help and invocation output. Interface and behavior
may change before stable release; the preservation rules below are enforced now.

`timber arena pick <name> [--inspect | --winner <label>] [--keep-branch] [--keep-ignored]`
compares recorded attempts, records an explicit human winner, and removes the
other attempts after archiving their work. `--inspect --json` and
`--result-file <path>` give apps the comparison and each attempt's outcome; see
the [arena machine interface](ide-contract.md#arenas-for-app-consumers-experimental-v1).

### Comparison

One line per attempt: label, recorded tool/preset, recorded model and requested
effort when known (never inferred), lifecycle/exit state, and its work: commits
since the pinned base with a diff stat, uncommitted tracked changes (staged and
unstaged together) against HEAD, and the untracked file count. Committed and
uncommitted work are shown separately, so a clean net diff never reads as an
empty attempt. Paths follow on the next line. `--inspect` changes nothing, adds a
safely quoted `git diff <base>` command per attempt and a reopen command, and
cannot be combined with `--winner`. Comparison failures (missing or replaced
identity, unknown status) are shown with their reason. Git runs with argument
arrays, `--no-ext-diff --no-textconv`, and no task or argv output.

### Selection

Without `--winner` an interactive chooser is required; it offers only attempts
whose worktree still exists, keyed by UUID. A second confirmation lists the
winner, the attempts to remove, and the ignored-file and branch policy, with
Cancel as the default. Cancellation changes no files, refs, or records and takes
no lock. `--winner <exact-label>` authorizes selection and cleanup without
prompts; an unknown label is rejected with the valid labels. The winner must be
inactive and pass reciprocal Git/UUID identity validation. Its branch and
workspace are never modified, including local edits. Nothing is merged or pushed.

The winner may be changed by a later pick while it still has a worktree. The
previous winner is then an ordinary loser and is archived before removal.

### Archive before removal

Choosing a winner is not evidence that other attempts are published, so pick
preserves them itself. Before removing a loser, Timber writes a ref
`refs/timber/arena/<name>/<label>` (suffix `-2`, `-3`, ... when taken; existing
refs are never overwritten) pointing at:

- the loser's HEAD when it has no uncommitted or untracked files, or
- a snapshot commit whose parent is HEAD and whose tree holds all tracked and
  untracked, non-ignored files, built with a private temporary index under a
  fixed `Timber` identity. The attempt's own index, files, and refs are untouched.

Ignored files are not archived. They are deleted with the worktree by default;
`--keep-ignored` keeps any attempt that contains them. Local changes inside
submodules cannot be archived and keep the attempt. The archive is recorded in
`pick.json` before removal. Restore with
`git worktree add -b <branch> <path> refs/timber/arena/<name>/<label>`.
Archive refs are never deleted by Timber.

Removal uses ordinary `cleanupWorktree` with the archive step as its discard
authorization: the discard fingerprint is captured before archiving and checked
again immediately before `git worktree remove --force`, so files changed after
archiving (including by hooks) keep the attempt. Deleted-upstream auto-discard is
routed through the same archive step. Hooks, identity, operation and base
protections are unchanged, and ordinary `done` behavior is unchanged. Local loser
branches are deleted with the expected-OID guard; `--keep-branch` keeps them.
Remote branches are never deleted.

### Protection and boundaries

Acquire the existing exclusive arena lock, reread the exact manifest, task, and
pick snapshot, and verify them before every write. Revalidate the winner and each
loser's membership, path, branch, reciprocal identity, and inactive lifecycle
before archiving, before removal (after hooks), and before branch deletion.
Primary, winner, running or interrupted attempts, and unrelated or replaced
worktrees are kept with a reason. Never steal locks or recreate arenas.

### Outcomes and repeat

Each loser prints `Removed`, `Partly removed` (worktree gone, branch kept), or
`Kept` with a reason. Any kept or partial result exits nonzero and prints the
exact rerun command. A repeat reads live Git state: attempts whose worktree is
gone are shown as removed and skipped, and recreated branches or paths are never
adopted or deleted. Original V1/V2 manifests and lifecycle records are never
rewritten; private versioned `pick.json` holds only the winner UUID and archives.

Never kill processes, manage background agents, merge, publish, stash, or reset.
Removal frees disk; RAM is released when agent processes exit, and lifecycle
metadata cannot detect every external process. Concurrent writers to targets
remain outside the guarantee.
