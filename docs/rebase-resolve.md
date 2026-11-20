# Resolve rebase conflicts with an assistant

`timber rebase --resolve` hands rebase conflicts to your configured coding
assistant. It only happens when you pass the flag. Plain `timber rebase` never
starts an assistant, even when `[agent] enabled = true`.

```sh
timber rebase my-feature --resolve
timber rebase my-feature --resolve --resolve-note "Prefer the base for lockfiles."
```

## Trust

The assistant runs in your terminal with your permissions. Timber tells it to
change only the conflicts and never to abort, reset, push or read secrets, but it
cannot enforce that. Watch the session and review the result.

## Set it up

Timber needs to know how to pass the task to your assistant. It never guesses this
from the program name. Run `timber setup` (or `timber setup --global`) and choose
the "Rebase --resolve" section, or edit the config:

```toml
[agent]
command = "claude"
resolve_handoff = "claude"   # codex, claude, cursor, or wrapper
resolve_instructions = "Run bun test before staging."   # optional
```

`codex`, `claude` and `cursor` receive a first prompt that points at a private
task file. A `wrapper` command runs unchanged and reads the file named by
`TIMBER_TASK_FILE`. `TIMBER_WORKTREE` and `TIMBER_BRANCH` are also set.
Older Timber releases reject these keys, so put them in machine defaults
(`timber setup --global`) when a repository's `.timber.toml` is shared.

## What happens

1. Without a paused rebase, Timber runs the usual rebase. No conflicts means no
   assistant. With a rebase already paused, `--resolve` attaches to it without
   fetching; `--base` is refused then.
2. Timber backs up the paused worktree, including ignored files such as `.env`.
   Staging and rebase state are not captured. If the backup fails, the assistant
   does not start.
3. The assistant resolves conflicts. It may run tests after you approve them,
   stage resolutions, and continue the rebase through later conflicts.
4. Timber re-reads Git and reports what changed. It warns about files or refs
   changed outside the conflicts.
5. If the rebase is still paused with everything staged, Timber asks whether to
   continue (default no). A later conflict stops with the usual guidance; rerun
   `timber rebase my-feature --resolve` to ask the assistant again.

The command exits 0 only when the rebase completed and the assistant exited
cleanly. `--resolve` needs an interactive terminal and refuses in CI.

## Recover

The rebase never aborts or resets on its own. Use `git rebase --continue` or
`git rebase --abort` in the worktree, as printed. The backup ID is printed before
the assistant starts; restore it into a new directory with
`timber backup restore <id> <new-directory>`. Review rewritten commits with the
printed `git range-diff` command.
