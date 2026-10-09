# Shared TypeScript contracts

TIM-11 establishes `src/types.ts` and `src/services.ts` against
[the behavioral contract](cli-contract.md). They define interfaces, not a Git
engine or implemented worktree commands. Changes that would break another lane
need a reviewed contract change first.

## Modules and ownership

| Entry point | Responsibility / next ticket |
| --- | --- |
| `src/index.ts` | Process argv, cwd, stdout/stderr and exit status only |
| `src/cli.ts` | Commander parsing and injected `CommandHandlers` |
| `src/types.ts` | Shared domain values for all lanes |
| `src/services.ts` | Plain asynchronous command service functions |
| `discoverRepository`, `listWorktrees` | TIM-1; TIM-4 extends worktree targeting |
| `loadConfig` | TIM-6 |
| `resolveBranch`, `resolveBase` | TIM-2 |
| `resolveOpenTarget` | TIM-4 |
| `createWorktree` | TIM-3 |
| `inspectCleanup`, `cleanupWorktree` | TIM-5 |
| `launchEditor` | TIM-8 |
| `CommandHandlers.new/open/list/done` | TIM-12/13/14/15 |

Each command module can take the relevant `Pick<CommandServices, ...>` and return
a handler. Compose concrete services at the entry point as they land; there is no
service registry. `runCli(argv, { context, handlers })` accepts user arguments
without executable/script prefixes, creates a fresh parser per call, awaits its
handler, and returns a numeric exit status without exiting the process.
`context.cwd` is only the discovery starting point. All subsequent Git services
receive the discovered `RepositoryContext`; they must invoke `git` with an argument
array and an explicit cwd from that context.

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
mutates Git state. TIM-13 consumes the `OpenTarget` union to open a worktree or
materialize a branch; TIM-3 refreshes a selected remote only before remote branch
creation.

`Worktree` retains primary, locked, missing and prunable states, including entries
created outside Timber. Status is either known file lists or an explicit unknown
reason. Count each modified/untracked file once when formatting TIM-14 output;
unknown status must not appear clean. Missing/stale rows must remain visible.

`RepositoryConfig` is the normalized 0.1 shape. Null base/remote/worktree directory
means absent and requires the documented resolution/default policy. Null editor
means off. TOML keys such as `base_branch` map to `baseBranch`; loading and strict
validation belong to TIM-6. Only `--no-editor` produces `editor: false` in command
options; omission leaves that property absent, deferring to configuration. Editor
commands are executable names plus argument arrays.

`RepositoryConfig.agent` is `AgentConfig | null`. When `[agent]` is present, its
non-empty executable `command` is required, `args` defaults to a string array `[]`,
and `enabled` defaults to `false`. TIM-6 parses and retains this setting in 0.1;
TIM-9 owns launching in 0.2. No agent launches from config loading, and this shape
does not create a provider framework. Hooks and Jira remain 0.2 integrations.

`CleanupInspection` is explanatory evidence, not deletion authority. Publication
and ancestry each distinguish known from unknown. Mutation must recheck status,
primary identity and commit evidence at the point of removal; an earlier inspection
can become stale. Refuse dirty/untracked content. Refuse ignored content unless
`discardIgnored` is explicit, including `.env`. Unpublished or unknown publication
blocks removal unless the validated base contains all branch commits. Deleting a
local branch always requires base containment. `keepBranch` only skips branch
deletion; it bypasses no worktree preservation check. Squash/rebase or closed PR
metadata never proves ancestry. Refuse locks or stale/unknown filesystem state
when safety cannot be proven. There is no force, remote deletion, stash or process
killing seam. Return `CleanupResult` only after completed operations; partial
failures must explain retained/removed state through an actionable error.

Service promises reject on operational failures; errors must be actionable and
safe to print (no credentials, config dumps or secret subprocess output). Expected
lookup absence/ambiguity are values. `EditorResult.failed` describes a retained
workspace and retry instructions; command handlers must report launch failure
without deleting completed Git work. The parser writes handler errors once to
stderr and returns 1; handlers write human results through `context.io.stdout`.
No command may wait for interactive input in CI.

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
