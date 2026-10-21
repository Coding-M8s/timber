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
| `loadConfig` | TIM-6; TIM-18 adds validated repository/global scopes |
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
means no configured command. TOML keys such as `base_branch` map to `baseBranch`; loading and strict
validation belong to TIM-6. `RepositoryConfig.editor` is `EditorConfig | null`:
`command` is required, `args` defaults to `[]`, and `enabled` defaults to
`false`. `--editor` and `--no-editor` produce explicit true/false command options;
omission defers to the selected editor's `enabled` value. An explicit enable
without a selected command fails before worktree creation. Editor commands remain
executable names plus argument arrays.

`RepositoryConfig.agent` is `AgentConfig | null`. When `[agent]` is present, its
non-empty executable `command` is required, `args` defaults to a string array `[]`,
and `enabled` defaults to `false`. TIM-6 parses and retains this setting in 0.1;
TIM-9 owns launching in 0.2. No agent launches from config loading, and this shape
does not create a provider framework. Hooks and Jira are optional 0.2 integrations.

`RepositoryConfig.jira` is omitted when effective `[jira]` is absent or explicitly disabled, preserving the existing
config shape; when present it contains a normalized HTTPS `siteUrl` and optional
UUID `cloudId`. Config loading accepts only `site_url` and `cloud_id` in that strict
table. Site URLs must be tenant origins on `*.atlassian.net`, with no credentials,
nondefault port, query, fragment, or path other than `/`. Credentials are never
ordinary configuration values. `resolveJiraTicket(config, key)` and suggestions
resolve credentials lazily: either defined Jira environment variable selects a
complete nonblank `JIRA_EMAIL`/`JIRA_API_TOKEN` override pair; never mix sources.
Otherwise use only the matching normalized site/cloud-ID personal record from
Timber's private user configuration directory. Setup's separate credential draft
supports keep/replace/remove, masked token entry and explicit Save. See the
[credential storage, permissions, connection-check and recovery contract](cli-contract.md#guided-configuration-tim-18).
Offline commands and disabled Jira never read the store. Timber adds no `.env` loader and reads its
process environment. Standalone release builds disable `.env` and `bunfig.toml`
autoload. Bun's source runner may populate that environment before startup unless run
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
unavailable upstream evidence remains unknown. An invalid or ambiguous configured/default
base also remains unknown. An invalid explicit `CleanupOptions.base` is an error
before mutation, even when live publication could otherwise permit cleanup.

Mutation obtains new evidence, then rechecks target identity, status, lock,
branch/head, and validated-base ref/commit immediately before removal. When
removal depends on live publication rather than validated-base ancestry or proven content integration,
publication is rechecked after those final local reads and immediately before
crossing Git's remove boundary. Modified or untracked content always blocks
removal. Ignored content, including `.env`, is discarded by default. `--keep-ignored`
normalizes to `discardIgnored: false` and blocks removal when ignored content exists,
leaving files in the original worktree. Unpublished or unknown publication blocks
removal unless the target commit is contained in the validated base or a successful
virtual merge of the local branch produces exactly the validated base tree, or its complete tip tree matches a commit reachable from the pinned validated base. Historical equality proves snapshot preservation even after later edits or reverts; matching trees only on unrelated refs do not qualify. History reads must complete successfully and contain only validated tree hashes.
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
Issue #63 adds optional `preDelete: readonly string[]`, mapped from
`[hooks].pre_delete`; omission means no deletion steps. Whole-table replacement
applies to both lists. TOML `[hooks].post_create` maps to `postCreate`; absent hooks leave existing
configuration shapes unchanged. `runSetup(repository, worktree, config, io)`
executes trusted source sequentially via fixed `/bin/sh -c`, streaming output
through `CommandIO`, and rejects with retained-state/retry guidance on failure.
It never removes a workspace or changes Git refs. It overrides repository,
worktree, branch and optional leading-ticket context through environment values.
The [CLI contract](cli-contract.md#setup-hooks-02-tim-7) defines the exact semantics.

`cleanupWorktree(repository, worktree, config, options, io?)` owns pre-deletion
execution between its initial safety checks and its final evidence reads.
`createDoneHandler` passes invoking `CommandIO`; direct callers default to process
streams. `runPreDelete` reuses the ordinary shell runner and environment context,
without setup/workflow steps or editor/agent launch. Failure retains the worktree
and branch, reports a safe `done` retry with retention options, and never rolls
back hook side effects. Revalidate identity, status, relevant refs and preservation
evidence after hooks; hooks cannot grant deletion authority. Guided setup retains
existing pre-deletion steps when editing creation scripts; edit deletion steps in TOML.
When deletion hooks run, publication evidence also captures the remote name,
remote branch, tracking ref and effective fetch URL for private comparison across
hooks. Never render this identity: URLs may contain credentials. No extra URL
read is required for cleanup without deletion hooks.

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

This describes the foreground path. TIM-27 below defines editor-owned terminals.

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

## TIM-18 configuration and setup contract

`loadConfig(repository)` uses `loadRepositoryConfig` to validate and resolve
repository/global settings into `RepositoryConfig`. All four worktree commands
use this existing seam; Git and launch services receive the normalized model.
Config bytes and sparse scope data remain private to setup. Normal commands have
no config-presence wrapper, reminder state, or end-of-response setup message.
The entry point owns a one-time hint using machine state outside repositories;
an explicit request for an unconfigured agent produces actionable setup guidance.

The [CLI contract](cli-contract.md#repository-configuration) defines global
precedence, whole-table replacement, and root-level false integration disables.
Normalized editor/agent remain null when no command is configured or an integration is explicitly removed; a configured editor with `enabled = false` remains available for `--editor`. Hooks/Jira remain omitted when off.
Existing valid TOML and Git/editor/agent/hook/Jira service models remain valid.
A partial executable table still requires command. The new setup handler owns
questionnaire, draft review/edit loop, and persistence through injected prompts
and storage services. Section editing changes only the draft and uses its current
values for keep/reset choices; the original target snapshot remains available
for concurrent-write detection at explicit save. Keyboard number shortcuts select
immediately for the first nine options; arrows reach all options. Cancellation
from review or section editing never publishes the draft;
foreground agent launch and post-create setup remain separate operations.

## TIM-25 named workflow contract

`RepositoryConfig.workflows` is present when either config scope mentions workflows. It maps validated lowercase names to complete normalized definitions. Global and repository definitions merge by name; a local same-name table replaces the entire global table, a local `false` removes one inherited name, and root `workflows = false` removes all. `WorkflowConfig` reuses the existing `ExecutableCommand` shape for editor and agent; this keeps TIM-20 able to use the same executable/argument pair without a provider model. Absent workflow launcher fields inherit ordinary settings, including `[editor].enabled`. A workflow editor table requests launch; `false` disables inheritance. Explicit `--editor` with a workflow editor set to `false` selects the ordinary configured editor, if any.

`readWorkflowAssociation(repository, worktree)` returns assigned, unassigned, or invalid metadata. `writeWorkflowAssociation(repository, worktree, name)` writes a versioned, atomic, private Git-admin record after reciprocal Git identity validation. The record contains the name and canonical paths only. `open` rejects invalid saved records and missing saved definitions instead of selecting another workflow; a valid explicit assignment can replace a stale identity record. `ls` keeps all Git rows and renders invalid records as `?`.

`new` and branch-materializing `open` save an explicitly selected workflow before running setup. One setup invocation runs resolved ordinary scripts then workflow scripts, with `TIMBER_WORKFLOW` in the environment. Existing-worktree `open` without `--setup` never runs creation scripts. When a workflow is selected, existing-worktree `open` never launches an implicit agent, even if ordinary agent defaults are enabled; `--agent` is an explicit launch. No-workflow worktrees retain the earlier ordinary-agent behavior. Editor selection is reevaluated from current config on every open. CLI `--workflow`, `-w`, and `--w` normalize to the same option, and duplicate aliases fail before dispatch.

## TIM-27 reviewed launch extension

Editor/workflow editor launchers carry optional `integration: "orca"`. Agent and
workflow agent launchers carry optional `waitForSetup`, from boolean TOML
`wait_for_setup`, with effective default false. Scope tables still replace whole
lower-scope tables. For ordinary `new` and `open`, a shared coordinator chooses
the editor-terminal seam only for an enabled Orca integration. It receives
repository/worktree, effective editor,
resolved agent, selected setup and workflow context; it waits for required setup
and actual spawn acknowledgement, never interactive agent lifetime. Legacy seams
remain separate. Existing opens suppress implicit agents whenever the editor is
enabled; disabled-editor behavior remains unchanged. Private transient requests
carry literal args/context and trusted hook source, with bounded exact local
readiness and no foreground fallback. Arena retains sequential foreground launches
in the invoking terminal. See the TIM-27 CLI launch contract.

## TIM-20 arena contract

`src/arena/types.ts` exports `ArenaAttemptGroup`, `ArenaNewOptions`,
`ArenaParticipantConfig`, `PlannedParticipant`, `ArenaDraft`, `ArenaPlan`,
`ArenaSourceSelection`, `ArenaManifestV1`, `ArenaManifestV2`, and their reader union
`ArenaManifest`. Internal participant names remain implementation details; public
creation uses agent tool/model/effort/runs and named agent presets.
`ArenaNewOptions.defaultEffort` supplies an invocation-wide native effort fallback;
`--effort default` is normalized to no override for an individual tool group.
Preset-configured effort wins; a native preset without effort inherits the fallback.
Manual and wrapper groups remain outside native effort selection. The collector
validates every selected native model/effort before planning and leaves config
objects unchanged. `captureArenaEffortEnvironment` adds an optional, safe Claude
inherited-setting observation to planned attempts; `effortEnvironment` persists it
in V2 without changing record version. Only recognized levels, `auto`, or the
redacted `unrecognized` marker are valid, only on Claude attempts without explicit
effort. Missing historical observations stay absent. `arenaEffortEnvironment`
synchronizes the child environment with explicit validated Claude effort. Effective
runtime effort is always unknown; TIM-21/22 must not treat an observation as proof.

`parseArenaGroups` preserves ordered flag boundaries; `resolveArenaGroups` expands native/manual/preset groups deterministically
and builds literal executable arguments. Preset model fields and documented old
model argument forms normalize without duplication or default-model guessing.

`RepositoryConfig.arena` holds effective named presets. Configuration fingerprints
cover resolved tool/command/arguments without raw dumps. V2 attempt configuration
source distinguishes built-in, preset, ordinary [agent], and manual. Future recovery
must deliberately revalidate changed/missing configuration, not silently substitute.
V1 records stay readable unchanged and do not gain fabricated harness/model fields.
Both record versions require at least two attempts and impose no fixed count cap.
Count parsing/normalization requires safe positive whole numbers and a safe total;
questionnaire and planning follow the same rule. Manifest reads scale with record
size, retaining private-file/schema/identity checks and separate task/marker limits.
The separate worktree UUID marker retains version 1 and its existing lifecycle.

`resolveArenaSource` returns read-only found/ambiguous selections. A local selection
contains a verified pinned base and works without a worktree/network; a remote
selection contains branch identity plus advertised commit, not a fake ValidatedBase.
`listLiveRemoteHeads` preserves advertised OIDs; ordinary open's existing
`listLiveRemoteBranches` remains a projection with unchanged semantics.
`ArenaDraft` holds confirmed-to-be destinations and source selection before fetch;
`planWorktree` accepts base-free new-branch destination requests for this read-only
phase. `finalizeArenaSource` runs only after confirmation, refreshes selected remote
under bounded unattended Git options, rejects a changed advertised tip, and produces
locally verified `ValidatedBase`. No source branch/worktree is materialized.
`ArenaPlan` adds final source/ticket provenance to the pinned base and attempt paths.

`CommandHandlers.arenaNew` remains optional for embedders. Production wires narrow
`ArenaServices` for source resolution/finalization, draft planning, collection/review,
private storage, and existing creation/setup/editor/agent seams. Prompt collection
provides lazy/shared source choice and final review so pasted answers survive;
callers close input in every cancellation/preflight path before fetch/launch.
Ambiguity uses stable exact refs and capped noninteractive diagnostics.

`reserveArena` returns an owned `ArenaSession` with mutable manifest, task path,
atomic save, reciprocal bind, digest verification, and lock close. `readArena`
validates v1/v2 schema, source/model consistency, repository identity and task digest;
`validateArenaAttempt` checks Git inventory, reciprocal identity and marker immediately
before external actions. New commits/dirty files do not invalidate membership.
None of these operations grants cleanup authority to TIM-22.

`launchAgent` retains optional literal environment overrides and unchanged foreground
signals. Source fetch can update cached refs only after confirmation; creation/setup/
launch failures retain completed work. Exact precedence, collision limits, privacy,
flags and recovery live in [arena creation](cli-contract.md#arena-creation-post-10-tim-20).
TIM-21/TIM-22 must review these shared v1/v2 contracts before consuming them.

## TIM-30 cleanup base override

`CleanupOptions.base?: string` is an invocation-local branch/ref selector passed
unchanged from Commander through the done handler to cleanup. It overrides the
configured/default base for initial evidence, final safety reads and post-removal
branch-deletion validation without modifying config. Cleanup evidence readers
accept an optional explicit selector; invalid explicit selection propagates as
an error, while omitted selection retains explanatory unknown-base evidence.
An explicit target-local-branch base always rejects, including with keep-branch
or verified live publication. Hook retries retain a safely quoted explicit base.
Existing service signatures remain compatible; inspection without an override
and all publication, file-preservation and ignored-file policies are unchanged.

## TIM-28 remote rebase

`CommandHandlers.rebase` is optional for existing embedders and returns a numeric
status. `createRebaseHandler` uses discovery, config, existing target resolution
and a narrow `rebaseWorktree(repository, worktree, config, explicitBase, io)` seam.
The Git service owns preflight, live remote selection, FETCH_HEAD-only fetch with
no destination ref/empty refmap, advertisement verification, pinning, revalidation,
execution and safe result/recovery reporting; `resolveRebaseTarget` reuses ordinary
selection and maps a detached paused rebase through Git's saved head-name solely
for recovery lookup. Ordinary open/done selection is unchanged. Operational
failures reject; actual rebase results return numeric status. It never invokes launch/setup seams.
Existing shared base resolution retains its local semantics; rebase resolves only
remote branches. Git-operation detection is shared with cleanup's initial/final
checks, preserving staged paused operations. No existing service signature changes.
See [rebase behavior](cli-contract.md#rebase-an-existing-worktree-tim-28).
