# Shared TypeScript contracts

TIM-11 established `src/types.ts` and `src/services.ts` against
[the behavioral contract](cli-contract.md). The service table below records
which tickets implement each seam. Changes that would break another lane need
a reviewed contract change first.

## Modules and ownership

| Entry point | Responsibility / next ticket |
| --- | --- |
| `src/index.ts` | Process argv, cwd, stdout/stderr and exit status only |
| `src/cli.ts` | Commander parsing and injected `CommandHandlers` |
| `src/types.ts` | Shared domain values for all lanes |
| `src/services.ts` | Plain asynchronous command service functions |
| `discoverRepository`, `listWorktrees` | TIM-1; TIM-4 extends worktree targeting |
| `loadConfig` | TIM-6 |
| `resolveJiraTicket`, `findJiraSuggestions` | TIM-10 |
| `resolveBranch`, `resolveBase` | TIM-2 |
| `resolveOpenTarget` | TIM-4 |
| `createWorktree` | TIM-3 |
| `inspectCleanup`, `cleanupWorktree` | TIM-5 |
| `launchEditor` | TIM-8 |
| `runSetup` | TIM-7 |
| `launchAgent` | TIM-9 |
| `CommandHandlers.new/open/list/done` | TIM-12/13/14/15 |

Each command module can take the relevant `Pick<CommandServices, ...>` and return
a handler. Compose concrete services at the entry point as they land; there is no
service registry. `runCli(argv, { context, handlers })` accepts user arguments
without executable/script prefixes, creates a fresh parser per call, awaits its
handler, and returns a numeric exit status without exiting the process.
`new` accepts variadic positional words and joins them with literal U+0020 spaces
before calling its existing string-based handler. The handler receives this raw
joined input, performs exact whole-input Jira detection, then applies the
documented literal-space normalization before Git creation.
`context.cwd` is only the discovery starting point. All subsequent Git services
receive the discovered `RepositoryContext`; they must invoke `git` with an argument
array and an explicit cwd from that context.
`context.choose` is optional and is available only when stdin and stdout are TTYs
and `CI` is unset or equals `false` case-insensitively. A chooser receives a message and unique stable
values paired with display labels; it returns one offered value or `null` for
cancellation. Commands validate returned values against the offered choices.
All chooser cancellations print `Cancelled.` and return success without mutation.

## Values and safety requirements

Paths returned in repository/worktree models are absolute. `commonGitDir` is the
repository identity; `currentWorktreeRoot` can differ from `primaryWorktreeRoot`.
Branches distinguish local and remote refs, preserving the remote name without
assuming origin. Refs are full refs; branch names do not include `refs/heads/` or
the remote name. A remote's unknown default is null. Detached HEAD uses a null
branch, while an unborn branch still has its name. Discovery rejects unsupported
bare repositories and non-repository paths with actionable errors.

`Resolution<T>` carries found, not-found, or ambiguous candidates. Resolution is
exact worktree/local/remote first, followed by delimiter-boundary ticket matching;
explicit remote input selects that remote. Existing worktrees open offline.
`open` opts into `resolveOpenTarget(..., { discoverRemote: true })`. A unique
local branch or registered worktree resolves offline. Otherwise advertised remote
heads replace cached remote refs for discovery, using `git ls-remote` without
mutating refs. The explicit/configured remote limits discovery; otherwise all
remotes are checked. Each query has a 10-second timeout; errors block creation.
Only the selected remote is fetched by the existing creation service. `new`
retains its creation-only behavior and Jira status validation.
Creation from a remote must refresh that remote and reject on failure, including
when called directly through the service. A validated base records its commit and
selection source. Base precedence remains explicit, config, selected remote's
default, then unambiguous main/master. Creation validates Git branch names, safe
slugs and destination containment, rejecting existing paths, collisions and the
primary repository. Relative configuration paths use the primary root, with the
default sibling layout from the behavioral contract.

`src/git/open-target.ts` implements `resolveOpenTarget` for TIM-4 without changing
the `CommandServices` or domain unions. An absolute input matches only a registered
worktree path after lexical path normalization. For unqualified inputs, an exact
checked-out local branch resolves to its worktree before branch lookup. Other branch
inputs delegate to TIM-2's exact local/remote and delimiter-boundary prefix policy.
A known explicit remote name selects that remote even when a local branch has the
same spelling.

