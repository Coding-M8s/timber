# Orca editor terminals

With `integration = "orca"`, Timber runs post-create setup and the optional
agent in two separate terminals of the existing local Orca window, both inside
the exact worktree. The agent starts while setup is still running unless the
agent table sets `wait_for_setup = true`. Timber returns once required setup
has finished and the agent process has actually started; the agent's lifetime
belongs to Orca. Without the integration, or with `--no-editor`, the earlier
foreground behavior applies: setup, then the generic editor launcher, then an
agent in the invoking terminal.

**Support note:** Editor-owned setup and agent terminals currently support only
`orca-ide` (Orca 1.4.224, tested on Linux x86_64). Zed and VS Code (`code`) use
the generic editor launcher (window open only). In-panel setup and agent
terminals for those editors are not claimed; see [Zed](#zed) and
[VS Code](#vs-code) below.

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
- `timber setup` offers "Orca terminals" as an editor preset (`orca-ide`,
  `integration = "orca"`) and, whenever the effective editor is Orca, asks whether
  the assistant waits for setup, including for a kept assistant table and for an
  Orca editor or assistant inherited from machine defaults. Keeping the inherited
  dependency preference preserves inheritance; changing it saves a complete
  repository agent table with the inherited command, arguments and enablement.
  Reselecting an assistant keeps an
  existing `wait_for_setup`; choosing another editor drops the integration,
  because it belongs to the Orca command. The review summary shows
  "(Orca terminals)" and "waits for setup".
- `--editor`, `--no-editor`, `--agent`, `--no-agent`, `--setup` and `--workflow`
  apply before any Git or Orca mutation. With the enabled, selected Orca
  integration, explicit and config-driven initial agents can launch even when
  the invoking process is noninteractive or CI is on; Orca owns their terminal.
  Generic editors, disabled Orca integration and `--no-editor` retain foreground
  requirements: interactive stdin/stdout and CI off. Explicit `--agent` otherwise
  fails before creation; config-driven launch skips.

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
| Status, readiness or permission failure | No terminal created | Fix Orca state, then run the printed retry; it repeats everything requested, e.g. `timber open --editor --setup --agent -- '<path>'` after a failed `new` |
| Terminal creation refused before the runner claimed its request | Request fenced and removed | Run the printed retry for that step; a setup retry includes `--agent` when the agent never started |
| Setup step fails | Dependent agent suppressed; a parallel agent keeps running | `timber open --editor --setup --no-agent -- '<path>'` reruns all steps |
| Agent executable cannot start | Setup still awaited | `timber open --editor --agent -- '<path>'` |
| Runner never claimed the request within 10 s | Request fenced so a late terminal cannot run it | Retry with the printed command |
| Create response lost after the runner may have started | Reported as uncertain; nothing replayed | Inspect the named terminal before retrying |
| Terminal created but window selection fails | Reported as failure with the retained terminal handle; running setup is still awaited; no terminal recreated | Inspect/select that existing terminal; do not relaunch a running agent |
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
  window has never shown. A failed reveal returns nonzero with the retained
  terminal handle. Timber observes its runner and any required setup without
  fencing or recreating the terminal; a setup-terminal selection failure blocks
  the initial agent, and an agent already started remains running.
- `worktree show --worktree path:<new checkout>` reports `selector_not_found`
  for a short time after `git worktree add`; Timber's bounded readiness loop
  absorbs this.
- Terminal commands run inside the user's login shell, so the tab stays open
  after the runner exits.

## Zed

Zed uses the generic editor launcher. Setup and agents run in the invoking terminal.
In-panel terminals are tracked in [#60](https://github.com/Coding-M8s/timber/issues/60).

## VS Code

VS Code uses the generic editor launcher with `command = "code"` and, typically,
`args = ["--new-window"]`. Setup and agents run in the invoking terminal.
In-panel terminals require a separate bridge, tracked in
[#75](https://github.com/Coding-M8s/timber/issues/75). Only `integration = "orca"`
is currently accepted; Timber does not edit editor settings or task files.
