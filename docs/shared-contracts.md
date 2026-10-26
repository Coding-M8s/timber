# Code map and shared contracts

The [CLI contract](cli-contract.md) defines behavior. TypeScript declarations live
in source; update them and their consumers together when a shared interface changes.

| Module | Responsibility |
| --- | --- |
| [index.ts](../src/index.ts) | Process I/O and concrete service wiring |
| [cli.ts](../src/cli.ts) | Commander definitions, dispatch, and exit status |
| [types.ts](../src/types.ts) | Repository, worktree, configuration, and operation results |
| [services.ts](../src/services.ts) | Injected command services, handlers, and context |
| [commands](../src/commands) | Command orchestration through narrow service interfaces |
| [git](../src/git) | Discovery, refs, worktree identity, creation, rebase, and cleanup |
| [config.ts](../src/config.ts) | Strict global/repository configuration and precedence |
| [setup](../src/setup) | Interactive drafts and private, atomic configuration saves |
| [jira](../src/jira) | Ticket lookup and private credential storage |
| [hooks.ts](../src/hooks.ts) | Trusted shell hooks and context environment |
| [editor.ts](../src/editor.ts), [agent.ts](../src/agent.ts) | Separate editor and foreground agent launching |
| [editor-terminals](../src/editor-terminals) | Orca terminal handoff and private runner protocol |
| [arena](../src/arena) | Attempt selection, planning, records, and recovery |
| [completion](../src/completion) | Read-only candidate lookup and shell adapters |

## Boundaries

`runCli(argv, { context, handlers })` accepts arguments without executable/script
prefixes and returns a numeric status without exiting. `context.cwd` starts discovery;
Git services then use the discovered repository and executable/argument arrays.
Command modules receive only the services they need. Production wiring stays in
`index.ts`; tests inject functions directly.

Paths in domain models are absolute. `commonGitDir` identifies the repository;
current and primary worktree roots can differ. Keep unknown, ambiguous, detached,
and missing states explicit. A selected worktree or previous inspection never
replaces fresh identity and preservation checks before mutation.

Configuration scopes are validated independently. Optional tables replace whole
lower-scope tables; workflows and Arena presets merge by name. Keep commands and
arguments together. Secrets belong in the private credential store or environment.

Choosers return an offered stable value or `null`. Validate selections and keep
cancellation mutation-free. Agent launch eligibility and chooser eligibility are
computed separately; use the existing helpers rather than duplicating CI rules.

Foreground agents own the invoking terminal until exit. Orca handoff observes
startup and required setup, leaving agent lifetime to Orca. Arena uses sequential
foreground agents. See [launch behavior](cli-contract.md#interactive-agent-launching-02)
and [Orca recovery](editor-terminals.md#failures-and-recovery).

The private runner's process identity keeps Linux kernel start ticks unchanged.
The experimental macOS arm64/x86_64 path reads `proc_pidinfo` through Bun FFI and
preserves kernel start seconds/microseconds, refusing missing, truncated, mismatched,
or zombie records. PID-only and whole-second fallbacks are not accepted. Native
macOS and desktop smoke remain required before claiming support; see
[experimental candidates](releases.md#experimental-macos-candidates).

Saved bases and workflows belong to private Git-admin metadata. Arena adds
versioned manifests, task digests, reciprocal worktree UUIDs, and invocation locks.
Preserve existing record versions and exact recorded configuration during recovery;
never reinterpret a previous run through a current model catalog. Metadata membership
is not permission to delete work. See [saved bases](cli-contract.md#saved-worktree-bases-79),
[Arena creation](cli-contract.md#arena-creation-post-10-tim-20), and
[resume](cli-contract.md#arena-resume-tim-21).

## Tests

[createServiceDouble](../tests/helpers/services.ts) rejects unspecified calls, so a
command test cannot accidentally report a successful Git operation. Fixtures are
fresh per call. Use these at command boundaries and temporary real repositories
from [helpers/git.ts](../tests/helpers/git.ts) for Git mutations. Failure tests
must assert files and refs remain intact.

Run `bun run typecheck`, `bun test`, and `bun run build` after shared changes.
Release checks are in [releases.md](releases.md).