A remote branch reuses a local worktree only when that local branch records the
same full upstream ref. Ambiguity contains every distinct path or full branch ref
in stable order, including missing and prunable worktrees. A uniquely selected
missing, prunable, or identity-mismatched worktree rejects with its path and
recovery guidance. Dirty, ignored, unpublished, or locked worktrees remain
openable; unknown status stays unknown. `resolveOpenTarget` never fetches or
mutates Git state. TIM-13 puts every ambiguous candidate in one chooser; labels
mark candidates that require manual path/branch selection, and selecting one
returns its safe guidance without creating or opening anything. Without a chooser,
report no more than the first five sorted candidates and the total count with exact
manual-selection guidance. TIM-13 consumes the `OpenTarget` union to open a
worktree or materialize a branch; TIM-3 refreshes a selected remote only before
remote branch creation.

`Worktree` retains primary, locked, missing and prunable states, including entries
created outside Timber. Status is either known file lists or an explicit unknown
reason. Count each modified/untracked file once when formatting TIM-14 output;
unknown status must not appear clean. Missing/stale rows must remain visible.

`RepositoryConfig` is the normalized 0.1 shape, extended by optional features in
their owning tickets. Null base/remote/worktree directory
means absent and requires the documented resolution/default policy. Null editor
means off. TOML keys such as `base_branch` map to `baseBranch`; loading and strict
validation belong to TIM-6. Only `--no-editor` produces `editor: false` in command
options; omission leaves that property absent, deferring to configuration. Editor
commands are executable names plus argument arrays.

`RepositoryConfig.agent` is `AgentConfig | null`. When `[agent]` is present, its
non-empty executable `command` is required, `args` defaults to a string array `[]`,
and `enabled` defaults to `false`. TIM-6 parses and retains this setting in 0.1;
TIM-9 owns launching in 0.2. No agent launches from config loading, and this shape
does not create a provider framework. Hooks and Jira are optional 0.2 integrations.

`RepositoryConfig.jira` is omitted when `[jira]` is absent, preserving the existing
config shape; when present it contains a normalized HTTPS `siteUrl` and optional
UUID `cloudId`. Config loading accepts only `site_url` and `cloud_id` in that strict
table. Site URLs must be tenant origins on `*.atlassian.net`, with no credentials,
nondefault port, query, fragment, or path other than `/`. Credentials are never
configuration values: `resolveJiraTicket(config, key)` reads `JIRA_EMAIL` and
`JIRA_API_TOKEN` lazily when called. Timber adds no `.env` loader and reads its
process environment; Bun may populate that environment before startup unless run
with `bun --no-env-file`. The client uses the configured site URL for unscoped
tokens, or the fixed Atlassian Jira Cloud gateway selected by `cloudId` for scoped
tokens. It rejects redirects, does not retry, validates the returned canonical key
and nonblank summary, and constructs the browse URL locally. It requests the Jira
status and accepts only the known category keys `new`, `indeterminate`, or `done`;
`done` rejects before creation, and missing, null, or unknown categories fail
closed. Status display names and resolution fields do not determine the category.

`findJiraSuggestions(config, key)` uses Jira's [enhanced JQL search endpoint](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
with a fixed same-project query, `summary,status`, and token-based pagination. Every
page and body shares one 10-second deadline; redirects and retries are disabled.
Missing or repeated continuation tokens and any failed or malformed page reject the
whole search, so commands never show a partial list or count. The client validates
keys, locally keeps only known active categories (`new` or `indeterminate`) whose
full key starts with the requested key, excludes the exact key, deduplicates, and
sorts results. Only `new` falls back to this seam, and only after an exact
not-found or done reason. It requires an explicit chooser response even for one
candidate, then calls `resolveJiraTicket` again for that selected key before Git
creation. An absent chooser reports at most five sorted candidates and the exact
eligible count; cancellation or failed revalidation makes no Git mutation. Errors
are safe categories and do not include response bodies, credentials, raw transport
exceptions, or full configuration values. Ticket-key recognition and branch
naming are pure Jira helpers consumed by TIM-10; the Git creation service continues
to validate refs and paths and remains authoritative for collisions.

