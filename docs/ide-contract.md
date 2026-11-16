# Experimental IDE machine interface (v1)

This additive interface is experimental. It supports repository inventory,
ordinary New/Open outcomes, and Rebase outcomes for app consumers. It does not change the existing
human CLI, release version, setup/provider/workflow behavior, or platform promises.
No IDE consumer is included. Rebase records and native cleanup approval are described below. Linux x86_64 is the tested
initial target. Consumers must check `schemaVersion` and reject unsupported versions.
Within v1, ignore additional object fields; incompatible changes require a new version.

## Invocations and channels

Run the Timber executable with literal argument arrays and a captured repository
cwd. Never parse the human table, derive a worktree path from a ticket, or duplicate
provider/branch resolution.

```sh
timber ls --json
timber new 'feature name' --result-file /private/temp/new.json --no-editor --no-agent
timber open 'GH-123' --result-file /private/temp/open.json --no-editor --no-agent
timber open --setup --result-file /private/temp/retry.json --no-editor --no-agent -- '/absolute/worktree path'
timber rebase --result-file /private/temp/rebase.json -- '/absolute/worktree path'
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
and the `rebase` object, which exists only on `rebase`.
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
};

type RebaseRecord = {
  result: "rebased" | "up-to-date" | "conflicts" | "refused" | "failed";
  base: string | null;        // canonical base ref that was selected
  baseCommit: string | null;  // pinned commit that was rebased onto
  originalTip: string | null; // branch tip before the rebase
  conflicts: string[];        // worktree-relative unmerged paths; empty unless result is "conflicts"
  baseSaved: boolean;         // this run wrote the saved base association
};

type RecordV1 = {
  schemaVersion: 1;
  command: "ls" | "new" | "open" | "done" | "rebase";
  outcome: "succeeded" | "cancelled" | "failed";
  exitCode: number;
  repository: RepositoryIdentity | null;
  worktree: WorktreeRecord | null;
  materialized: boolean;
  diagnostic: string | null;
  worktrees?: WorktreeRecord[]; // always present for ls, including failed ls
  rebase?: RebaseRecord;        // always present for rebase, including refusals
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

## Native cleanup approval (experimental v1)

`timber __ide-done preview [--keep-branch] [--keep-ignored] [--base <ref>] -- <absolute-registered-path>` writes one JSON preview to stdout without hooks or deletion. It includes `schemaVersion: 1`, `repository`, `worktree`, normalized `options`, `snapshot` and `expiresAt` (Unix milliseconds, ten minutes). The consumer must show the exact target, loss of modified/untracked and ignored content, local branch effect, and unchanged remote refs before its single Remove confirmation. Unsaved editors and live sessions require independent IDE handling. `--keep-ignored` refuses while ignored content exists; it does not copy files.

After that confirmation, save the unchanged preview into a private temporary file and invoke `timber __ide-done apply --approval-file <path> --result-file <new-path> -- <same-absolute-path>`. Apply never asks a terminal question. It validates preview expiry, repository, reciprocal target identity, root inode, HEAD/branch, base, options, hooks and changed-file/index content before entering cleanup, and again at cleanup's ordinary discard decision. The native snapshot is checked unconditionally again immediately before Git removal, including after cleanup hooks. When discarding ignored files, approval covers all ignored paths and bytes, including ignored runtime files changed by cleanup hooks; those bytes are deliberately excluded from the changed-file fingerprint, matching ordinary Done semantics. The UI must explicitly describe this scope. Existing post-hook checks and primary, operation, ignored-file and ref protections remain. A changed snapshot is an error requiring an updated preview; it never silently broadens approval or retries. Approval is scoped to one target state, not a general noninteractive force flag.

Result files use the existing v1 mutation envelope with `command: "done"`, the captured pre-deletion worktree, and `materialized: false`. Failures may occur after folder removal but before branch removal; consumers must reconcile `ls --json` after every outcome and must never infer current availability from the captured result. Hooks retain normal IO; no prompt parser or automatic terminal answer is involved. Existing interactive `done` behavior is unchanged.
