# Experimental IDE machine interface (v1)

This additive interface is experimental. It supports repository inventory and
ordinary New/Open outcomes for IDE integration. It does not change the existing
human CLI, release version, setup/provider/workflow behavior, or platform promises.
No IDE consumer or Rebase interface is included. Native cleanup approval is described below. Linux x86_64 is the tested
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
All fields are required except the `worktrees` array, which exists only on `ls`.
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

type RecordV1 = {
  schemaVersion: 1;
  command: "ls" | "new" | "open" | "done";
  outcome: "succeeded" | "cancelled" | "failed";
  exitCode: number;
  repository: RepositoryIdentity | null;
  worktree: WorktreeRecord | null;
  materialized: boolean;
  diagnostic: string | null;
  worktrees?: WorktreeRecord[]; // always present for ls, including failed ls
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

## Native cleanup approval (experimental v1)

`timber __ide-done preview [--keep-branch] [--keep-ignored] [--base <ref>] -- <absolute-registered-path>` writes one JSON preview to stdout without hooks or deletion. It includes `schemaVersion: 1`, `repository`, `worktree`, normalized `options`, `snapshot` and `expiresAt` (Unix milliseconds, ten minutes). The consumer must show the exact target, loss of modified/untracked and ignored content, local branch effect, and unchanged remote refs before its single Remove confirmation. Unsaved editors and live sessions require independent IDE handling. `--keep-ignored` refuses while ignored content exists; it does not copy files.

After that confirmation, save the unchanged preview into a private temporary file and invoke `timber __ide-done apply --approval-file <path> --result-file <new-path> -- <same-absolute-path>`. Apply never asks a terminal question. It validates preview expiry, repository, reciprocal target identity, root inode, HEAD/branch, base, options, hooks and changed-file/index content before entering cleanup, and again at cleanup's ordinary discard decision. The native snapshot is checked unconditionally again immediately before Git removal, including after cleanup hooks. When discarding ignored files, approval covers all ignored paths and bytes, including ignored runtime files changed by cleanup hooks; those bytes are deliberately excluded from the changed-file fingerprint, matching ordinary Done semantics. The UI must explicitly describe this scope. Existing post-hook checks and primary, operation, ignored-file and ref protections remain. A changed snapshot is an error requiring an updated preview; it never silently broadens approval or retries. Approval is scoped to one target state, not a general noninteractive force flag.

Result files use the existing v1 mutation envelope with `command: "done"`, the captured pre-deletion worktree, and `materialized: false`. Failures may occur after folder removal but before branch removal; consumers must reconcile `ls --json` after every outcome and must never infer current availability from the captured result. Hooks retain normal IO; no prompt parser or automatic terminal answer is involved. Existing interactive `done` behavior is unchanged.