`src/git/cleanup.ts` implements `inspectCleanup` and `cleanupWorktree` for
TIM-5. TIM-15's `createDoneHandler` reuses `resolveOpenTarget` with openability
checks disabled, rejects unchecked branches and the primary worktree, and
delegates fresh safety checks and mutations to `cleanupWorktree`. It never
creates a worktree or launches an editor or agent. Ambiguity lists distinct
worktree paths and branch refs without guessing and asks for an exact branch
name or absolute worktree path; success output comes only from a verified
`CleanupResult`, including `deletedLocalBranch` or `retainedLocalBranch`. `CleanupInspection` is explanatory evidence, not
deletion authority. Refusals identify affected file paths and commit OIDs or
explain missing publication and ancestry evidence, without exposing file contents.
Publication and ancestry each distinguish known from
unknown. Inspection reads current worktree status and ancestry against the
validated base. It checks the configured upstream's live branch tip; cached
remote-tracking refs alone do not prove publication. Inspection does not fetch
or update tracking refs. Missing, inaccessible, ambiguous, or locally
unavailable upstream evidence remains unknown. An invalid or ambiguous base
also remains unknown.

Mutation obtains new evidence, then rechecks target identity, status, lock,
branch/head, and validated-base ref/commit immediately before removal. When
removal depends on live publication rather than validated-base ancestry or proven content integration,
publication is rechecked after those final local reads and immediately before
crossing Git's remove boundary. Modified or untracked content always blocks
removal. Ignored content, including `.env`, is discarded by default. `--keep-ignored`
normalizes to `discardIgnored: false` and blocks removal when ignored content exists,
leaving files in the original worktree. Unpublished or unknown publication blocks
removal unless the target commit is contained in the validated base or a successful
virtual merge of the local branch produces exactly the validated base tree.
Reject custom merge-driver configuration and disable renormalization for this proof;
unsupported or failed proof never authorizes deletion. The target branch
must not be the validated base: self-containment against that tip is
tautological and never authorizes cleanup. A detached worktree has no
publication or local-branch evidence; it can be removed only when its commit is
contained in the validated base. `keepBranch` skips branch deletion only. A clean
published but unmerged worktree can also be removed with its local branch when
publication is reverified; a missing base does not block this path. Squash/rebase merges may prove content integration without ancestry; closed PR metadata proves neither.

Local branch deletion requires live upstream publication, validated-base ancestry, or proven content integration and never
deletes the validated base ref itself. After the worktree is removed, TIM-5
rechecks the direct local ref, expected commit OID, and preservation proof. For
integration, revalidate the base and ancestry or content equivalence; for publication,
revalidate live upstream ancestry and require the same upstream identity. Verify
worktree inventory, then conditionally delete only the unchanged local ref. Losing
publication after removal retains the local branch and reports partial completion.
If another worktree checks out the branch in the inventory-to-delete gap,
cleanup restores the tip and retains the branch. It never deletes a remote
branch. If removal succeeds but branch deletion or its verification fails, the
service rejects with the observed removed path and retained or unknown branch
state. Filesystem removal and ref deletion cannot share one Git transaction. A
concurrent write after the final status read but before Git removes the
worktree is an unavoidable window: Git's non-force guard catches new modified
or untracked files, but an ignored file created in that gap can be removed with
the worktree. Live publication checks prove a remote snapshot; Git cannot lock
the remote tip together with local removal or deletion. A concurrent remote
rewrite after the last publication check remains an unavoidable race.
`keepBranch` retains the local branch regardless. A concurrent branch or base change after removal can leave the
worktree gone while the local branch remains. There is no force bypass, remote
deletion, stash, or process killing seam. `CleanupResult` is returned only
after all requested operations are verified.

