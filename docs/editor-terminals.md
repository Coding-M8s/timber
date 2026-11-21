# Editor terminals

With an editor integration, Timber runs post-create setup and the optional
agent in two separate terminals of the editor window, both inside the exact
worktree. Two integrations exist: `integration = "orca"` uses the existing
local Orca window, and `integration = "vscode"` uses a VS Code window with the
Timber Terminals extension (see [VS Code](#vs-code)). The agent starts while
setup is still running unless the agent table sets `wait_for_setup = true`.
Timber returns once required setup has finished and the agent process has
actually started; the agent's lifetime belongs to the editor. Without an
integration, or with `--no-editor`, the earlier foreground behavior applies:
setup, then the generic editor launcher, then an agent in the invoking terminal.

Most of this page describes Orca; the VS Code section lists what differs. Both
integrations share the same lifecycle, private runner protocol, retries and
failure rules.

**Support note:** Orca terminals (`orca-ide`, Orca 1.4.224) are tested on Linux
x86_64. VS Code terminals are covered by automated tests with a simulated
extension host and one manual smoke on VS Code 1.146.0, Linux x86_64 (see
[observed behavior](#observed-on-vs-code-11460-linux-x86_64)); treat them as
experimental. Zed uses the generic editor launcher
(window open only); see [Zed](#zed).

macOS arm64 and x86_64 now have an experimental runner path. It reads native
process start time at microsecond precision through the system `libproc` library
using Bun's experimental FFI API; no Python or compiler is needed at runtime.
Native lookup failures stop handoff rather than accepting a PID-only identity.
This path requires macOS source/standalone verification and a real Orca desktop
smoke before it can be described as supported. The existing verification record
below establishes Linux support only. The CLI is available as
[macOS beta](releases.md#macos-beta) while desktop integration testing continues.

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

- `integration` (`"orca"` or `"vscode"`) is accepted on ordinary and workflow
  editor tables. Omitting it keeps the generic process launcher. Any other value
  is a strict config error.
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

1. Completes Git work (creation, saved base) as before.
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

With `integration = "vscode"`, the Timber Terminals extension opens the setup
and agent terminals in the VS Code window of the exact worktree. The extension
is in [`vscode-extension/`](../vscode-extension) and adds no commands, views,
settings or tasks; Timber never edits `settings.json` or `tasks.json` and never
sends keystrokes.

### Prerequisites

- Linux x86_64 (macOS follows the experimental runner path above). A local
  window only: Timber refuses editor args containing `--remote`, `--folder-uri`
  or `--file-uri`, and the extension ignores remote, container and virtual
  workspaces.
- The extension `coding-m8s.timber-terminals` 0.1.0 or newer is installed in
  the VS Code that `[editor].command` runs. Release archives do not include it
  yet; build and install it from a Timber checkout:

  ```bash
  bun install --frozen-lockfile
  bun run package:extension
  code --install-extension vscode-extension/timber-terminals-0.1.0.vsix
  ```

  Timber never installs the extension. The extension version is independent of
  the Timber version; this Timber accepts 0.1.0 or newer speaking request
  protocol 1.
- Workspace Trust. VS Code cannot start terminal processes in Restricted Mode,
  and a new worktree opens untrusted unless a parent folder is trusted. Trust
  the folder that holds your worktrees once: click Manage in the Restricted
  Mode banner, then Add Folder under Trusted Folders & Workspaces. The plain
  Trust button trusts only the current worktree. Every new worktree window
  in a trusted folder then starts trusted. The extension reports the window's trust in its
  answer, and Timber stops before creating any terminal when it is untrusted.
  The error names the folder to trust, and `timber setup` mentions this when
  you choose VS Code terminals.

### Configuration

```toml
[editor]
command = "code"
args = ["--new-window"]
enabled = true
integration = "vscode"
```

`timber setup` offers "VS Code terminals" as an editor preset with these
values. Without `integration`, `code` keeps the generic launcher: it opens the
window and setup and agents run in the invoking terminal.

### What differs from Orca

1. Timber runs `code <args> --list-extensions --show-versions` and stops if
   the extension is missing or older than 0.1.0.
2. Timber opens the worktree with `code <args> <worktree>`, then writes a
   private `hello` request to `/tmp/timber-vscode-<uid>/` (mode 0700, files
   0600, owned by you; anything else is refused on both sides). The window
   whose local workspace folder resolves to the worktree claims it with an
   atomic rename and answers with its version and a random window id. Timber
   waits up to 30 seconds.
3. Each terminal request is pinned to that window id, expires after 10
   seconds, and carries only the generated runner path and arguments from
   `/tmp/timber-launch-*`. The extension accepts nothing else and starts it with
   `createTerminal({ cwd, shellPath, shellArgs })`, so no shell parses any
   text. The acknowledgement names the terminal and its process id, for example
   `"Timber agent" (pid 12345)`.
4. VS Code closes a terminal when its process exits, so the runner opens your
   `$SHELL` (or `/bin/sh`) in the worktree after the task finishes. Type `exit`
   to close the terminal.
5. When no setup or agent is requested, Timber only opens the window.

### VS Code failures

The general [failure rules](#failures-and-recovery) apply. In addition:

| Situation | Behavior | Next step |
| --- | --- | --- |
| Extension missing or too old | No window opened, no terminal created | Install the extension, then run the printed retry |
| No answer from the worktree window within 30 s | Hello cancelled; no terminal created | Check that the window opened locally with the extension enabled, then run the printed retry |
| Terminal request not claimed within 10 s | Request cancelled; it can never run | Run the printed retry |
| Extension rejected the request (protocol, invalid, or the process did not start) | Reported definitively | Update Timber and the extension together, or run the printed retry |
| Request claimed but not acknowledged | Reported as uncertain; nothing replayed | Inspect the terminals in the worktree window before retrying |
| Worktree window is in Restricted Mode (untrusted) | Stopped at readiness, or the terminal request is rejected; no terminal created | Trust the folder that holds your worktrees (Manage, then Add Folder), then run the printed retry |
| Spool directory not private | Refused before any window opens | Remove `/tmp/timber-vscode-<uid>` and retry |

### Observed on VS Code 1.146.0, Linux x86_64

A manual smoke used an isolated `--user-data-dir` and `--extensions-dir` with
the extension installed from the VSIX.

- A fresh worktree window opened untrusted. The extension answered the hello,
  but VS Code never spawned the terminal process, so the request ended as a
  failed creation. Timber now detects Restricted Mode at readiness instead.
- With the window trusted (in that smoke, `--disable-workspace-trust` in the
  editor args), `timber new smoke-one --agent` printed
  `Agent handed off to VS Code terminal "Timber agent" (pid ...)`, and both the
  setup hook and the agent ran with `pwd` equal to the exact worktree path.

### Observed on VS Code 1.147.0, Linux x86_64

A second manual smoke used an isolated `--user-data-dir` and `--extensions-dir`
with the VSIX. VS Code 1.147 keeps Workspace Trust and recent folders in
`~/.vscode-shared`, shared by all profiles, so trusting a folder in a test
profile also trusts it in your normal VS Code.

- Untrusted: `timber new` stopped at readiness in about 4 seconds with the
  Restricted Mode error naming the worktrees folder; no terminal started.
- Trusting only the worktree (Trust button) made the printed retry work, but
  the next new worktree opened in Restricted Mode again.
- After adding the worktrees folder with Manage, then Add Folder, a brand-new
  worktree ran setup and the agent on the first try.
- Setup and agent terminals ran with `pwd` equal to the worktree and stayed
  open at a shell prompt afterwards.
- `wait_for_setup = true` with a failing hook: setup failure and retry
  printed, the agent never started, branch and worktree retained.
- With the spool directory deleted while a worktree window was open,
  `timber open --editor --agent` on that worktree still reached the same window.
- With the extension missing: the install hint and retry, before any window
  opened.
- The spool was mode 0700 and empty after every run.
