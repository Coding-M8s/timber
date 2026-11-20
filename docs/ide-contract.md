# Experimental IDE machine interface (v1)

This additive interface is experimental. It supports repository inventory,
ordinary New/Open outcomes, Rebase, Publish and PR outcomes, reading, saving and
checking settings for app consumers, reading each worktree's pull request,
reading a worktree's linked issue, listing recovery backups, restoring or
deleting one recovery backup, and listing, launching, creating and picking arenas.
It does not change the existing
human CLI, release version, setup/provider/workflow behavior, or platform promises.
No IDE consumer is included. Rebase, Publish and PR records, native cleanup approval,
[settings for app consumers](#settings-for-app-consumers-experimental-v1),
[pull requests for app consumers](#pull-requests-for-app-consumers-experimental-v1),
[linked issues for app consumers](#linked-issues-for-app-consumers-experimental-v1),
[backups for app consumers](#backups-for-app-consumers-experimental-v1),
[arenas for app consumers](#arenas-for-app-consumers-experimental-v1), and the
[backup restore](#backup-restore-outcome) and [backup delete](#backup-delete-outcome) outcomes are described below. Linux x86_64 is the tested
initial target. Consumers must check `schemaVersion` and reject unsupported versions.
Within v1, ignore additional object fields; incompatible changes require a new version.

## Invocations and channels

Run the Timber executable with literal argument arrays and a captured repository
cwd. Never parse the human table, derive a worktree path from a ticket, or duplicate
provider/branch resolution.

```sh
timber ls --json
timber backup list --json
timber new 'feature name' --result-file /private/temp/new.json --no-editor --no-agent
timber open 'GH-123' --result-file /private/temp/open.json --no-editor --no-agent
timber open --setup --result-file /private/temp/retry.json --no-editor --no-agent -- '/absolute/worktree path'
timber rebase --result-file /private/temp/rebase.json -- '/absolute/worktree path'
timber publish --result-file /private/temp/publish.json -- '/absolute/worktree path'
timber pr --title 'Add login' --result-file /private/temp/pr.json -- '/absolute/worktree path'
timber backup restore --result-file /private/temp/restore.json -- '<id>' '/absolute/new directory'
timber __app-backup delete --id '<id>' --record-sha256 '<digest>' --result-file /private/temp/delete.json
timber __app-arena list
timber __app-arena launch '<arena>' --attempt '<label>'
timber arena new '<name>' --prompt-file /private/temp/task.txt --tool codex --runs 2 --no-editor --no-agent --result-file /private/temp/arena.json
timber arena pick '<arena>' --inspect --json
timber arena pick '<arena>' --winner '<label>' --result-file /private/temp/pick.json
```

`ls --json` writes exactly one UTF-8 JSON object plus newline to stdout after
command execution, including discovery/configuration/listing failures. Diagnostics
and metadata warnings go to stderr. It suppresses first-use installation guidance
and its marker write. Inventory remains offline, validates ordinary configuration,
and includes manual Git worktrees. Sort primary first, then by registered path.
Unknown status or invalid saved metadata never hides a Git worktree row. Each row
carries its saved `base`; the matching stderr warning for invalid metadata remains.

`new` and `open` accept `--result-file <path>`. Both explicit `--no-editor` and
`--no-agent` are required, even when configuration has no launchers. Positive and
negative launch flags conflict as usual. This prevents configured ordinary,
workflow, and Orca launches. Required setup still runs: ordinary hooks precede
workflow hooks; existing opens rerun them only with `--setup`. Provider resolution,
workflow selection, saved bases and preflight checks retain their ordinary behavior.
A workflow applies only to the invocation that names it with `--workflow`; Timber
does not save it, so it is not part of any record.

`rebase` accepts `--result-file <path>` with the same reservation, write and
failure rules. Rebase launches no editor or agent, so it has no launch flags to
require. See [Rebase outcome](#rebase-outcome).

`publish` accepts `--result-file <path>` under the same rules and also launches
nothing. See [Publish outcome](#publish-outcome).

`pr` accepts `--result-file <path>` under the same rules and launches nothing.
A missing `--title` is reported in the record, not by option parsing. See
[Pull request outcome](#pull-request-outcome).

`backup restore` accepts `--result-file <path>` under the same rules and launches
nothing. The hidden `__app-backup delete` requires it. See
[Backup restore outcome](#backup-restore-outcome) and
[Backup delete outcome](#backup-delete-outcome).

Result-file mode keeps human stdout/stderr and chooser output unchanged. Hook
stdout/stderr keep their ordinary channels and cannot become machine records.
Do not parse either stream as JSON. Hook stdin stays closed as in the ordinary CLI;
this flag does not enable interactive setup scripts. For interactive branch/Jira
selection, invoke through a visible PTY. Without an available chooser, ambiguous
selectors fail with existing exact-selection guidance. No implicit confirmation,
new force flag, or automatic prompt response is introduced.

The destination resolves relative to invoking cwd. Its parent must already exist.
Use a fresh filename in a caller-owned private temporary directory outside the
repository. Before command work, Timber exclusively reserves a new file with mode
0600 on Linux. Existing files, symlinks and unavailable parents fail without
command work. Timber retains the owned descriptor rather than reopening the path;
ordinary hook processes do not inherit it. The result is written and synced after
the handler finishes, then the descriptor closes. Timber detects pathname replacement
before/after writing, refuses a reserved file whose content was modified, preserves
replacements, and fails with reconciliation guidance.
This is a completion record, not a progress stream or crash-atomic transaction.
Do not read until process exit. Do not use an existing output file for a retry.

Help, argument/option parse failures, conflicting launch/workflow flags, missing
explicit suppression, and reservation failure happen before this transport starts:
there is no new result record. `ls --json --help` still prints ordinary help.
A process kill or transport failure can leave an empty/incomplete result file.
Missing, malformed or incomplete JSON is never success, even if the last human line
looks successful. A valid record alone is insufficient: require the matching process
exit code too. Preserve bounded diagnostic output; hooks can print arbitrary private
content, so do not publish raw streams or result files as public logs.

## Version 1 schema

The following TypeScript notation defines the JSON values, not an importable SDK.
All fields are required except the `worktrees` array, which exists only on `ls`,
the `rebase` object, which exists only on `rebase`, the `publish` object, which
exists only on `publish`, the `pr` object, which exists only on `pr`, the `config` object, which exists only on a
[settings apply](#saving-settings), the `backupRestore` object, which exists only on `backup-restore`, and the
`backupDelete` object, which exists only on `backup-delete`, and the `arenaNew` and
`arenaPick` objects, described under [arenas](#arenas-for-app-consumers-experimental-v1).
There are no `undefined` values.

```ts
type RepositoryIdentity = {
  commonGitDir: string;       // canonical absolute common Git directory
  primaryWorktreeRoot: string; // absolute Git-discovered primary root
  currentWorktreeRoot: string; // absolute Git-discovered invoking root
};

type WorktreeRecord = {
  path: string;               // actual absolute Git-registered path, preserved verbatim
  canonicalPath: string | null; // realpath after verified status, otherwise null
  branch: string | null;     // exact local branch name; null for detached HEAD
  head: string | null;       // Git HEAD object ID; null for unborn HEAD
  isPrimary: boolean;
  detached: boolean;         // branch === null
  pathExists: boolean;       // snapshot, not a future existence guarantee
  locked: { reason: string | null } | null;
  prunable: { reason: string | null } | null;
  status:
    | { kind: "known"; modified: string[]; untracked: string[]; ignored: string[] }
    | { kind: "unknown"; reason: string };
  base:                      // saved base this worktree rebases onto and is cleaned up against
    | { kind: "assigned"; ref: string } // canonical refs/remotes/... or refs/heads/...
    | { kind: "unassigned" }
    | { kind: "invalid"; reason: "malformed" | "stale" | "unreadable" };
  issue:                     // tracker issue this worktree was created from or linked to
    | { kind: "linked"; tracker: "github" | "jira" | "linear"; key: string; url: string }
    | { kind: "none" }
    | { kind: "invalid"; reason: "malformed" | "stale" | "unreadable" };
};

type RebaseRecord = {
  result: "rebased" | "up-to-date" | "conflicts" | "refused" | "failed";
  base: string | null;        // canonical base ref that was selected
  baseCommit: string | null;  // pinned commit that was rebased onto
  originalTip: string | null; // branch tip before the rebase
  conflicts: string[];        // worktree-relative unmerged paths; empty unless result is "conflicts"
  baseSaved: boolean;         // this run wrote the saved base association
};

type PublishRecord = {
  result: "published" | "up-to-date" | "refused" | "failed";
  remote: string | null;       // remote the branch is published to
  upstream: string | null;     // upstream as refs/remotes/<remote>/<branch>
  pushedCommit: string | null; // commit now on the remote; null unless published or up-to-date
};

type PullRequestRecord = {
  result: "created" | "exists" | "refused" | "failed";
  number: number | null;   // pull request number on GitHub, or id on Bitbucket
  url: string | null;      // https://github.com/<owner>/<repo>/pull/<number>
                           // or https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>
  base: string | null;     // base branch as the host names it, such as "main"
  published: boolean;      // this run pushed commits to the remote
  reviewers: ReviewerRequestRecord[]; // one per --reviewer; empty unless created or exists
};

type ReviewerRequestRecord = {
  name: string;                 // login, or org/team for a team, as given
  kind: "user" | "team";
  result: "requested" | "failed";
  diagnostic: string | null;    // fixed wording when failed; never GitHub's text
};

type BackupRestoreRecord = {
  result: "restored" | "refused" | "partial";
  id: string | null;          // requested ID once well formed; raw input is never echoed
  worktree: string | null;    // recovery worktree path; null unless restored
  branch: string | null;      // recovery/<id>; null unless restored
  commit: string | null;      // commit the recovery branch points at; null unless restored
  remaining: { worktree: string | null; branch: string | null } | null; // partial only
  cleanup: string[];          // manual commands for what remains; empty unless partial
};

type BackupDeleteRecord = {
  result: "deleted" | "refused" | "partial";
  id: string | null;          // requested ID once well formed; raw input is never echoed
  remaining: {                // partial only, observed after the failure
    directory: string;        // the .deleting-<id> directory
    directoryState: "present" | "removed" | "unknown";
    files: number | null;     // entries left; null unless present and readable
    ref: string;              // refs/timber/backups/<id>
    refState: "present" | "removed" | "unknown";
  } | null;
  cleanup: string[];          // manual commands; empty unless partial
};

type RecordV1 = {
  schemaVersion: 1;
  command: "ls" | "new" | "open" | "done" | "rebase" | "publish" | "pr" | "config" | "backup-restore" | "backup-delete" | "arena-new" | "arena-pick";
  outcome: "succeeded" | "cancelled" | "failed";
  exitCode: number;
  repository: RepositoryIdentity | null;
  worktree: WorktreeRecord | null;
  materialized: boolean;
  diagnostic: string | null;
  worktrees?: WorktreeRecord[]; // always present for ls, including failed ls
  rebase?: RebaseRecord;        // always present for rebase, including refusals
  publish?: PublishRecord;      // always present for publish, including refusals
  pr?: PullRequestRecord;       // always present for pr, including refusals
  config?: ConfigApplyRecord;   // always present for a settings apply
  backupRestore?: BackupRestoreRecord; // always present for backup-restore, including refusals
  backupDelete?: BackupDeleteRecord;   // always present for backup-delete, including refusals
  arenaNew?: ArenaNewReport;    // arena-new, once the arena was reserved
  arenaPick?: ArenaPickReport;  // arena-pick, once a winner was chosen
  setupSkipped?: true;          // new/open: --no-setup skipped configured post_create hooks
};
```

Use `commonGitDir` plus the verified canonical worktree path as identity. Labels and
branches are not identities. Keep `path` for exact CLI selectors. Spaces, newlines
and control characters are JSON-escaped on the wire and decode to literal path
characters. Missing/stale registrations retain the registered absolute path and
have unknown status and null `canonicalPath`; never canonicalize a replacement
symlink into another workspace. `pathExists` can be true even if access/identity
cannot be verified. Status arrays contain worktree-relative Git paths, not rendered
terminal text. Status may become stale immediately. A locked existing worktree can
still open under ordinary Open rules; a missing/unverifiable one fails without
recreation. Listing never implies permission for mutation.

## Saved base

An app can show which base each worktree rebases onto and is cleaned up against
from `base` on every `WorktreeRecord`. Read it from this field; do not parse the
human table.

- `assigned`: `base.ref` is the saved canonical ref exactly as stored, either
  `refs/remotes/<remote>/<branch>` or `refs/heads/<branch>`, not the shortened
  form the human table prints. Timber reads it offline and does not check that
  the ref still exists, so the app should treat it as a saved choice, not as
  proof of a current ref.
- `unassigned`: nothing is saved, as for the primary worktree, worktrees added
  with plain Git, and worktrees opened without a base. Timber does not infer a
  parent, and the app should not guess one.
- `invalid`: saved metadata exists but cannot be used. `malformed` means the
  record or its storage is not in the expected form, `stale` means it does not
  match this worktree's identity (or that identity could not be verified), and
  `unreadable` means it could not be read. The row stays listed and the matching
  warning still goes to stderr. Show the value as unknown, not as unassigned.

Reading this field never fetches, writes files, or changes refs. Ahead or
behind counts against the base and upstream sync state are not part of this
interface; read them from Git.

New, Open and Done records carry the same field on `worktree`. New reports the
base it saved, read before setup hooks run; if saving failed, it reports what was
readable when the worktree was captured. Open never changes a base and reports
the one already saved. Done reports the base of the captured worktree before
deletion.

## Issue link

`issue` on every `WorktreeRecord` names the tracker issue the worktree belongs to.
It was added within schema version 1; a reader that does not know the field can
ignore it.

- `linked`: `tracker` is `github`, `jira` or `linear`. `key` is the GitHub issue
  number as a decimal string, such as `"153"`, or the Jira or Linear key, such as
  `"ENG-12"`. `url` is the `https` issue URL the tracker lookup returned when the
  link was saved. `tracker:key` is a valid `timber open --issue` selector.
- `none`: nothing is saved, as for the primary worktree, worktrees made from a
  branch name or sentence, and worktrees added with plain Git.
- `invalid`: saved metadata exists but cannot be used, with the same reasons as
  `base`. The row stays listed and a warning goes to stderr. Show the link as
  unknown, not as none.

Timber reads this field offline. It never contacts a tracker, so the issue's
current title and state are not part of this field. `new` saves the link when it
creates a worktree from an issue, `open --issue` attaches or replaces it, and
`done` removes it with the worktree. New and Open records report the link read
after the command saved it; Done reports the link of the captured worktree before
deletion.

## Outcomes, exit status and recovery

| Outcome | Process exit | Meaning |
| --- | --- | --- |
| `succeeded` | 0 | Required command work completed. For New/Open, use the actual `worktree.path`. |
| `cancelled` | 0 | Existing interactive chooser cancelled before materialization, without command mutation. |
| `failed` | 1 | Command failed. `diagnostic` contains terminal-safe failure text, not a stable error code. |

Rebase is the exception to the `failed` row: a failed rebase exits with Git's own
status or a signal status (for example 130 or 143), not always 1. `exitCode`
always equals the real process exit code.

`ls` always has `worktree: null`, `materialized: false`, and `worktrees` (empty on
failure before inventory completes). `repository` stays null until discovery and
canonical common-directory identification succeed. New/Open have no `worktrees`.

New/Open capture a worktree when the creation service returns, or when Open selects
an existing worktree, before later metadata/setup. `materialized: true` means this
invocation's creation service returned a verified worktree. `false` means creation
was not confirmed by that service; it does not prove nothing was created. Git can
succeed before verification fails. A null target never licenses automatic retry.
The record contains observed state, not a guess from user input or a hook output line.

An existing Open returns `materialized: false`. Failed base metadata or
setup after verified creation returns `failed`, exit 1, `materialized: true` and the
actual target. Existing-worktree setup failure returns the existing target with
`materialized: false`. Completed files, refs and hook side effects remain. Timber
never rolls them back. The worktree snapshot precedes hooks, so a hook/external
writer may change or remove it later; the record is not proof of present existence.
Successful/cancelled records have null `diagnostic`; warnings remain on stderr.

With `--no-setup`, New/Open run no hook. When ordinary or selected workflow hooks
were configured, the record has `setupSkipped: true`, and the caller runs them with
`timber open --setup -- <path>`, repeating `--workflow <name>` when one was given.
Without configured hooks the field is absent.

Publication/close failures return nonzero even if Git/setup completed, and may leave
no usable result. Signal termination follows existing process behavior and need not
produce a record; there is no new cancellation signal protocol or process management.
Chooser cancellation is the only `cancelled` outcome. Never equate an interrupted
process with mutation-free cancellation. Every failed/interrupted/uncertain operation
requires fresh inventory and identity reconciliation before activation or a deliberate
retry. Do not automatically rerun setup or creation. Deliberate recovery uses ordinary
`open` on the exact retained path, adding `--setup` only when the user chooses to
rerun all required steps. The IDE remains responsible for serializing its mutations
and retaining user state; this interface adds no daemon or global registry.

## Rebase outcome

`timber rebase <branch-or-worktree> [--base <ref>] --result-file <path>` lets an
app learn how a rebase ended without reading human output. Target selection, base
selection, fetching, safety checks, human stdout/stderr and exit codes are the
same as without the flag; see the [CLI contract](cli-contract.md). Git hook
output keeps its ordinary handling and never enters the record.

The record has `command: "rebase"`, `materialized: false`, no `worktrees`, and a
`rebase` object whose `result` is the value to branch on:

| `result` | `outcome` | Exit | Meaning |
| --- | --- | --- | --- |
| `rebased` | `succeeded` | 0 | Git replayed the branch onto `baseCommit`. Commit IDs changed. |
| `up-to-date` | `succeeded` | 0 | The branch already contained `baseCommit`. Nothing was rewritten. |
| `conflicts` | `failed` | nonzero | Git paused with unmerged paths, listed in `conflicts`. The paused state is left for the user. |
| `refused` | `failed` | 1 | Timber declined before starting Git's rebase. The branch, files and saved base are unchanged. |
| `failed` | `failed` | nonzero | An operation broke: remote discovery or fetch, Git itself, a Git hook, an interruption, or saving the base. |

- `refused` covers selection and safety stops: no matching, an ambiguous, or an
  unregistered target; a detached, missing, locked or unverifiable worktree;
  modified or untracked files; an operation already in progress; an unusable
  base; and ignored files the rebase could overwrite. `diagnostic` says which.
- `failed` before Git's rebase starts (discovery or fetch) leaves the branch and
  files as they were; fetch metadata may have changed. A hook rejection or an
  interruption normally leaves the branch at `originalTip`, but the app should
  confirm that with Git instead of assuming it.
- `failed` with a non-null `baseCommit` and `baseSaved: false` can also mean the
  rebase itself finished and only saving the base failed. `diagnostic` says so,
  and the branch was rewritten. Timber never resets or aborts in response.

`base`, `baseCommit` and `originalTip` hold what this run verified before it
stopped, so each is null when the run ended first: a refusal over modified files
has all three null, and a fetch failure has `base` but a null `baseCommit`.
`base` is the canonical ref (`refs/remotes/<remote>/<branch>` or
`refs/heads/<branch>`), not the shortened form in human output.

`conflicts` lists every unmerged path as a worktree-relative Git path, including
binary and add/delete conflicts, with unusual characters JSON-escaped. To finish,
the user resolves and stages them and runs `git rebase --continue` in the
worktree, which can stop again at a later commit, or runs `git rebase --abort`.
Timber has no continue or abort flags, resolves nothing itself, and refuses a new
rebase while one is paused. Later pauses are Git's to report, not this record's.

`baseSaved` is true only when this run wrote the saved base association: after
`rebased`, `up-to-date`, and a verified pause with conflicts. It is false for
every refusal and failure, and for a pause or completion whose save failed. A
later `git rebase --abort` does not restore the previous saved base.

`worktree` is the selected worktree as it was before the rebase, so its `head`
is the old tip and its file status predates Git's work; its `base` is read again
after the rebase and reflects the saved association at exit. `worktree` is null
when no single target was selected. An ambiguous target fails with the existing
exact-selection guidance, even in a terminal: result-file mode never opens a
chooser, so `cancelled` does not occur. Select by exact branch or absolute path.

After any outcome, refresh `ls --json` and read Git state before acting on the
worktree. Never retry automatically after `conflicts` or `failed`. Progress
streaming and automatic conflict resolution are not part of this interface.

## Publish outcome

`timber publish <branch-or-worktree> --result-file <path>` pushes a worktree's
branch, so an app never pushes on its own. Target selection, the push, human
stdout/stderr and exit codes are the same as without the flag; see the
[CLI contract](cli-contract.md#publish-a-worktrees-branch-154). Git's own output
and remote messages stay on stderr and never enter the record.

The record has `command: "publish"`, `materialized: false`, no `worktrees`, and a
`publish` object whose `result` is the value to branch on:

| `result` | `outcome` | Exit | Meaning |
| --- | --- | --- | --- |
| `published` | `succeeded` | 0 | The remote branch was created or fast-forwarded to `pushedCommit`. |
| `up-to-date` | `succeeded` | 0 | The remote branch already was at `pushedCommit`. No commit was pushed. |
| `refused` | `failed` | 1 | Timber declined, or the remote branch has moved on. Nothing was pushed and no local ref changed. |
| `failed` | `failed` | 1 | An operation broke: a missing sign-in, the network, the remote, a Git hook, or Git itself. |

- The branch is pushed under its own name. A branch with an upstream is pushed
  to that upstream's remote. A branch without one is pushed to the configured
  `remote`, or to the only remote, and that becomes its upstream. `up-to-date`
  can therefore still set a missing upstream; it never transfers a commit.
- `refused` covers selection and safety stops: no matching, an ambiguous, or an
  unregistered target; a detached HEAD, an unborn branch, or a missing or
  unverifiable worktree; no usable remote; an upstream that is a local branch or
  has a different name; and a remote branch that has moved on. `diagnostic`
  says which.
- A remote branch has moved on when it holds commits the local branch does not
  contain. That includes a branch that was rebased or amended after it was
  published. Timber never force-pushes, so the user has to integrate or
  force-push with Git. Pushing tags and creating pull requests are not part of
  this command.
- Timber never waits for a password, passphrase or credential prompt, with or
  without a terminal. A remote that needs a sign-in ends as `failed`, and
  `diagnostic` says a sign-in is needed. The user signs in outside Timber (a
  Git credential helper, an SSH agent, or the GitHub CLI) and the app retries
  deliberately.
- `remote` and `upstream` hold what this run selected before it stopped, so
  both are null when the run ended first, as for a detached HEAD. `upstream` is
  the remote-tracking ref name, not the shortened form in human output.
  `pushedCommit` is null for `refused` and `failed`; after `failed`, read the
  remote with Git instead of assuming nothing arrived.

`worktree` is the selected worktree as it was before the push. It is null when
no single target was selected. An ambiguous target fails with the existing
exact-selection guidance, even in a terminal: result-file mode never opens a
chooser, so `cancelled` does not occur. Select by exact branch or absolute path.
Modified and untracked files do not block a publish and are not pushed. Git's
pre-push hook keeps its ordinary behavior, with closed stdin.

## Pull request outcome

`timber pr <branch-or-worktree> --title <text> [--body <text>] [--base <ref>]
[--draft] [--reviewer <login|org/team>]... --result-file <path>` publishes a worktree's branch and opens a GitHub
or Bitbucket Cloud pull request for it, so an app never calls GitHub or
Bitbucket or pushes on its own. Each result means the same on both hosts. Target
selection, publishing, human stdout/stderr and exit codes are the same as without
the flag; see the [CLI contract](cli-contract.md#open-a-pull-request-157).

The record has `command: "pr"`, `materialized: false`, no `worktrees`, no
`publish` object, and a `pr` object whose `result` is the value to branch on:

| `result` | `outcome` | Exit | Meaning |
| --- | --- | --- | --- |
| `created` | `succeeded` | 0 | This run created pull request `number`. |
| `exists` | `succeeded` | 0 | A pull request from the branch into the same base was already open. Nothing was created. |
| `refused` | `failed` | 1 | Timber declined, or publish refused because the remote branch moved on. Nothing was pushed and no local ref changed. |
| `failed` | `failed` | 1 | An operation broke: a missing GitHub or Bitbucket login, a failed publish, the host rejecting the creation, the network, or a timeout. |

- The branch is published first with the rules of
  [Publish outcome](#publish-outcome), including when a pull request is already
  open. `published` is true only when this run pushed commits; it is false for
  an up-to-date branch and for every stop before the push.
- `refused` covers selection and safety stops (as for publish), a missing or
  invalid title, an unassigned, invalid or local-branch saved base, an unusable
  `--base`, a base equal to the branch, a remote that is not on github.com or
  bitbucket.org, base and publish remotes on different hosts, and a remote
  branch that has moved on. Timber's own refusals happen before the
  login is read; a remote that moved on is refused by the push, which pushes
  nothing.
- A missing login is `failed` and stops before the push. On GitHub the user
  signs in with `gh auth login` or sets `GH_TOKEN`; on Bitbucket the user saves
  a login with `timber setup` or sets `BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN`
  ([Bitbucket Cloud](cli-contract.md#bitbucket-cloud-175)). The app retries
  deliberately. Settings for app consumers cannot yet save the Bitbucket login.
- `failed` after the push leaves the branch published: `published` says whether
  this run moved it. A rejected creation (for example no commits between the
  base and the branch, a base branch missing on the host, or drafts unsupported)
  has a fixed `diagnostic` and never the host's own text. A creation timeout may
  have created the pull request; running `pr` again reports it as `exists`.
- `reviewers` lists each `--reviewer` once, in the order given, after the
  pull request is created or found, including on `exists`
  ([Reviewers](cli-contract.md#reviewers-174)). A `failed` entry never turns
  `created` or `exists` into a failed outcome; request that reviewer again or
  on the host. An unusable value, more than 15 reviewers, a team outside the
  base repository's owner, or `--reviewer` on a Bitbucket base is `refused`
  before the login or the push. The list is empty when no pull request was
  created or found.
- `number` and `url` are null unless `result` is `created` or `exists`. `url`
  is built from the validated repository and number. `base` holds the base
  branch this run resolved; it is null when the run ended before a base was
  resolved.

The body mentions the worktree's [issue link](#issue-link), or, when none is
saved, a ticket key at the start of the branch name: `Refs #123` (or
`Refs owner/repo#123` for an issue in another repository) and `Refs ENG-42` for
Jira and Linear, unless the body already mentions it. On Bitbucket a GitHub
issue is mentioned by its `https://github.com/.../issues/<n>` link instead. An
`invalid` link adds no mention. Timber never adds a closing keyword.

`worktree` is the selected worktree as it was before the push. It is null when
no single target was selected. Result-file mode never opens a chooser, so
`cancelled` does not occur. Select by exact branch or absolute path.

## Backup restore outcome

`timber backup restore <id> <destination> --result-file <path>` restores a
backup with the rules of the [CLI contract](cli-contract.md#worktree-recovery-backups-119).
Human stdout/stderr and exit codes are unchanged. The record has
`command: "backup-restore"`, `worktree: null`, `materialized: false`, no
`worktrees`, and a `backupRestore` object whose `result` is the value to branch on:

| `result` | `outcome` | Exit | Meaning |
| --- | --- | --- | --- |
| `restored` | `succeeded` | 0 | The recovery worktree `worktree` on `branch` at `commit` is complete. |
| `refused` | `failed` | 1 | Nothing was created: an invalid or unusable backup, an existing destination or recovery branch, or Git failing before it left anything. |
| `partial` | `failed` | 1 | The restore stopped after Git created something. `remaining` and `cleanup` say what was left. |

- `remaining` is observed after the failure. A path or branch whose existence
  cannot be checked counts as remaining. A remaining recovery worktree is
  incomplete and must not be used. The backup and the source worktree are never
  changed, so after running the `cleanup` commands the same restore can be retried.
  `cleanup` lists commands only for what was observed to remain, to run with the
  repository as working directory; the human text always prints both.
- The recovery worktree is only in `backupRestore.worktree`; the top-level
  `worktree` stays null. Reconcile with `ls --json`.

## Backup delete outcome

`timber __app-backup delete --id <id> --record-sha256 <digest> --result-file <path>`
deletes one backup the person confirmed in the app, with the rules of the
[CLI contract](cli-contract.md#backups-for-app-consumers-168). Show the backup's ID,
branch, creation time, size and the exact command, and pass the `recordSha256`
from the same entry of [`timber backup list --json`](#backups-for-app-consumers-experimental-v1). The record has `command: "backup-delete"`,
`worktree: null`, `materialized: false`, no `worktrees`, and a `backupDelete`
object:

| `result` | `outcome` | Exit | Meaning |
| --- | --- | --- | --- |
| `deleted` | `succeeded` | 0 | The snapshot directory, private ref and record are gone. |
| `refused` | `failed` | 1 | Timber kept the backup and changed nothing. `diagnostic` says why. |
| `partial` | `failed` | 1 | Deletion started and did not finish. The backup is no longer listed as usable or restorable with `backup restore`. |

- `refused` covers an unknown ID, an unusable, linked or substituted entry, a
  protected backup, a record that differs from the digest, more than one entry
  with that ID, and every change found by the rechecks during deletion. After a
  refusal read the backup list again before offering the action.
- After `partial`, `remaining` holds the observed state and `cleanup` the
  manual commands: `git update-ref -d <ref>` while the private ref remains and
  `rm -r` while the directory remains. Running the same `__app-backup delete`
  again finishes the unfinished deletion, as `backup done` does, when its
  contents are a state Timber's deletion order can leave. Prefer that rerun: it
  repeats the protection and ref checks, while the `cleanup` commands are a
  manual fallback that delete whatever remains without them. Missing options and an unknown action fail before a result
  file is created.

## Native cleanup approval (experimental v1)

`timber __ide-done preview [--keep-branch] [--keep-ignored] [--base <ref>] -- <absolute-registered-path>` writes one JSON preview to stdout without hooks or deletion. It includes `schemaVersion: 1`, `repository`, `worktree`, normalized `options`, `snapshot` and `expiresAt` (Unix milliseconds, ten minutes). The consumer must show the exact target, loss of modified/untracked and ignored content, local branch effect, and unchanged remote refs before its single Remove confirmation. Unsaved editors and live sessions require independent IDE handling. `--keep-ignored` refuses while ignored content exists; it does not copy files.

After that confirmation, save the unchanged preview into a private temporary file and invoke `timber __ide-done apply --approval-file <path> --result-file <new-path> -- <same-absolute-path>`. Apply never asks a terminal question. It validates preview expiry, repository, reciprocal target identity, root inode, HEAD/branch, base, options, hooks and changed-file/index content before entering cleanup, and again at cleanup's ordinary discard decision. The native snapshot is checked unconditionally again immediately before Git removal, including after cleanup hooks. When discarding ignored files, approval covers all ignored paths and bytes, including ignored runtime files changed by cleanup hooks; those bytes are deliberately excluded from the changed-file fingerprint, matching ordinary Done semantics. The UI must explicitly describe this scope. Existing post-hook checks and primary, operation, ignored-file and ref protections remain. A changed snapshot is an error requiring an updated preview; it never silently broadens approval or retries. Approval is scoped to one target state, not a general noninteractive force flag.

Result files use the existing v1 mutation envelope with `command: "done"`, the captured pre-deletion worktree, and `materialized: false`. Failures may occur after folder removal but before branch removal; consumers must reconcile `ls --json` after every outcome and must never infer current availability from the captured result. Hooks retain normal IO; no prompt parser or automatic terminal answer is involved. Existing interactive `done` behavior is unchanged.

## Settings for app consumers (experimental v1)

An app's settings screen can read, save and check Timber settings through three
hidden commands, without a terminal and with `CI` set. They use the same
validation, publication, Git exclusion handling and private credential stores as
`timber setup`, so the app does not parse or write TOML itself. None of them
launches a tool, runs a hook, creates a worktree, fetches, or changes a ref.

```sh
timber __app-config read --scope repository
timber __app-config apply --scope repository --input-file /private/temp/draft.json --result-file /private/temp/saved.json
timber __app-config check jira --input-file /private/temp/draft.json
```

`--scope` is `repository` (the `.timber.toml` in the primary checkout of the
repository containing the captured cwd) or `global` (machine defaults, which
need no repository). Unknown actions, scopes, integrations and option
combinations fail before any work with a plain diagnostic on stderr and exit 1.
Settings keep their TOML names and shapes, as in the [guide](guide.md); this
interface adds no setting and does not change the file format.

### Reading settings

`read` prints one JSON object plus newline to stdout and exits 0. On failure
(not a repository, unreadable or invalid file) stdout stays empty, the
diagnostic goes to stderr, and the exit code is 1. Reading is offline and writes
nothing.

```ts
type SettingsRead = {
  schemaVersion: 1;
  scope: "repository" | "global";
  path: string;            // absolute file an apply to this scope writes
  exists: boolean;
  tracked: boolean;        // repository file is tracked by Git; see --edit-tracked
  revision: string | null; // opaque token for the content read; null when absent
  values: Settings;        // what this scope's file sets, with defaults filled in
  effective: Settings;     // what applies after inheritance
  credentials: {
    jira: { configured: boolean; state: CredentialState; environmentOverride: boolean };
    linear: { state: CredentialState; environmentOverride: boolean };
  };
};
type CredentialState = "saved" | "none" | "unreadable";
```

- `values` can contain `false`, which switches an inherited table off for this
  repository. `effective` never does: repository keys replace machine defaults,
  workflow and arena tables merge by name, and everything switched off is
  left out. For the global scope, `effective` is the machine defaults alone.
  A relative `worktree_dir` is reported as written.
- `credentials` says only whether something is saved. `jira.state` refers to the
  pair saved for the effective Jira site and token mode; `configured` is false
  when no Jira site applies. `unreadable` means the private store exists but
  failed its ownership, permission or format checks. `environmentOverride` is
  true when `JIRA_EMAIL`/`JIRA_API_TOKEN` or `LINEAR_API_KEY` is set for the
  process, because those replace saved credentials at run time. No email, token
  or key is ever part of this object. Timber stores no GitHub token.

### Saving settings

`apply` reads a draft from `--input-file` and writes its outcome to a new
`--result-file`, with the same reservation, write and failure rules as the other
result files. Human stdout and stderr stay human text; do not parse them.

```ts
type SettingsInput = {
  schemaVersion: 1;
  revision: string | null;   // from the read this draft is based on
  values: Settings;          // the complete draft for this scope
  credentials?: {            // omit a provider to leave its saved login alone
    jira?: { email: string; token: string } | null;   // null removes the saved pair
    linear?: { token: string } | null;                // null removes the saved key
  };
};

type ConfigApplyRecord = {
  result: "saved" | "invalid" | "conflict" | "refused" | "failed";
  scope: "repository" | "global";
  path: string | null;       // destination; null when the run stopped before finding it
  revision: string | null;   // revision of the saved content; null unless "saved"
  invalidFields: string[];   // for example "editor.command is invalid"
  credentials: { jira: CredentialChange; linear: CredentialChange };
};
type CredentialChange = "saved" | "removed" | "unchanged";
```

The record is the v1 envelope with `command: "config"`, `worktree: null`,
`materialized: false`, and `repository` set for the repository scope once
discovery succeeds. Branch on `config.result`:

| `result` | `outcome` | Exit | Meaning |
| --- | --- | --- | --- |
| `saved` | `succeeded` | 0 | The file holds exactly what `timber setup` would write for these values. |
| `invalid` | `failed` | 1 | The input or a value was rejected. `invalidFields` names each field. |
| `conflict` | `failed` | 1 | The file, its Git state or a credential store changed since the read. |
| `refused` | `failed` | 1 | A question setup would ask was not answered by an option. |
| `failed` | `failed` | 1 | Something else stopped the save, such as a held lock or a write error. |

- `values` is the whole scope: a setting left out is removed from this file and
  inherits again. The exceptions are `workflows` and `arena`, which this
  interface does not edit. They are carried over from the saved file; a draft
  may omit them or repeat them unchanged, and a draft that changes them is
  `invalid`. Comments in a hand-written file are not kept, as with setup.
- `invalidFields` and `diagnostic` name fields and never repeat a value. With
  any result other than `saved`, the settings file, the Git exclusion file and
  the credential stores are as they were, unless `diagnostic` reports an
  incomplete rollback.
- Pass the `revision` from `read`. Timber refuses with `conflict` when the file
  no longer matches it, and checks again under its lock immediately before
  publishing. After `conflict`, read again and let the user reapply. After
  `saved`, `config.revision` is the next revision, so the app can keep editing.
- A tracked `.timber.toml` is `refused` unless `--edit-tracked` is passed, which
  edits the working file and leaves the index alone. A repository whose ignore
  rules cannot hide `.timber.toml` is `refused`; offer the global scope instead.
  There is no option that answers every question at once.
- Publication is atomic per file. Credentials are published first and rolled
  back if the settings file cannot be published.

### Credentials

Credentials travel only inside the input file, never in arguments. Create that
file in a caller-owned private directory outside the repository, and delete it
after the process exits; Timber reads it once and never modifies or removes it. On Linux
and macOS a file carrying `credentials` must be owned by the invoking user with
mode 0600, or the command fails before using it. Symlinks and files over 1 MiB
are refused.

Saved credentials follow the existing store rules: plaintext, private to the
user, outside every Git worktree, shared across repositories, and keyed for
Jira by site and token mode. Jira credentials need a Jira site in the draft or
inherited from machine defaults. Credential values never appear in result
files, stdout, stderr or diagnostics, and `read` never returns them, so an app
cannot prefill a saved token.

### Checking a connection

`check <github|linear|jira> [--scope <scope>] [--input-file <path>]` makes the
same single read-only current-user request as setup and prints one JSON object
plus newline to stdout. It exits 0 when `ok` is true and 1 otherwise. It saves
nothing, with or without a draft.

```ts
type ConnectionCheck = {
  schemaVersion: 1;
  integration: "github" | "linear" | "jira";
  ok: boolean;
  source: "draft" | "saved" | "environment" | "github-cli" | null;
  account: string | null;    // GitHub login on success; otherwise null
  diagnostic: string | null; // terminal-safe failure text, not a stable code
};
```

- With `--input-file`, the draft's `credentials` are checked when it carries
  them (`source: "draft"`), and for Jira the draft's site is used. `revision`
  is not needed for a check.
- Otherwise the check uses what Timber commands would use: the environment
  override when set (`environment`), else the saved credentials (`saved`).
  Sources are never mixed, so a blank or partial override fails as it does at
  run time.
- GitHub uses the GitHub CLI login or `GH_TOKEN`/`GITHUB_TOKEN`; a draft does
  not affect it, and sign-in is not part of this interface.
- For Jira, `--scope` chooses whose settings supply the site. Without it,
  Timber uses the repository containing the cwd, or machine defaults outside one.
- `source` is null when the check stopped before choosing a login, for example
  an unreadable input file, an invalid draft, or no configured Jira site.
- Success means the login was accepted. Project, team, repository and issue
  access are not checked. A failure is a result, not a crash: rejected logins,
  denied access, rate limits, timeouts (10 seconds) and network errors all
  return `ok: false` with a diagnostic that contains no credential.

## Pull requests for app consumers (experimental v1)

An app can show each worktree's GitHub pull request, its checks, its review
decision and its reviewers with one hidden, read-only command run in any
worktree of the repository:

```sh
timber __app-pr
```

It takes no arguments. It prints one JSON object plus newline to stdout and
exits 0, or 1 when the repository could not be read or any lookup failed; the
record is printed in both cases. It never prompts (run it with stdin closed),
never writes files, never fetches or changes a ref, and never acts on a pull
request. One call answers for every worktree, so an app can refresh on an
interval. The network part, reading the login and every GitHub request
together, stops after 15 seconds.

```ts
type PullRequestsRecord = {
  schemaVersion: 1;
  repository: RepositoryIdentity | null; // null when discovery failed
  github: { owner: string; name: string } | null; // repository the pull requests were read from
  diagnostic: string | null;  // set only when the repository or its worktrees could not be read
  worktrees: PullRequestEntry[]; // primary first, then by registered path; empty when diagnostic is set
};

type PullRequestEntry = {
  path: string;               // Git-registered worktree path, as in ls --json
  branch: string | null;      // null for detached HEAD
  isPrimary: boolean;
  outcome: "found" | "none" | "failed";
  pullRequest: PullRequest | null; // non-null only when found
  reason: "offline" | "sign-in-needed" | "not-github" | "failed" | null; // non-null only when failed
  diagnostic: string | null;  // terminal-safe failure text, not a stable code; non-null only when failed
};

type PullRequest = {
  number: number;
  url: string;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  baseBranch: string;         // branch name on GitHub, not a local ref
  checks: {
    summary: "passing" | "failing" | "pending" | "none";
    runs: { name: string; status: "passing" | "failing" | "pending" | "skipped"; url: string | null }[];
  };
  review: "approved" | "changes-requested" | "review-required" | "none";
  reviewers: Reviewer[];      // requested reviewers first, then people who reviewed, in GitHub's order
  reviewersComplete: boolean; // false when some reviewers could not be read
  description: string;        // the pull request body as written; may be empty
};

type Reviewer = {
  kind: "user" | "team" | "bot";
  name: string;               // login, or "org/team-slug" for a team
  state: "requested" | "approved" | "changes-requested" | "commented" | "dismissed";
  url: string | null;         // https link to the profile or team, when GitHub gives one
};
```

- The pull requests are read from the github.com repository of the configured
  `remote`, or `origin` when none is configured. When that remote is missing or
  not on github.com, every entry with a branch is `failed` with `not-github`,
  and Timber reads no login and contacts nothing.
- A branch's pull request is one whose head is that branch on GitHub: the
  branch's upstream when it tracks a github.com remote (so a branch pushed to a
  fork is found under the fork's owner and upstream branch name), otherwise the
  same branch name in the selected repository. Among the ten most recently
  created pull requests for that branch name, an open one wins; otherwise the
  newest is reported. A pull request from
  another owner's branch of the same name is not matched.
- `none` means no pull request was found, and is always the outcome for a
  detached worktree. It does not mean the branch was pushed.
- `checks.summary` is GitHub's combined state for the head commit; `none`
  means no checks or statuses were reported. `runs` lists at most 100 check
  runs and commit statuses. A neutral conclusion counts as passing; cancelled,
  timed out and other unsuccessful conclusions count as failing.
- `review` is GitHub's review decision; `none` means the repository requires
  no review decision for this pull request.
- `reviewers` lists each reviewer once. `requested` means a review was
  requested and the reviewer has not submitted one since, including a
  reviewer asked again after reviewing; a team can only be `requested`. For
  everyone else `state` is their latest submitted review, except that a later
  comment never hides an earlier approval or request for changes, which is how
  GitHub works out the decision. Draft reviews and reviews by deleted accounts
  are not listed. Bots that review, such as Copilot or Dependabot, have
  `kind: "bot"`. With no requests and no reviews the list is empty and
  `reviewersComplete` is true.
- `reviewersComplete` is false when GitHub did not let the login read some
  reviewers, such as a requested team it cannot see or a login without
  `read:org`, or when a pull request has more than 100 review requests or
  reviews. The reviewers Timber could read are still listed and the lookup
  does not fail. If GitHub refuses the whole query for naming team fields,
  Timber asks once more without them, within the same time limit.
- A failure applies to every entry with a branch, since one lookup answers for
  all of them. `sign-in-needed` means no usable login or a rejected one;
  `offline` means GitHub could not be reached or did not answer within the time
  limit; `failed` covers denied access, rate limits, a missing or inaccessible
  repository and invalid responses. Retry on the next refresh; Timber never
  retries on its own.
- The login is the one `timber new github:<n>` uses: `GH_TOKEN` or
  `GITHUB_TOKEN` when set, otherwise the GitHub CLI login for github.com. The
  app needs no separate sign-in, and sign-in is not part of this interface.
  Tokens never appear in stdout, stderr or diagnostics.
- Titles, descriptions and reviewer names are text from GitHub. Display them as
  untrusted text; do not render them as trusted markup or pass them to a shell.

Other hosts, review comments and pull request actions are not part of this
interface.

## Linked issues for app consumers (experimental v1)

An app can show the current state of the issue a worktree belongs to with one
hidden, read-only command run in any worktree of the repository:

```sh
timber __app-issue -- '/absolute/worktree path'
timber __app-issue feature/login
```

The argument is an absolute registered worktree path or an exact branch name
checked out in a worktree; there is no fuzzy matching and no chooser. The issue is
the [saved issue link](#issue-link) (`issue` in `ls --json`). Timber prints one
JSON object plus newline to stdout and exits 0 when the outcome is `found` or
`none`, or 1 when it is `failed`; the record is printed in both cases. It never
prompts (run it with stdin closed), never writes files, never fetches or changes
a ref, and never changes the issue. The network part, reading the login and the
tracker request together, stops after 15 seconds.

```ts
type IssueRecord = {
  schemaVersion: 1;
  repository: RepositoryIdentity | null; // null when discovery failed
  worktree: { path: string; branch: string | null; isPrimary: boolean } | null; // null when nothing matched
  outcome: "found" | "none" | "failed";
  issue: Issue | null;        // non-null only when found
  reason: "offline" | "sign-in-needed" | "not-found" | "forbidden" | "failed" | null; // non-null only when failed
  diagnostic: string | null;  // terminal-safe failure text, not a stable code; non-null only when failed
};

type Issue = {
  tracker: "github" | "jira" | "linear";
  key: string;                // as saved in the link: the GitHub number or the Jira/Linear key
  url: string;                // as saved in the link
  title: string;
  status: {
    name: string;             // the tracker's own name, such as "In Review"; GitHub reports "Open" or "Closed"
    category: "open" | "in-progress" | "closed";
  };
  assignee: string | null;    // display name; the login for GitHub; null when unassigned
};
```

- `none` means the worktree has no saved link, which is always so for the
  primary worktree. Timber then reads no login and contacts nothing.
- `category` comes from the tracker's own grouping. Jira: To Do is `open`, In
  Progress is `in-progress`, Done is `closed`. Linear: triage, backlog and
  unstarted are `open`, started is `in-progress`, completed, canceled and
  duplicate are `closed`. GitHub issues are only `open` or `closed`.
- A GitHub issue is read from the repository in its saved URL, not from the
  current remote. A Jira issue is read from the configured `[jira]` site, and
  only when the saved URL is on that same site. A Linear issue is read by key.
- `sign-in-needed` means no usable login, a rejected one, or, for Jira, no
  configured site. `offline` means the tracker could not be reached or did not
  answer within the time limit. `not-found` means the tracker has no such issue
  or hides it from this login, including a deleted Linear issue. `forbidden`
  means the login is known but may not read the issue. `failed` covers rate
  limits, redirects, invalid responses, an unreadable repository, a target that
  names no registered worktree, damaged link metadata (as `invalid` in
  `ls --json`), and a Jira link on a site other than the configured one.
  Retry on the next refresh; Timber never retries on its own.
- The login is the one `timber new` uses for that tracker: for GitHub,
  `GH_TOKEN` or `GITHUB_TOKEN` when set, otherwise the GitHub CLI login for
  github.com; for Jira, `JIRA_EMAIL` and `JIRA_API_TOKEN` when set, otherwise the
  saved pair for the site; for Linear, `LINEAR_API_KEY` when set, otherwise the
  saved key. The app never reads a login itself, and sign-in is not part of this
  interface. Tokens never appear in stdout, stderr or diagnostics.
- Titles, status names and assignee names are text from the tracker. Display
  them as untrusted text; do not render them as trusted markup or pass them to a
  shell.

Editing issues, transitions and comments are not part of this interface. To
list issues that are not linked, use [`__app-issues`](#issue-lists-for-app-consumers-experimental-v1).

## Issue lists for app consumers (experimental v1)

`timber __app-issues` lists issues from one tracker for an issues board or for
suggestions while typing a worktree name. It uses Timber's own tracker login,
so the app never holds a token.

```sh
timber __app-issues sprint   [--tracker github|jira|linear]
timber __app-issues assigned [--tracker github|jira|linear] [--limit <1-100>]
timber __app-issues open     [--tracker github|jira|linear] [--limit <1-100>]
timber __app-issues search    --tracker github|jira|linear  [--limit <1-100>] -- '<text>'
```

Without `--tracker`, `sprint`, `assigned` and `open` use the repository's
`default_tracker`. `search` always names its tracker, so it does not depend on
the default. The search text is one argument of at most 200 characters, after
`--`. `--limit` defaults to 50, or 10 for `search`; a sprint is listed whole, up
to 500 issues. Timber prints one JSON object plus newline to stdout and exits 0
when the outcome is `found` or `none`, or 1 when it is `failed`; the record is
printed in both cases. It never prompts (run it with stdin closed), never writes
files, never fetches or changes a ref, and never changes an issue. The network
part, reading the login and every tracker request together, stops after 15
seconds.

```ts
type IssueListRecord = {
  schemaVersion: 1;
  repository: RepositoryIdentity | null; // null when discovery failed
  query: "sprint" | "assigned" | "open" | "search" | null; // null for an unknown query
  tracker: "github" | "jira" | "linear" | null; // null when none was named or configured
  outcome: "found" | "none" | "failed";
  sprint: {                    // non-null only for a found sprint
    name: string | null;       // the sprint, iteration, milestone or cycle; null for sprint_jql
    source: "jira-board" | "jira-jql" | "github-iteration" | "github-milestone" | "linear-cycle";
  } | null;
  issues: ListedIssue[];       // empty unless found
  truncated: boolean;          // the tracker had more matching issues than the record holds
  reason: "offline" | "sign-in-needed" | "not-configured" | "not-found" | "forbidden" | "failed" | null;
  diagnostic: string | null;   // terminal-safe failure text, not a stable code; non-null only when failed
};

type ListedIssue = Issue & {   // Issue as in __app-issue
  worktree: { path: string; branch: string | null } | null; // the worktree linked to this issue, if any
};
```

Each list reads:

| Query | GitHub | Jira | Linear |
| --- | --- | --- | --- |
| `sprint` | The current iteration of `[github].project`, or open issues in the open milestone `[github].milestone` | The active sprints of `[jira].board`, or the issues `[jira].sprint_jql` matches | The active cycle of `[linear].team` |
| `assigned` | Open issues in the selected remote's repository assigned to the login, recently updated first | Issues assigned to the login and not done, in `[jira].project` when set, recently updated first | Issues assigned to the login and not closed, in `[linear].team` when set, recently updated first |
| `open` | Open issues in the selected remote's repository, newest first | Issues in `[jira].project` that are not done, newest first | Issues in `[linear].team` that are not closed, newest first |
| `search` | Issue `12` in any state for `12` or `#12`, then open issues whose number starts with `12`, then open issues whose titles contain every word, also as part of a word | Jira's issue picker, which matches key prefixes such as `ENG-4` and title words; an exact key comes first | The exact key, then Linear's issue search |

Settings live in the repository's `.timber.toml`, beside the existing `[jira]`
site:

```toml
[jira]
site_url = "https://example.atlassian.net"
board = 12          # a Scrum board; or sprint_jql = "...", not both
project = "ENG"     # needed for open; narrows assigned and search

[github]
project = "my-org/5"   # "<owner>/<number>" of a Projects board with an iteration field
milestone = "v1.2"     # used for sprint only when project is unset

[linear]
team = "ENG"           # needed for sprint and open; narrows assigned and search
```

- `none` means the sprint is configured but nothing is current: no active Jira
  sprint, no GitHub iteration whose dates include today, or no active Linear
  cycle. Show it as "no current sprint".
- `not-configured` means a setting the list needs is missing, there is no
  tracker to use, a Jira board does not use sprints, or a GitHub project has
  no iteration field. Timber reads no login and contacts nothing when a
  setting is missing. Hide the list or show a quiet reason.
- `not-found` means the configured board, project, milestone or team does not
  exist or is hidden from this login.
- `sign-in-needed`, `offline`, `forbidden` and `failed` mean what they mean for
  `__app-issue`, with the same logins. A GitHub project also needs
  the `read:project` scope; without it the reason is `forbidden`. `failed`
  also covers invalid input, such as an unknown query or tracker, a bad
  `--limit`, text for a list other than `search`, and a GitHub list whose
  selected remote is not on github.com.
- `worktree` is set when a registered worktree's saved issue link names the
  same issue: the same repository and number for GitHub, the same site and key
  for Jira, the same key for Linear. Invalid or stale links count as no link.
- GitHub lists skip pull requests. A GitHub project can hold issues from
  several repositories; each issue's `url` says which.
- A GitHub search reads the 300 most recently updated open issues of the
  selected remote's repository and matches them locally, so it never uses the
  rate-limited Search API. `truncated` is true when the repository has more
  open issues than that, since older ones were not searched.
- Typed search text is matched as text, never as tracker query syntax. Quotes,
  colons, brackets and `#` are ignored when matching words.
- Linear lists are implemented against Linear's published schema but have not
  yet been tested against a real Linear workspace; treat them as unverified.
- Titles, status names and assignee names are untrusted text from the tracker,
  as in `__app-issue`.

## Backups for app consumers (experimental v1)

An app can show a repository's recovery backups with one read-only command run
in any worktree of the repository:

```sh
timber backup list --json
```

It prints one `BackupListRecord` (schema version 1) plus newline to stdout and
exits with the record's `exitCode`: 0, or 1 when the repository or its backup
storage could not be read. The record is printed in both cases and stderr stays
empty. It never prompts, never writes files, never changes a ref or backup
storage, and contacts nothing. The schema, ordering and failure rules are in the
[CLI contract](cli-contract.md#backup-list-deletion-and-done-lifecycle-120).

- Timber decides which backups are usable and which are protected; the app shows
  `protection` and `notUsable` as given and does not reimplement those rules.
  Protected and unusable entries are never offered by `timber backup done`.
- Exit 0 with entries under `notUsable` or `unfinished` is normal; read each list.
- `expiry` is `null` for records without a retention policy. Otherwise its
  `state` (`kept`, `until-deleted`, `expiring` or `expired`) is evaluated when the
  list is read; show protection alongside it, since a protected expired backup is
  never deleted. See [retention](cli-contract.md#backup-retention-and-storage-warning-121).
- `timber backup keep` and `unkeep` change `recordSha256`; read the list again
  before confirming a deletion.
- To delete a usable backup or finish an unfinished deletion, pass its `id` and
  `recordSha256` to [`__app-backup delete`](#backup-delete-outcome). When an
  unfinished deletion's `recordSha256` is null because its record is gone, the
  ID alone identifies it, but the command still requires a well-formed digest;
  when it is null because the remains cannot be read, the command refuses.
- Backups can contain copies of ignored files, including secrets such as `.env`,
  even after their source worktree is removed. Say so where backups are shown.
- Branches, paths and names are text recorded at backup time or found in
  storage. Display them as untrusted text; do not pass them to a shell.

Creating backups is not part of this interface. Restoring and deleting one
backup have their own records: [backup restore](#backup-restore-outcome) and
[backup delete](#backup-delete-outcome).

## Arenas for app consumers (experimental v1)

An app can run an [arena](cli-contract.md#arena-creation-post-10-tim-20) with these commands: create it
with `arena new --no-agent`, list arenas and their attempts, ask Timber for each
attempt's agent command and start it in its own session, compare the attempts,
and pick a winner. Every record has `schemaVersion: 1`; reject other versions and
ignore unknown fields. Arena commands are beta, as in the CLI.

Task text never appears in these records, their diagnostics, or stdout and
stderr. Pass the task to `arena new` through `--prompt-file` with a private
temporary file, never `--prompt` on a command line. An agent reads the task from
the arena's private snapshot, named by `TIMBER_TASK_FILE` and in its last
argument.

### Listing arenas

`timber __app-arena list` is hidden and read-only. Run it in any worktree of
the repository with stdin closed. It prints one `ArenaListRecord` plus newline
to stdout and exits 0, or 1 when the repository or any arena could not be read;
the record is printed in both cases. It never prompts, takes no lock, writes no
file or record, changes no ref, and contacts nothing. It also reads arenas whose
invocation lock is held.

```ts
type ArenaListRecord = {
  schemaVersion: 1;
  repository: RepositoryIdentity | null; // null when discovery failed
  diagnostic: string | null;  // set only when the repository or arena storage could not be read
  arenas: ArenaEntry[];       // sorted by name; empty when there are none
};

type ArenaEntry = {
  name: string;
  outcome: "read" | "failed"; // failed: this arena's records could not be read
  diagnostic: string | null;  // terminal-safe text, not a stable code; non-null only when failed
  id: string | null;          // the arena's UUID; null when failed, as are the fields below
  base: { ref: string; commit: string } | null; // the pinned base every attempt started from
  createdAt: string | null;   // ISO 8601: when the private task snapshot was written, at creation
  ticket: string | null;      // the ticket key the arena was created for, if any
  active: boolean;            // an arena command holds the lock, or one was interrupted
  winner: string | null;      // the label arena pick recorded, if any
  attempts: ArenaAttempt[];   // in creation order; empty when failed
};

type ArenaAttempt = {
  label: string;              // exact label for launch, resume and pick
  tool: "codex" | "claude" | "cursor" | "wrapper" | "manual";
  preset: string;
  model: string | null;       // recorded model; null when the tool default was used or unknown
  effort: string | null;      // recorded requested effort, not proof of the effective one
  branch: string;
  path: string;
  state: "incomplete" | "prepared" | "setup-failed" | "launched" | "picked" | "archived";
  stage: "planned" | "created" | "setup-running" | "ready" | "launch-running" | "exited" | "failed";
  failedStage: "creation" | "setup" | "editor" | "agent" | null;
  exitCode: number | null;    // last recorded agent exit status
  signal: string | null;
  archive: { ref: string; commit: string; present: boolean } | null; // saved by arena pick
  git: "ok" | "stale" | "missing" | "unknown";
};
```

- `state` is one word to show. `picked` is the recorded winner and `archived`
  an attempt whose work pick saved under `archive.ref`. Otherwise `prepared` is
  set up and ready to launch (including after an editor failed to start),
  `setup-failed` needs setup rerun, `launched` means Timber
  launched its agent (in `arena new` or `arena resume`), and `incomplete`
  covers creation that did not finish and setup that is pending or was
  interrupted. `stage`, `failedStage`, `exitCode` and `signal` are the recorded
  values behind it.
- An agent the app starts from `launch` is not recorded: the attempt stays
  `prepared`. Track that session in the app. `arena pick` only refuses attempts
  Timber recorded as running, so the app must not offer pick while its own
  sessions for that arena run.
- `git` is checked live against Git and the attempt's private identity marker,
  never guessed from branch names or paths. `ok` means Git still has the exact
  worktree Timber created. `missing` means no worktree is at that path any more,
  as after pick removed it. `stale` means something is at that path or on that
  branch, but it is not the worktree Timber created. `unknown` means it could
  not be checked. A branch in the `arena/<name>/` namespace that no record
  names is not listed.
- `archive.present` is false when the archive ref is gone or moved.
- A damaged arena is a failed entry; the other arenas are still listed.

### Launching an attempt's agent

`timber __app-arena launch <arena> --attempt <label>` prints the exact program,
folder and environment that `timber arena resume <arena> --attempt <label>`
would start for that attempt's agent, and runs nothing. It is hidden and
read-only like `list`. Start the agent yourself, in its own terminal session;
never build the command in the app. It prints one record and exits 0 for
`ready` and `no-agent`, or 1 for `failed`.

```ts
type ArenaLaunchRecord = {
  schemaVersion: 1;
  repository: RepositoryIdentity | null;
  arena: string;
  attempt: string | null;
  outcome: "ready" | "no-agent" | "failed"; // no-agent: a manual attempt
  launch: {
    argv: string[];           // argv[0] is the program, found on PATH unless absolute
    cwd: string;              // the attempt's worktree
    environment: Record<string, string>; // set these on top of your own environment
    unset: string[];          // remove these from it
  } | null;                   // non-null only when ready
  diagnostic: string | null;  // non-null only when failed
};
```

- `launch` refuses whatever `arena resume` refuses before starting an agent: an
  unknown label, a held or interrupted lock, an attempt that was not fully
  created, an uncertain or inconsistent stage, incomplete setup, agent
  configuration that is missing or differs from the recorded fingerprint, a
  missing executable, and a worktree whose identity no longer matches. For
  incomplete setup, run the deliberate setup the diagnostic names, then ask
  again. Nothing is substituted.
- The task file path and arena details are in `environment`: `TIMBER_TASK_FILE`,
  `TIMBER_ARENA`, `TIMBER_ATTEMPT`, `TIMBER_REPO`, `TIMBER_WORKTREE` and
  `TIMBER_BRANCH`, plus `CLAUDE_CODE_EFFORT_LEVEL` for a Claude attempt with a
  requested effort. Run the agent with an interactive terminal; the native tools
  are interactive.

### Creating an arena

`timber arena new <name-or-ticket> ... --no-editor --no-agent --result-file <path>`
creates the arena with the [result-file rules](#invocations-and-channels); both
launch flags are required. Without a terminal, give the attempts with
`--tool`/`--runs` or `--preset` and the task with `--prompt-file`. The record has
`command: "arena-new"`, `worktree: null`, `materialized: false`, and, once the
arena was reserved, an `arenaNew` object. Without it, no worktree was created,
though a failed reservation can leave private records that keep the name taken.

```ts
type ArenaNewReport = {
  name: string;
  id: string;
  base: { ref: string; commit: string };
  failure: { stage: "creation" | "setup" | "editor" | "agent"; attempt: string | null } | null;
  attempts: {
    label: string; tool: string; preset: string; model: string | null; effort: string | null;
    branch: string; path: string;
    created: boolean;         // the worktree was created and bound
    stage: string;            // as in ArenaAttempt; ready is the end with --no-agent
    failedStage: string | null;
  }[];
};
```

A failure stops creation where it happened. Completed worktrees and setup are
kept, and `failure` names the stage and attempt. Recover with `arena resume`, as
the human error text says; never rerun creation for the same name.

### Comparing attempts

`timber arena pick <arena> --inspect --json` prints the same comparison as
`--inspect`, as one record on stdout, and changes nothing. It exits 0, or 1 with
`diagnostic` set and no attempts when the arena could not be read. `--json`
requires `--inspect`.

```ts
type ArenaInspectRecord = {
  schemaVersion: 1;
  arena: string;
  base: { ref: string; commit: string } | null;
  winner: string | null;
  diagnostic: string | null;
  attempts: {
    label: string; tool: string; preset: string; model: string | null; effort: string | null;
    branch: string; path: string; state: string; stage: string; // as in ArenaAttempt
    removed: boolean;         // the worktree is gone
    archiveRef: string | null;
    comparison: {
      commits: number;        // commits on HEAD since the base
      committed: { files: number; insertions: number; deletions: number };   // base to HEAD
      uncommitted: { files: number; insertions: number; deletions: number }; // HEAD to working files
      untracked: number;
      ignored: number;
    } | null;                 // null when removed or not comparable
    reason: string | null;    // why it could not be compared
  }[];
};
```

Committed and uncommitted changes are separate because local edits can cancel
committed work. To show the diff, run `git diff <base.commit>` in the attempt's
`path`.

### Picking a winner

`timber arena pick <arena> --winner <label> --result-file <path>` picks with the
[CLI rules](cli-contract.md#arena-pick-tim-22). Show the exact command and what will be
removed first, as `--inspect` does. The record has `command: "arena-pick"`,
`worktree: null`, `materialized: false`, and, once the winner was chosen, an
`arenaPick` object with one entry per attempt:

```ts
type ArenaPickReport = {
  name: string;
  winner: string;
  attempts: {
    label: string;
    outcome: "winner" | "removed" | "archived" | "kept" | "partly-removed" | "already-removed";
    archiveRef: string | null; // refs/timber/arena/<arena>/<label>... holding its work
    reason: string | null;     // terminal-safe text for kept and partly-removed
  }[];
};
```

- `archived`: the work was saved under `archiveRef`, then the worktree removed.
  `removed`: removed without an archive, because it held no unique work.
- `kept`: still there, with Timber's `reason`. Running attempts, ignored files
  with `--keep-ignored`, failed identity checks and archive failures keep an
  attempt. `partly-removed`: the worktree is gone but a later step failed, such
  as deleting the branch. Either one makes the outcome `failed` with exit 1;
  fix the reason and rerun the same command.
- `already-removed`: its worktree was gone before this pick, removed by an
  earlier pick or by hand; `archiveRef` is from an earlier pick, if any.
- An attempt Timber did not reach before an error stays `kept` with a reason
  saying so. `--result-file` cannot be combined with `--inspect`.

Read `__app-arena list` again after every create and pick.