Service promises reject on operational failures; errors must be actionable and
safe to print (no credentials, config dumps or secret subprocess output). Expected
lookup absence/ambiguity are values. `EditorResult.failed` describes a retained
workspace and retry instructions; command handlers must report launch failure
without deleting completed Git work. The parser writes handler errors once to
stderr and returns 1; handlers write human results through `context.io.stdout`.
No command may wait for interactive input in CI. Noninteractive open ambiguity
and Jira suggestions show no more than the first five sorted candidates and the
exact total with guidance for explicit selection or a terminal rerun. The terminal
chooser initially renders five entries; `a` shows all candidates only after the
warning `This will display all N matches. Continue? [y/N]` is confirmed with `y`.
Cancellation and manual-only selections stop before side effects. Cancelling either
chooser prints `Cancelled.` to stdout and returns success; manual-only selections
remain errors with actionable guidance.

TIM-7 adds optional `RepositoryConfig.hooks` with `postCreate: readonly string[]`.
TOML `[hooks].post_create` maps to that field; absent hooks leave existing
configuration shapes unchanged. `runSetup(repository, worktree, config, io)`
executes trusted source sequentially via fixed `/bin/sh -c`, streaming output
through `CommandIO`, and rejects with retained-state/retry guidance on failure.
It never removes a workspace or changes Git refs. It overrides repository,
worktree, branch and optional leading-ticket context through environment values.
The [CLI contract](cli-contract.md#setup-hooks-02-tim-7) defines the exact semantics.

`createNewHandler` calls setup after creation; `createOpenHandler` calls it on
creation or explicit `OpenOptions.setup: true`. Neither calls the seam when
there are no configured steps. Setup rejection stops launch and becomes a
nonzero CLI result. Existing-worktree `open` skips setup by default; `--setup`
retries all steps once. TIM-9's agent launcher must follow successful setup and
editor startup. No setup state registry or implicit rollback is introduced.

`done` filters ambiguous resolutions to unique registered worktrees. A sole
worktree is selected even if unchecked local or remote-only branches share its
prefix. Multiple worktrees use the shared five-option chooser; noninteractive
output caps candidates at five with the total. Re-resolve the chosen absolute
path with `assertOpenable: false` and verify path/branch identity before handing
it to the unchanged cleanup safety checks. Direct branches without worktrees and
the primary worktree remain errors.

## Test doubles

`tests/helpers/services.ts` exports `createServiceDouble`, `repositoryFixture` and
`worktreeFixture`. Override only the services a command needs; every other service
rejects with its name. Fixtures are fresh objects per call. `tests/contracts.test.ts`
shows an illustrative list handler using discovery and list doubles, including a
missing detached worktree, without implementing TIM-14.

Future Git mutations require temporary real repositories and assertions that
failure preserves files/refs. TIM-11 only parses commands and supplies interfaces,
so its tests cover subprocess CLI behavior, dependency compatibility, dispatch,
and compile-checked service consumers; it claims no Git lifecycle verification.

## TIM-9 agent additions

`NewOptions.agent` and `OpenOptions.agent` are optional booleans: undefined
defers to config, true enables, false disables. CLI rejects both controls
together. `CommandContext.interactive` is optional; absent means false.
The process entry point computes it from stdin/stdout TTY state and CI.

`resolveAgentCommand(config, enabled, interactive)` selects the existing
executable configuration or null, and rejects invalid explicit choices before
Git mutation. Commands invoke `launchAgent(worktree, command)` only when enabled
and all preceding setup/editor work succeeded. No config-schema change or
provider abstraction is needed.

`AgentResult` distinguishes skipped, exited (numeric exitCode and nullable
signal), and failed (safe message and retryCommand). The service waits for
one owned foreground child with inherited stdio, literal args, and worktree
cwd. It never detaches or unrefs. Startup errors become failed values; signal
listeners are removed on every completion path. Terminal SIGINT relies on
foreground-group delivery; parent SIGTERM and non-TTY SIGINT are forwarded.
Only actual child signal exits use the signal-based numeric status.

Only new/open handlers widen to `Promise<void | number>`: void remains
success, numeric results propagate agent status through runCli. Operational
exceptions still print once and return 1. Existing list/done consumers and
their signatures remain unchanged. Keep the documented existing new/open
editor failure exit policies while suppressing agent startup in both cases.

`src/display.ts` holds the existing safe path/diagnostic/retry rendering shared
with open; agent recovery uses the same control-character escaping.
