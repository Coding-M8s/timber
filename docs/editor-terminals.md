# Orca editor terminals

With `integration = "orca"`, Timber runs post-create setup and the optional
agent in two separate terminals of the existing local Orca window, both inside
the exact worktree. The agent starts while setup is still running unless the
agent table sets `wait_for_setup = true`. Timber returns once required setup
has finished and the agent process has actually started; the agent's lifetime
belongs to Orca. Without the integration, or with `--no-editor`, the earlier
foreground behavior applies: setup, then the generic editor launcher, then an
agent in the invoking terminal.

Supported and tested: Linux x86_64 with Orca 1.4.224. Zed terminals are not
supported; see [Zed](#zed) below.

## Prerequisites

- The Orca desktop app is running locally and reachable from its CLI. Timber
  never starts another window or runtime. `orca-ide status --json` must report
  a local target with `app.running` and `runtime.state = "ready"`.
- The repository is registered in Orca and shows worktrees that Timber creates
  with Git ("external" worktrees):

  ```bash
  orca-ide repo add --path /abs/primary-checkout --json
  orca-ide repo set --repo path:/abs/primary-checkout --external-worktree-visibility show --json
  ```

  Timber polls `worktree show --worktree path:<worktree>` for up to 15 seconds
  after creation while Orca indexes the new checkout, then pins the full
  `<repoId>::<path>` id for every terminal call.
- Orca allows CLI terminal control. Permission errors are reported as such and
  are never retried.
- Local routing only. Timber refuses to continue when `ORCA_ENVIRONMENT` or
  `ORCA_PAIRING_CODE` is set or the editor args contain `--environment` or
  `--pairing-code`.
- `[editor].command` names the installed Orca CLI (`orca-ide` on PATH or an
  absolute path). `args` stays a literal argument array.

## Configuration

```toml
[editor]
command = "orca-ide"
args = []
enabled = true
integration = "orca"

[agent]
command = "claude"
args = []
enabled = true
wait_for_setup = false

[hooks]
post_create = ["bun install --frozen-lockfile"]

[workflows.review]
post_create = ["printf review > marker"]

[workflows.review.agent]
command = "codex"
args = ["review this branch"]
wait_for_setup = true
```

- `integration` is accepted on ordinary and workflow editor tables. Omitting it
  keeps the generic process launcher. Any other value is a strict config error.
- `wait_for_setup` is accepted on ordinary and workflow agent tables and
  defaults to false. Tables replace whole lower-scope tables: a workflow agent
  table that omits it defaults independently, while an omitted workflow agent
  inherits the entire ordinary table.
- `timber setup` keeps `wait_for_setup` when you reselect an assistant and keeps
  `integration` when you keep the current editor. Choosing another editor drops
  the integration, because it belongs to the Orca command.
- `--editor`, `--no-editor`, `--agent`, `--no-agent`, `--setup`, `--workflow`
  and the CI/TTY restrictions apply before any Git or Orca mutation exactly as
  in foreground mode. Explicit `--agent` still requires an interactive terminal.

## What Timber does

1. Completes Git work (creation, workflow association) as before.
2. Checks Orca status and worktree readiness. Only `selector_not_found` is
   retried, under one 15 second deadline. Command, permission, malformed and
   runtime failures stop before any terminal exists.
3. Writes a private request directory `/tmp/timber-launch-<random>` (mode 0700,
   file 0600) holding the literal command, arguments, unchanged hook sources and
   Timber context as JSON, plus symlinks to the running Timber executable. The
   terminal command Orca receives contains only those generated paths; user
   values never appear in shell text.
4. Creates the setup terminal (title `Timber setup`) when creation or `--setup`
   selected setup and any ordinary or workflow hook exists. The built-in runner
   claims the request, sets `TIMBER_REPO`, `TIMBER_WORKTREE`, `TIMBER_BRANCH`,
   `TIMBER_TASK_ID` and `TIMBER_WORKFLOW`, clears inherited values, and runs
   ordinary then workflow hooks sequentially through `/bin/sh -c` in the
   worktree. It stops at the first failure and records the step and phase.
5. Creates the agent terminal (title `Timber agent`) when an agent is enabled:
   immediately in parallel mode, or after setup succeeded with
   `wait_for_setup = true`. The runner spawns the executable with literal
   arguments, reports the actual spawn, and forwards only process-directed
   termination. The terminal keeps Orca's own identity for that worktree; the
   invoking terminal's `ORCA_*` identity is not transferred.
6. Waits for the setup result and the agent start acknowledgement, removes the
   consumed request data, and prints `Agent handed off to Orca terminal
   term_...`. Timber does not wait for the agent to exit.

Terminals are created in the background and then revealed with
`terminal switch`, so the runner starts even before the window shows the new
worktree. Existing-worktree `open` with an enabled editor never reruns setup or
starts an implicit agent; without `--setup` or `--agent` it only switches the
window to a connected terminal of that worktree, creating a plain shell
terminal when none exists. `open --agent` starts only the agent, even with
`wait_for_setup = true`. Hook and agent output stays in their terminals, which
remain open at a shell prompt after the command exits.

## Failures and recovery

Every failure after creation keeps the worktree, refs and files. Timber exits
nonzero when required setup fails or a handoff fails, and never falls back to
the invoking terminal or kills an agent.

| Situation | Behavior | Next step |
| --- | --- | --- |
| Readiness or permission failure | No terminal created | Fix Orca state, rerun the same command or `timber open --editor -- '<path>'` |
| Setup step fails | Dependent agent suppressed; a parallel agent keeps running | `timber open --editor --setup --no-agent -- '<path>'` reruns all steps |
| Agent executable cannot start | Setup still awaited | `timber open --editor --agent -- '<path>'` |
| Runner never claimed the request within 10 s | Request fenced so a late terminal cannot run it | Retry with the printed command |
| Create response lost after the runner may have started | Reported as uncertain; nothing replayed | Inspect the named terminal before retrying |
| Runner exited without a result while its shell lives on | Reported as uncertain; request data retained | Inspect the setup terminal and its processes |

Retry commands are rendered safely, including paths with control characters.
A late runner started from a fenced request fails with a private-data error and
runs nothing. Orca may replace the Timber tab title with the shell's own title
once the command starts; use the printed handle to find the terminal.

## Observed Orca 1.4.224 behavior

- `terminal create --focus` targeting a worktree the window has not displayed
  yet returns `runtime_error: Timed out waiting for terminal handle after
  creation` after about 10 seconds and attaches no PTY until the worktree is
  first shown, at which point the queued command runs. Timber therefore creates
  terminals without `--focus` (PTY attached in well under a second) and reveals
  them afterwards with `terminal switch`, which also navigates to a worktree the
  window has never shown. A failed reveal does not fail the handoff.
- `worktree show --worktree path:<new checkout>` reports `selector_not_found`
  for a short time after `git worktree add`; Timber's bounded readiness loop
  absorbs this.
- Terminal commands run inside the user's login shell, so the tab stays open
  after the runner exits.

## Verification record (2026-10-16)

Toolchain: Bun 1.4.2 (the package pin; the default Bun on this machine was
1.4.3, which `build:release` and the release integration test reject, so the
pinned binary was first on PATH), Git 2.55.0, Orca app and CLI 1.4.224, Linux
x86_64.

| Command | Result |
| --- | --- |
| `bun run typecheck` | passed |
| `bun test` | 754 pass, 0 fail, 5094 expect() calls, 64 files, 73.84 s |
| `bun run build` then `bun dist/index.js --help` | `dist/index.js` 0.77 MB; usage printed |
| `bun run build:release` and `sha256sum -c SHA256SUMS` | `timber-v0.1.0-dev.0-linux-x64`, both sums OK |
| `bun test tests/editor-terminal-compiled.test.ts` | compiled CLI drives a stub Orca with `PATH=/usr/bin:/bin`; passes within the suite |

Manual smoke used a disposable repository registered with `repo add` and
external visibility `show`, an ordinary hook `sleep 5; date +%s.%N >
setup-marker`, workflow hooks, and an agent script that prints its cwd and
Timber/Orca environment, writes a timestamp, then waits on stdin. Timber ran
from source under a pseudo-terminal, except for the standalone row.

| Scenario | Command | Observed |
| --- | --- | --- |
| Parallel (default) | `timber new parallel-smoke --workflow review` | exit 0 in 7.6 s; agent timestamp 4.65 s before setup completion; two connected local terminals owned by the exact worktree id; agent cwd is the worktree, `TIMBER_WORKFLOW=review`, `ORCA_WORKTREE_ID` is the target worktree |
| Dependent | same with `wait_for_setup = true` | exit 0 in 6.0 s; agent timestamp 0.36 s after setup completion |
| Setup failure | `timber new broken-smoke --workflow broken` (step 2 exits 7) | exit 1 in 6.0 s with `Setup workflow post_create step 2 failed (exit code 7)` and the retry command; step 3 never ran; branch ref intact; parallel agent terminal still running |
| Definitive retry | printed `timber open --editor --setup --no-agent -- '<path>'` after fixing the hook | exit 0 in 5.7 s; all steps reran in a new setup terminal; no agent terminal |
| Existing open | `timber open parallel-smoke` | exit 0 in 0.5 s; no setup rerun, no new terminal, window switched to the worktree's terminal |
| Agent-only open | `timber open dependent-smoke --agent` | exit 0 in 0.7 s; one new agent terminal; setup marker untouched |
| Foreground | `timber new foreground-smoke --no-editor` | exit 0 in 5.2 s; setup and agent ran in the invoking terminal; no Orca terminals |
| Standalone | compiled binary, `PATH=/usr/bin:/bin`, `new standalone-smoke --workflow review` | exit 0 in 6.3 s; bootstrap `…/runtime __editor-task …` without Bun or source files; agent and markers as in the parallel row |

Before the `--focus` change, the first parallel attempt failed after 11.6 s with
`Orca terminal handoff is uncertain`; its tab attached only when the window
first showed the worktree and then executed the bootstrap, which failed with
`No such file or directory` because Timber had fenced and removed the request.
All smoke terminals, worktrees and the project registration were removed
afterwards.

## Zed

Zed 1.18.1 (`zeditor --help`, https://zed.dev/docs/reference/cli) opens
workspaces (`zed <path>`, `--new`, `--add`, `--wait`) but exposes no external
way to run a given command in a workspace terminal or to observe its
completion. https://zed.dev/docs/tasks describes tasks spawned interactively
from the UI through task files. Timber continues to open Zed through the
generic editor launcher and does not modify user settings or task files.

A separate ticket should add Zed terminals only once these are met:

1. A demonstrated external route (CLI, IPC or extension) that runs a literal
   argv in a Zed terminal inside the exact worktree without editing the user's
   settings or task files, and that reports process startup and setup
   completion.
2. The same coordinator contract as Orca: separate setup and agent terminals,
   parallel default, `wait_for_setup`, no foreground fallback, bounded
   readiness, and uncertain-handoff diagnostics without replay.
3. Real-process tests plus a recorded manual smoke on Linux x86_64 in this
   document.
4. `integration = "zed"` accepted by strict validation only in that change.
